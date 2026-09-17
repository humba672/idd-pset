#!/usr/bin/env python3
"""D-4: draft an index.json by scanning both PDFs for problem-number patterns.

This tool is run locally and is never part of the deployed site (C1, D-4). Its output is
a *draft*: review it, fix what the regex got wrong, and commit the corrected file as
index.json. The app never builds an index itself.

The draft contains locations only - page indices and boxes - never book text (C2, D-3).

Coordinates
-----------
PyMuPDF measures from the top-left of the page with y growing downward. index.json (D-3)
stores PDF user space: origin bottom-left, y growing upward, in points. The flip happens
here, once, in `flip_rect`, so the app can hand a bbox straight to pdf.js.

Finding the problems
--------------------
Books number exercises in one of two ways, and `--section-from` says which to expect:

  heading       The book opens each exercise set with a heading ("Exercises 12.3") set in
                larger type than the body. Only the pages between that heading and the
                next large heading are scanned, so prose cannot invent problems. This is
                how the textbook is laid out.

  running-head  Every page names its section in the running head ("Section 12.3
                Functions of Several Variables") and the whole page is solutions. This is
                how the solutions manual is laid out.

  none          No sections: the chapter comes from "Chapter N" lines or --chapter, and
                keys are two-part (`3.14`) as in the original D-5.

Usage
-----
    python tools/build_index.py \
        --textbook book.pdf --section-from heading \
        --solutions manual.pdf --solution-section-from running-head \
        --book "Thomas' Calculus: Early Transcendentals, 13th ed" \
        -o index.draft.json

    python tools/build_index.py --merge index.json index.overrides.json -o index.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

# --- problem-number recognition (D-5 keys, unit-tested in test_build_index.py) ---------

PATTERNS: dict[str, str] = {
    # 14.  14)  14a)  and a line that is just "14." -- the manual does that constantly.
    "bare": r"^(?P<number>\d{1,3})(?P<suffix>[a-z])?\s*[.):](?:\s|$)",
    # 3.14  3.14a  3.14)  3.14.
    "chapter-dot": r"^(?P<chapter>\d{1,2})\.(?P<number>\d{1,3})(?P<suffix>[a-z])?\s*[.):\s]",
}

CHAPTER_HEADING = re.compile(r"^\s*(?:chapter|ch\.?|unit)\s+(\d{1,2})\b", re.IGNORECASE)

# "Exercises 12.3" opening an exercise set, in larger type than the body text.
EXERCISE_HEADING = re.compile(r"^\s*exercises?\s+(\d{1,2})\.(\d{1,2})\b", re.IGNORECASE)
# "12.3  Functions of Several Variables" opening a new section, in display type.
SECTION_TITLE = re.compile(r"^\s*\d{1,2}\.\d{1,2}\s+\S")
# The chapter-level sets that follow the last section of a chapter.
CHAPTER_SET = re.compile(
    r"^\s*(?:practice\s+exercises|additional\s+and\s+advanced\s+exercises"
    r"|questions\s+to\s+guide|chapter\s+\d{1,2}\s*$)", re.IGNORECASE
)
# "Section 12.3 ..." or "12.3 Functions of ..." in a running head.
SECTION_HEAD = re.compile(r"(?:section\s+)?\b(\d{1,2})\.(\d{1,2})\b(?=\s+[A-Za-z])", re.IGNORECASE)

# "Find the angles between the vectors in Exercises 9-12 ..." - one instruction standing
# for a run of problems that print only their data underneath.
INSTRUCTION_RANGE = re.compile(
    r"exercises?\s+(?P<low>\d{1,3})\s*(?P<sep>[–—-]|and|&|,)\s*(?P<high>\d{1,3})",
    re.IGNORECASE,
)


def join_wrapped(first: str, second: str) -> str:
    """Undo a line break, whether or not it fell inside a word.

    An instruction wraps wherever the measure runs out: "...the points in Exer-" /
    "cises 13-20", and "...the planes in Exercises" / "57-60 intersect." Both hide the
    range from a pattern that only ever sees one line at a time.
    """
    head = first.rstrip()
    if head.endswith("-"):
        return head[:-1] + second.lstrip()
    return head + " " + second.lstrip()


def instruction_span(text: str) -> tuple[int, int] | None:
    """The run of exercises an instruction introduces, or None.

    "In Exercises 37-40" is a range. "In Exercises 25 and 26" is the same thing said
    differently, and the book uses both. A list ("Exercises 1, 3, and 5") is not a range,
    so anything joined by a word or a comma has to be consecutive to count.
    """
    m = INSTRUCTION_RANGE.search(text)
    if not m:
        return None
    low, high = int(m.group("low")), int(m.group("high"))
    dashed = re.fullmatch(r"[–—-]", m.group("sep")) is not None
    if not dashed and high - low != 1:
        return None
    if not (1 <= low < high <= MAX_NUMBER and high - low <= 60):
        return None
    return low, high

# "a.", "b.", "c)" - a labelled part of the problem above, never the start of what
# follows. Vertical distance alone cannot tell the two apart: the gaps inside a list of
# parts set in tall maths are wider than the gap to the next problem.
SUBPART_LABEL = re.compile(r"^\s*[a-z][.)]\s")

# A line that opens with a number is not always a problem: "0.5 mol of ...", "3.14159",
# page headers and figure captions all look similar. These guards cut the obvious ones.
FALSE_START = re.compile(
    r"^\s*(?:figure|fig\.?|table|example|eq\.?|equation|section|page|chapter)\b",
    re.IGNORECASE,
)

# Points of breathing room under a problem's last line, for maths that paints
# outside the box PyMuPDF reports.
CONTENT_MARGIN = 3
# The same, above its first line, where radicals and fractions overhang.
ASCENDER_MARGIN = 4

MAX_CHAPTER = 99
MAX_NUMBER = 999

# How far the numbering may jump forward and still be the same run of exercises.
MAX_FORWARD_GAP = 10
# A section boundary shows up as numbering restarting at or below this...
RESTART_CEILING = 3
# ...but only once the section that is ending has run at least this far.
MIN_SECTION_LENGTH = 8
# Problem starts within this many points of each other are one row of a grid.
ROW_TOLERANCE = 6
# Inside such a row, a gap wider than this ends the problem.
PACKED_LINE_GAP = 5
# Points kept clear of the neighbouring problem, covering the breathing room the app
# adds when it draws the region.
NEIGHBOUR_CLEARANCE = 3
# A run-on shorter than this is stray artwork, not the rest of a problem.
MIN_CONTINUATION = 8
# How near a problem must start to a detected margin for it to count as a column.
COLUMN_HIT_TOLERANCE = 14
# How many problems must start there before it counts as a column of its own.
COLUMN_MIN_PROBLEMS = 2
# Everything below this fraction of the page is the footer, not the solution above it.
FOOT_FRACTION = 0.88
# How many pages ahead to look for the section a restart belongs to.
SECTION_LOOKAHEAD = 2
# The widest gap across which a line is still taken to belong to the problem below it.
MAX_ADOPT_GAP = 8
# How far above its label a block of maths may start and still be part of it.
STRADDLE_REACH = 24
# No exercise set runs longer than this; past it we are reading something else.
MAX_WINDOW_PAGES = 12


def normalize_key(*parts: str | int, suffix: str = "") -> str:
    """D-5 canonical key: a dotted path plus an optional lowercase letter.

    Two parts for a book numbered per chapter (`3.14`), three for one numbered per
    section (`12.3.7`), which is how Thomas' Calculus is organized.
    """
    return ".".join(str(int(p)) for p in parts) + (suffix or "").lower()


def compile_pattern(kind: str, custom: str | None = None) -> re.Pattern[str]:
    if custom:
        return re.compile(custom)
    try:
        return re.compile(PATTERNS[kind])
    except KeyError:
        raise SystemExit(f"unknown --pattern {kind!r}; choose from {', '.join(PATTERNS)} or --regex")


def match_problem(
    line: str,
    pattern: re.Pattern[str],
    chapter: str | int | None = None,
    section: str | int | None = None,
) -> str | None:
    """Returns the canonical key a line starts with, or None.

    `chapter` and `section` supply context for patterns that capture only a problem
    number; a line carrying its own chapter overrides the context.
    """
    text = line.strip()
    if not text or FALSE_START.match(text):
        return None
    m = pattern.match(text)
    if not m:
        return None
    groups = m.groupdict()
    number = groups.get("number")
    if number is None:
        return None
    found_chapter = groups.get("chapter") or chapter
    if found_chapter is None:
        return None
    try:
        chapter_i, number_i = int(found_chapter), int(number)
    except (TypeError, ValueError):
        return None
    if not (1 <= chapter_i <= MAX_CHAPTER and 1 <= number_i <= MAX_NUMBER):
        return None
    # "3.14159..." is a constant, not problem 14 of chapter 3. Look at the character
    # just past the number (and its suffix), not past the whole match, so a custom
    # pattern that stops at a word boundary is judged the same way.
    end = m.end("suffix") if groups.get("suffix") else m.end("number")
    if text[end : end + 1].isdigit():
        return None

    suffix = groups.get("suffix") or ""
    found_section = groups.get("section") or section
    if found_section is not None:
        return normalize_key(chapter_i, found_section, number_i, suffix=suffix)
    return normalize_key(chapter_i, number_i, suffix=suffix)


def flip_rect(rect: Sequence[float], page_height: float, pad: float = 0.0) -> list[float]:
    """PyMuPDF top-left rect -> PDF user space [x0, y0, x1, y1] with origin bottom-left.

    No padding by default: the box says exactly what it covers, and the app adds the
    couple of points of breathing room it needs when it draws (D-7). Padding at both ends
    used to stack up and spill the box into the problems either side of it.
    """
    x0, y0, x1, y1 = (float(v) for v in rect)
    return [
        round(x0 - pad, 2),
        round(page_height - y1 - pad, 2),
        round(x1 + pad, 2),
        round(page_height - y0 + pad, 2),
    ]


def sort_key(key: str) -> tuple:
    """Orders keys of either depth: 2.1.9 before 12.3.2 before 12.3.2a before 12.10.1."""
    m = re.fullmatch(r"(\d+(?:\.\d+)*)([a-z]*)", key)
    if not m:
        return (10**6,)
    return tuple(int(p) for p in m.group(1).split(".")) + (m.group(2),)


# --- reading pages --------------------------------------------------------------------


@dataclass
class Line:
    """One text line in PyMuPDF coordinates, with the largest type size on it."""

    text: str
    rect: list[float]
    size: float


@dataclass
class Hit:
    """One problem start found on a page."""

    key: str
    rect: list[float]
    column: int = 0


@dataclass
class ScanReport:
    pages: int = 0
    hits: int = 0
    sections: set[str] = field(default_factory=set)
    keys: set[str] = field(default_factory=set)
    duplicates: list[str] = field(default_factory=list)
    unsectioned_pages: int = 0
    repaired: int = 0
    dropped: int = 0
    instructions: int = 0
    continuations: int = 0

    def note(self) -> str:
        return (
            f"{self.hits} problem starts over {self.pages} pages, "
            f"{len(self.keys)} distinct keys in {len(self.sections)} sections "
            f"({self.repaired} recovered by repair, {self.instructions} given a shared "
            f"instruction, {self.continuations} continued across a column, "
            f"{self.dropped} stray numbers dropped, "
            f"{len(self.duplicates)} duplicates)"
        )


def page_lines(page) -> list[Line]:
    out: list[Line] = []
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            spans = line.get("spans", [])
            text = "".join(s.get("text", "") for s in spans)
            if text.strip():
                out.append(
                    Line(
                        text=text,
                        rect=list(line["bbox"]),
                        size=max((s.get("size", 0) for s in spans), default=0),
                    )
                )
    return out


def page_shapes(page) -> list[list[float]]:
    """Figures, in PyMuPDF coordinates.

    A problem's box has to cover its figure, and a figure is not text: the manual embeds
    them as images and the textbook draws them as vector paths, so neither shows up in
    the line list. Anything approaching the size of the page is ignored - that is a rule,
    a border or a background wash, not a figure.
    """
    limit_w = page.rect.width * 0.9
    limit_h = page.rect.height * 0.6
    out: list[list[float]] = []

    for image in page.get_images(full=True):
        try:
            rects = page.get_image_rects(image[0])
        except Exception:  # pragma: no cover - malformed image entry
            continue
        for r in rects:
            if r.width <= limit_w and r.height <= limit_h and r.width > 1 and r.height > 1:
                out.append([r.x0, r.y0, r.x1, r.y1])

    for drawing in page.get_drawings():
        r = drawing["rect"]
        if r.width <= limit_w and r.height <= limit_h and r.width > 1 and r.height > 1:
            out.append([r.x0, r.y0, r.x1, r.y1])
    return out


def parse_page_range(spec: str | None, total: int) -> range:
    """`--pages 10-40` in 0-based PDF page indices (D-3)."""
    if not spec:
        return range(total)
    m = re.fullmatch(r"\s*(\d+)\s*-\s*(\d+)\s*", spec)
    if m:
        start, end = int(m.group(1)), int(m.group(2))
    elif spec.strip().isdigit():
        start = end = int(spec.strip())
    else:
        raise SystemExit(f"--pages wants N or N-M, got {spec!r}")
    return range(max(0, start), min(total, end + 1))


# --- finding problem starts -----------------------------------------------------------
#
# Two passes, because precision and recall pull in opposite directions here:
#
#   1. The strict pass accepts a problem number only where a column begins. Without it,
#      every "(x + 1)" whose trailing fragment PyMuPDF reports as its own line looks like
#      problem 1 -- in the manual that produced more false starts than real ones.
#   2. The repair pass fills the gaps. Exercises are numbered consecutively, so a missing
#      number is a specific thing to hunt for: if exactly one line in the section begins
#      with it, that is the problem, wherever it sits. This recovers second columns that
#      are not split down the middle of the page.


def attach(
    regions: dict[str, list[dict]], report: "ScanReport", extra: list[tuple[str, dict]]
) -> None:
    """Add a region to a problem already recorded - the rest of it, carried over from the
    previous column. Deliberately not counted as another sighting of the key: it is one
    problem in two pieces (D-3), not the same problem found twice."""
    for key, region in extra:
        if key in regions:
            regions[key].append(region)
            report.continuations += 1


def record(
    regions: dict[str, list[dict]], report: "ScanReport", found: list[tuple[str, dict]]
) -> None:
    for key, region in found:
        regions.setdefault(key, []).append(region)
        report.hits += 1
        if key in report.keys:
            report.duplicates.append(key)
        report.keys.add(key)


@dataclass
class PageScan:
    """One page of a section, with the problem starts found on it."""

    index: int
    page: object
    lines: list[Line]
    bottom_limit: float
    hits: dict[int, Line] = field(default_factory=dict)
    shapes: list[list[float]] = field(default_factory=list)


def column_margins(
    lines: list[Line], page_width: float, min_gap: float = 80.0, min_support: int = 4
) -> list[float]:
    """Where the page's columns begin.

    The page's columns, not the grids set inside them: an instruction spans its column,
    and a problem's box reaches across to the next column, so a run of short answers set
    three across must not be mistaken for the page turning into three columns. The left
    margin is the leftmost line; a second column is the leftmost well-supported cluster
    in the right-hand part of the page - leftmost, not busiest, because indented
    sub-parts outnumber the lines at the column's own margin.
    """
    if not lines:
        return [0.0]
    left = min(ln.rect[0] for ln in lines)
    right_half = [ln.rect[0] for ln in lines if ln.rect[0] >= page_width * 0.45]
    if right_half:
        buckets = Counter(round(x / 2) * 2 for x in right_half)
        for candidate in sorted(buckets):
            if buckets[candidate] >= min_support and candidate > left + min_gap:
                return [left, float(candidate)]
    return [left]


def number_margins(lines: list[Line], min_support: int = 3, merge: float = 12.0) -> list[float]:
    """Where numbered lines line up.

    A page can be laid out differently in different bands - dense working above, a grid
    of short answers below - so the page's columns say little about where the answers in
    that grid begin. What the numbers themselves agree on says it directly: three or more
    starting at the same x is a column of problems, while fragments of maths that happen
    to open with a digit agree with nothing.
    """
    xs = [
        ln.rect[0]
        for ln in lines
        if PLAIN_NUMBER.match(ln.text.strip()) and not FALSE_START.match(ln.text.strip())
    ]
    if not xs:
        return []
    buckets = Counter(round(x / 2) * 2 for x in xs)
    margins: list[float] = []
    for candidate in sorted(x for x, count in buckets.items() if count >= min_support):
        if margins and candidate - margins[-1] <= merge:
            continue
        margins.append(float(candidate))
    return margins


def start_margins(lines: list[Line], page_width: float) -> list[float]:
    """Every place a problem could begin on this page: the page's own columns, plus
    wherever numbered lines agree among themselves."""
    return sorted(set(column_margins(lines, page_width)) | set(number_margins(lines)))


def strict_pass(
    scan: PageScan,
    pattern: re.Pattern[str],
    chapter: int | None,
    section: str | None,
    margin_tol: float,
) -> None:
    if not scan.lines:
        return
    margins = start_margins(scan.lines, scan.page.rect.width)
    for ln in scan.lines:
        if not any(m - 2 <= ln.rect[0] <= m + margin_tol for m in margins):
            continue
        key = match_problem(ln.text, pattern, chapter, section)
        if key:
            number = int(re.sub(r"[a-z]+$", "", key.split(".")[-1]))
            scan.hits.setdefault(number, ln)


def repair_pass(scans: list[PageScan]) -> int:
    found = {n for scan in scans for n in scan.hits}
    if len(found) < 3:
        return 0
    repaired = 0
    # From 1, not from the lowest number found: an exercise set often opens with a block
    # of short items set in narrow columns, which the strict pass does not see at all.
    for number in range(1, max(found) + 1):
        if number in found:
            continue
        wanted = re.compile(rf"^\s*{number}\s*[.)](?:\s|$)")
        candidates: list[tuple[PageScan, Line]] = []
        for scan in scans:
            for ln in scan.lines:
                text = ln.text.strip()
                if not FALSE_START.match(text) and wanted.match(text):
                    candidates.append((scan, ln))
        # Only an unambiguous candidate is trustworthy. Anything else is left to the D-8
        # fallback in the app, or to the hand-correction pass (D-4).
        if len(candidates) == 1:
            scan, line = candidates[0]
            scan.hits[number] = line
            repaired += 1
    return repaired


def continuation(
    scan: "PageScan",
    first_top: float,
    column_lines: list[list[float]],
    left: float,
    right_bound: float,
) -> dict | None:
    """The run-on from the previous column, if this one opens with any.

    Stops short of a shared instruction: that introduces the problems below it and is
    captured separately, so it is not part of what came before.
    """
    # `first_top` is where the first problem's box begins, which for a cross product is
    # the "i j k" row above its own line. Reading the run-on up to the problem's line
    # instead would hand that row to the problem on the previous page.
    ceiling = first_top - NEIGHBOUR_CLEARANCE
    lead = [rect for rect in column_lines if rect[3] <= ceiling]
    if not lead:
        return None
    instruction_tops = [
        ln.rect[1]
        for ln in scan.lines
        if left - 8 <= ln.rect[0] < right_bound
        and ln.rect[3] <= ceiling
        and instruction_span(ln.text)
    ]
    if instruction_tops:
        cut = min(instruction_tops) - NEIGHBOUR_CLEARANCE
        lead = [rect for rect in lead if rect[3] <= cut]
        if not lead:
            return None
    top = min(rect[1] for rect in lead)
    bottom = max(rect[3] for rect in lead)
    if bottom - top < MIN_CONTINUATION:
        return None
    right = min(max(rect[2] for rect in lead), right_bound)
    # Keep clear of the problem this column opens with.
    bottom = min(bottom + CONTENT_MARGIN, ceiling)
    return {
        "page": scan.index,
        "bbox": flip_rect([left, top, right, bottom], scan.page.rect.height),
    }


def regions_for_page(
    scan: "PageScan",
    entries: list[tuple[str, Line]],
    carried: str | None = None,
    barriers: tuple[tuple[float, float, float], ...] = (),
) -> tuple[list[tuple[str, dict]], list[tuple[str, dict]], str | None]:
    """Turn this page's problem starts into bboxes (D-3).

    The unit is the page's column, not wherever a problem happens to begin. Inside a
    column the book mixes two layouts: short problems set two across ("39. P(1, 2)" beside
    "40. P(1, 3)"), and full-width ones that run the whole column. Treating every problem
    start as its own column, which is what an earlier version did, cut the full-width ones
    off at the width of the short ones.

    So problems are grouped into rows by their vertical position. A row of one takes the
    whole column; a row of several splits it, each problem reaching across to the next.

    `barriers` are the shared instructions on this page, each as (top, bottom, left). A
    problem stops above the instruction that introduces the problems after it - that
    paragraph is theirs, not a continuation of this one. Each carries where it starts,
    because a page has two columns and an instruction in one says nothing about where a
    problem in the other ends.

    A problem also runs on past the foot of a column: its parts (a) and (b) can sit at the
    top of the next one. Whatever stands above the first problem of a column therefore
    belongs to the problem before it, and is attached as a second region (D-3). `carried`
    is the last problem of the previous page, for a run-on across the page break.
    """
    if not entries:
        return [], [], carried
    page = scan.page
    height = page.rect.height

    # A column only counts as one if problems actually start in it, and one problem is
    # not enough: a stray number in the middle of some working ("... = 100.") would
    # otherwise draw a column boundary through the page and cut every solution beside it
    # in half. The leftmost margin is the page's own and needs no such support.
    detected = column_margins(scan.lines, page.rect.width)
    margins = [
        m
        for m in detected
        if sum(abs(line.rect[0] - m) <= COLUMN_HIT_TOLERANCE for _key, line in entries)
        >= (1 if m == detected[0] else COLUMN_MIN_PROBLEMS)
    ] or detected[:1]

    def column_of(x: float) -> int:
        best = 0
        for i, m in enumerate(margins):
            if x >= m - 8:
                best = i
        return best

    out: list[tuple[str, dict]] = []
    run_ons: list[tuple[str, dict]] = []
    previous = carried

    for col, left in enumerate(margins):
        col_right = margins[col + 1] - 6 if col + 1 < len(margins) else page.rect.width
        here = [(key, line) for key, line in entries if column_of(line.rect[0]) == col]
        if not here:
            continue
        column_lines = [
            ln.rect for ln in scan.lines if left - 8 <= ln.rect[0] < col_right
        ] + [
            shape
            for shape in scan.shapes
            if left - 8 <= shape[0] < col_right and shape[3] <= scan.bottom_limit
        ]

        # Group into rows: problems whose first lines sit at the same height.
        rows: list[list[tuple[str, Line]]] = []
        for key, line in sorted(here, key=lambda e: (e[1].rect[1], e[1].rect[0])):
            if rows and abs(line.rect[1] - rows[-1][0][1].rect[1]) <= ROW_TOLERANCE:
                rows[-1].append((key, line))
            else:
                rows.append([(key, line)])

        # Each problem's real top, which may sit above its own first line.
        tops: dict[int, float] = {}
        blocked = frozenset(
            tuple(ln.rect) for ln in scan.lines if SUBPART_LABEL.match(ln.text)
        )
        ordered_rows = [line for row in rows for _key, line in row]
        for position, line in enumerate(
            sorted(ordered_rows, key=lambda ln: (ln.rect[1], ln.rect[0]))
        ):
            earlier = sorted(ordered_rows, key=lambda ln: (ln.rect[1], ln.rect[0]))[:position]
            limit = max((ln.rect[3] for ln in earlier), default=0.0)
            # Nor above the instruction that introduces it: that paragraph's last line
            # is the instruction's, however close it sits to the problem.
            limit = max(
                limit,
                max(
                    (
                        bar_bottom
                        for _bar_top, bar_bottom, bar_left in barriers
                        if bar_bottom <= line.rect[1] + 0.5 and column_of(bar_left) == col
                    ),
                    default=0.0,
                ),
            )
            tops[id(line)] = content_top(line, column_lines, limit, blocked)

        # Anything above the first problem here continues the one before it.
        run_on = continuation(
            scan,
            min(tops[id(line)] for _key, line in rows[0]),
            column_lines,
            left,
            col_right,
        )
        if previous and run_on:
            run_ons.append((previous, run_on))

        for index, row in enumerate(rows):
            row.sort(key=lambda e: e[1].rect[0])
            next_row_top = (
                min(tops[id(line)] for _key, line in rows[index + 1])
                if index + 1 < len(rows)
                else None
            )
            packed = len(row) > 1

            barrier = min(
                (
                    bar_top
                    for bar_top, _bar_bottom, bar_left in barriers
                    if bar_top > row[0][1].rect[1] and column_of(bar_left) == col
                ),
                default=None,
            )
            floor = (
                next_row_top
                if next_row_top is not None and (barrier is None or next_row_top < barrier)
                else barrier
            )

            for position, (key, line) in enumerate(row):
                cell_left = left if position == 0 else line.rect[0]
                cell_right = row[position + 1][1].rect[0] - 6 if position + 1 < len(row) else col_right
                cell_lines = [r for r in column_lines if cell_left - 8 <= r[0] < cell_right]
                bottom = (
                    packed_bottom(line, cell_lines, floor, scan.bottom_limit)
                    if packed
                    else content_bottom(line, cell_lines, floor, scan.bottom_limit)
                )
                top = tops[id(line)]
                right = min(max((r[2] for r in cell_lines), default=line.rect[2]), cell_right)
                out.append(
                    (
                        key,
                        {
                            "page": scan.index,
                            "bbox": flip_rect([cell_left, top, right, bottom], height),
                        },
                    )
                )
        previous = rows[-1][-1][0]
    return out, run_ons, previous


def packed_bottom(
    line: Line, cell_lines: list[list[float]], next_top: float | None, floor: float
) -> float:
    """The bottom of a problem in a row of several.

    These are one- or two-liners set in a grid, and the space under them often holds a
    subheading belonging to what comes next, so the box follows the problem's own lines
    only: it stops at the first real vertical gap.
    """
    ordered = sorted(
        (
            r
            for r in cell_lines
            if r[1] >= line.rect[1] - 1
            and r[3] <= floor
            and (next_top is None or r[1] < next_top - 1)
        ),
        key=lambda r: r[1],
    )
    bottom = line.rect[3]
    for rect in ordered:
        if rect[1] - bottom > PACKED_LINE_GAP:
            break
        bottom = max(bottom, rect[3])
    bottom += CONTENT_MARGIN
    if next_top is not None:
        bottom = min(bottom, next_top - NEIGHBOUR_CLEARANCE)
    return min(bottom, floor)


def instruction_blocks(
    scan: "PageScan", margins: list[float]
) -> list[tuple[int, int, dict, float, float]]:
    """Find the shared instructions that govern a group of exercises.

    Thomas states the actual question once, above a run of problems ("Find the angles
    between the vectors in Exercises 9-12..."), and then prints only the data under each
    number. Rendering problem 9 alone would show `9. u = 2i + j, v = i + 2j - k` and no
    question at all, so each instruction is captured as its own region and attached to
    every problem in its range (D-3 allows a problem to have several regions).
    """
    out: list[tuple[int, int, dict, float, float]] = []
    if not scan.lines:
        return out
    page = scan.page
    height = page.rect.height
    hit_tops = {(round(ln.rect[0]), round(ln.rect[1])) for ln in scan.hits.values()}

    def column_of(x: float) -> int:
        best = 0
        for i, m in enumerate(margins):
            if x >= m - 8:
                best = i
        return best

    ordered = sorted(scan.lines, key=lambda ln: (column_of(ln.rect[0]), ln.rect[1]))
    for index, line in enumerate(ordered):
        if (round(line.rect[0]), round(line.rect[1])) in hit_tops:
            continue  # a problem, not an instruction
        span = instruction_span(line.text)
        if not span and index > 0:
            # The book hyphenates across line breaks, and "Exercises" is no exception:
            # "...joining the points in Exer-" / "cises 13-20. Draw coordinate axes...".
            # Rejoin the two before giving up on the line.
            earlier = ordered[index - 1]
            if (
                column_of(earlier.rect[0]) == column_of(line.rect[0])
                and 0 <= line.rect[1] - earlier.rect[3] <= 6
            ):
                span = instruction_span(join_wrapped(earlier.text, line.text))
        if not span:
            continue
        low, high = span
        col = column_of(line.rect[0])

        # The sentence may start on an earlier line ("Find the angles between the
        # vectors" / "in Exercises 9-12"), so walk up while the lines stay close. Only
        # lines starting at the same margin count: an instruction is set full width,
        # while the problem above it has its body indented under its number, and that
        # body is emphatically not part of the instruction.
        top = line.rect[1]
        for earlier in reversed(ordered[:index]):
            if column_of(earlier.rect[0]) != col:
                break
            if (round(earlier.rect[0]), round(earlier.rect[1])) in hit_tops:
                break
            if abs(earlier.rect[0] - line.rect[0]) > 2:
                break
            if 0 <= top - earlier.rect[3] <= 6:
                top = earlier.rect[1]
            else:
                break

        # It runs to the bottom of its own last line. Measuring back from the problem
        # underneath instead would slice that line in half wherever the two sit close
        # together, which in a tight setting is most of the time. The clearance below is
        # the same one problems keep, since the app adds a little padding of its own when
        # it draws and without the allowance the box spills onto the first problem.
        below = [
            ln.rect[1]
            for ln in scan.hits.values()
            if column_of(ln.rect[0]) == col and ln.rect[1] > line.rect[1]
        ]
        if below:
            first_problem = min(below)
            own = [
                r[3]
                for r in (ln.rect for ln in scan.lines)
                if column_of(r[0]) == col and top - 1 <= r[1] < first_problem
            ]
            bottom = min(
                (max(own) if own else line.rect[3]) + 1,
                first_problem - NEIGHBOUR_CLEARANCE,
            )
        else:
            bottom = line.rect[3] + CONTENT_MARGIN

        left = margins[col]
        right_bound = margins[col + 1] - 6 if col + 1 < len(margins) else page.rect.width
        in_column = [
            ln.rect for ln in scan.lines if left - 8 <= ln.rect[0] < right_bound
        ]
        right = min(max((r[2] for r in in_column), default=line.rect[2]), right_bound)
        if bottom <= top:
            continue
        out.append(
            (
                low,
                high,
                {"page": scan.index, "bbox": flip_rect([left, top, right, bottom], height)},
                top,
                bottom,
            )
        )
    return out


def scan_section(
    scans: list[PageScan],
    pattern: re.Pattern[str],
    chapter: int | None,
    section: str | None,
    margin_tol: float,
    regions: dict[str, list[dict]],
    report: "ScanReport",
) -> None:
    """Both passes, then region building, for one section's worth of pages."""
    for scan in scans:
        strict_pass(scan, pattern, chapter, section, margin_tol)
    report.repaired += repair_pass(scans)
    if section is not None:
        report.sections.add(f"{chapter}.{section}")

    # Collect the shared instructions once per section, then hand each problem the one
    # that governs it.
    shared: list[tuple[int, int, dict, float, float]] = []
    for scan in scans:
        if scan.hits:
            shared.extend(
                instruction_blocks(scan, column_margins(scan.lines, scan.page.rect.width))
            )
    # Deduplicate: an instruction that wraps can be recognised from either of its lines.
    shared = list(
        {
            (low, high, top): (low, high, region, top, bottom)
            for low, high, region, top, bottom in shared
        }.values()
    )

    barriers_by_page: dict[int, tuple[tuple[float, float, float], ...]] = {}
    for _low, _high, region, top, bottom in shared:
        barriers_by_page.setdefault(region["page"], ())
        barriers_by_page[region["page"]] += ((top, bottom, region["bbox"][0]),)

    carried: str | None = None
    for scan in scans:
        entries = [
            (
                normalize_key(chapter, section, number)
                if section is not None
                else normalize_key(chapter, number),
                line,
            )
            for number, line in sorted(scan.hits.items())
        ]
        found, run_ons, carried = regions_for_page(
            scan, entries, carried, barriers_by_page.get(scan.index, ())
        )
        if found:
            report.pages += 1
        record(regions, report, found)
        attach(regions, report, run_ons)

        # Slip each problem's shared instruction in ahead of the problem itself, without
        # counting it as another sighting of the key.
        for key, _region in found:
            number = int(re.sub(r"[a-z]+$", "", key.split(".")[-1]))
            covering = [block for block in shared if block[0] <= number <= block[1]]
            if not covering:
                continue
            # The tightest range wins: "Exercises 9-12" beats "Exercises 1-40".
            instruction = min(covering, key=lambda block: block[1] - block[0])[2]
            regions[key].insert(len(regions[key]) - 1, instruction)
            report.instructions += 1


# --- scanning strategies ---------------------------------------------------------------


@dataclass
class Window:
    """An exercise set: which section it belongs to, and where it starts and ends."""

    chapter: int
    section: int
    start_page: int
    start_y: float
    end_page: int
    end_y: float


def exercise_windows(doc, pages: range, heading_size: float) -> list[Window]:
    """Find exercise sets by their oversized headings. Each runs until the next oversized
    heading - the following section title, or the next exercise set."""
    landmarks: list[tuple[int, float, tuple[int, int] | None]] = []
    for i in pages:
        for ln in page_lines(doc[i]):
            if ln.size < heading_size:
                continue
            text = ln.text.strip()
            m = EXERCISE_HEADING.match(text)
            if m:
                landmarks.append((i, ln.rect[1], (int(m.group(1)), int(m.group(2)))))
            elif SECTION_TITLE.match(text) or CHAPTER_SET.match(text):
                # Only a real heading closes an exercise set. Display maths inside one is
                # often set large too, and must not be mistaken for the end of it.
                landmarks.append((i, ln.rect[1], None))
    landmarks.sort(key=lambda l: (l[0], l[1]))

    windows: list[Window] = []
    last_page = pages[-1] if len(pages) else 0
    for index, (page_index, y, section) in enumerate(landmarks):
        if section is None:
            continue
        if index + 1 < len(landmarks):
            end_page, end_y = landmarks[index + 1][0], landmarks[index + 1][1]
        else:
            end_page, end_y = last_page, doc[last_page].rect.height
        if end_page - page_index > MAX_WINDOW_PAGES:
            # Nothing closed this set. Rather than read on into the answer key at the
            # back of the book, stop after as many pages as an exercise set ever runs.
            end_page = page_index + MAX_WINDOW_PAGES
            end_y = doc[end_page].rect.height
        windows.append(Window(section[0], section[1], page_index, y, end_page, end_y))
    return windows


def scan_by_heading(
    doc, pages: range, pattern: re.Pattern[str], heading_size: float, margin_tol: float
) -> tuple[dict[str, list[dict]], ScanReport]:
    report = ScanReport()
    regions: dict[str, list[dict]] = {}
    last_page = pages[-1] if len(pages) else 0

    for window in exercise_windows(doc, pages, heading_size):
        scans: list[PageScan] = []
        for page_index in range(window.start_page, min(window.end_page, last_page) + 1):
            page = doc[page_index]
            # Trim the window's first and last page at the headings; drop the running
            # head on the pages in between.
            top = window.start_y if page_index == window.start_page else page.rect.height * 0.08
            bottom = window.end_y if page_index == window.end_page else page.rect.height - 30
            lines = [ln for ln in page_lines(page) if top <= ln.rect[1] < bottom]
            if lines:
                shapes = [sh for sh in page_shapes(page) if top <= sh[1] < bottom]
                scans.append(PageScan(page_index, page, lines, bottom, shapes=shapes))
        scan_section(
            scans, pattern, window.chapter, str(window.section), margin_tol, regions, report
        )
    return regions, report


PLAIN_NUMBER = re.compile(r"^\s*(\d{1,3})[a-z]?\s*[.)](?:\s|$)")


def content_top(
    line: Line,
    column_lines: list[list[float]],
    limit: float = 0.0,
    blocked: frozenset[tuple[float, ...]] = frozenset(),
) -> float:
    """Where a problem's box should start.

    Maths does not sit neatly under the line that introduces it. A cross product prints
    its determinant with the `i j k` row *above* the text that says "u x v =", and the
    same goes for the top of a tall fraction or radical. Anything standing between two
    problems is given to the one it sits closer to, which puts that row with the
    determinant it belongs to instead of trailing the solution before it.

    `limit` is the bottom of the previous problem's own first line: nothing above that
    can belong here. `blocked` holds lines that announce themselves as parts of the
    problem above - "a.", "b." - which no amount of proximity can claim.
    """
    top = line.rect[1]

    # Tall maths - a braced system, a stacked fraction - is set around the line that
    # labels it, starting above and ending below. Such a block overlaps the label
    # rather than sitting clear of it, so it never appears in the list below.
    straddling = [
        r[1]
        for r in column_lines
        if r[1] < top and r[3] > top + 0.5 and r[1] >= limit and top - r[1] <= STRADDLE_REACH
    ]
    if straddling:
        top = min(straddling)

    above = sorted(
        (r for r in column_lines if r[3] <= top + 0.5 and r[1] >= limit),
        key=lambda r: -r[3],
    )
    for rect in above:
        if rect[3] > top:
            continue
        if tuple(rect) in blocked:
            break
        gap_below = top - rect[3]
        # What sits above this line has to be measured against everything on the page,
        # not just the lines still in play: `above` stops at the previous problem, so
        # judging the gap from that shortened list makes it look infinite and every line
        # ends up looking closer to the problem below.
        higher = [r[3] for r in column_lines if r[3] <= rect[1] + 0.5]
        gap_above = rect[1] - max(higher) if higher else float("inf")
        if gap_below <= MAX_ADOPT_GAP and gap_below < gap_above:
            top = min(top, rect[1])
        else:
            break

    remaining = [r[3] for r in column_lines if r[3] <= top + 0.5]
    room = top - max(remaining) if remaining else ASCENDER_MARGIN
    return top - min(ASCENDER_MARGIN, max(0.0, room - NEIGHBOUR_CLEARANCE))


def content_bottom(
    line: Line,
    column_lines: list[list[float]],
    next_top: float | None,
    floor: float,
) -> float:
    """Where a problem's box should end.

    Bound it by the problem's own last line of text rather than by wherever the next
    problem starts: measuring down from the next problem clips the current one whenever
    the two sit close together, and maths routinely paints outside the line box PyMuPDF
    reports for it, so a little margin is added underneath.

    The cut is strict: everything from the next problem's first line down is left out.
    Where the manual sets answers as a table, the last cell of a row can wrap onto a line
    level with the next answer, and that fragment is lost - but a horizontal slice cannot
    keep it without also showing the answer below, which is the worse mistake.
    """
    mine = [
        rect[3]
        for rect in column_lines
        if rect[1] >= line.rect[1] - 1
        and rect[3] <= floor
        and (next_top is None or rect[1] < next_top - 1)
    ]
    bottom = (max(mine) if mine else line.rect[3]) + CONTENT_MARGIN
    if next_top is not None:
        bottom = min(bottom, next_top - NEIGHBOUR_CLEARANCE)
    return min(bottom, floor)


@dataclass
class Candidate:
    """A numbered line that might open a solution, in reading order."""

    scan: "PageScan"
    line: Line
    number: int


def candidates_in_order(scan: "PageScan", margin_tol: float) -> list[Candidate]:
    """Numbered lines starting at a column margin, in the order a reader meets them."""
    if not scan.lines:
        return []
    margins = start_margins(scan.lines, scan.page.rect.width)

    def column_of(x: float) -> int:
        best = 0
        for i, m in enumerate(margins):
            if x >= m - 8:
                best = i
        return best

    found: list[tuple[int, float, Candidate]] = []
    for ln in scan.lines:
        if not any(m - 2 <= ln.rect[0] <= m + margin_tol for m in margins):
            continue
        text = ln.text.strip()
        if FALSE_START.match(text):
            continue
        m = PLAIN_NUMBER.match(text)
        if m:
            number = int(m.group(1))
            if 1 <= number <= MAX_NUMBER:
                found.append((column_of(ln.rect[0]), ln.rect[1], Candidate(scan, ln, number)))
    found.sort(key=lambda f: (f[0], f[1]))
    return [c for _col, _y, c in found]


def build_runs(candidates: list["Candidate"]) -> list[list["Candidate"]]:
    """Group candidates into runs of consecutive numbering. A run breaks when the
    numbering goes backwards, or jumps further forward than exercises ever do."""
    runs: list[list[Candidate]] = []
    for cand in candidates:
        if runs and 0 < cand.number - runs[-1][-1].number <= MAX_FORWARD_GAP:
            runs[-1].append(cand)
        else:
            runs.append([cand])
    return runs


def attribute_runs(
    runs: list[list["Candidate"]],
    own_head: dict[int, tuple[int, str]],
    sequence: list[tuple[int, str]],
    report: "ScanReport",
) -> list[tuple[tuple[int, str], "Candidate"]]:
    """Decide which section each run of solutions belongs to.

    The running head names a section on alternating pages only, and a page routinely
    carries the end of one section and the start of the next, so neither the head alone
    nor the page alone can place a solution. Three rules, in order:

      * a head naming a different section settles it - a run cannot straddle a boundary,
        because the numbering restart splits it in two;
      * a restart that nothing corroborates is a fragment of maths, not a solution;
      * a run beyond the last page that claimed the current section belongs to no section
        at all (chapter review sets live there), and is dropped rather than mis-filed.
    """

    def corroborated(run: list["Candidate"], all_runs: list[list["Candidate"]], i: int) -> bool:
        """A real restart runs on for a while, or the next run picks up where it left off."""
        following = all_runs[i + 1] if i + 1 < len(all_runs) else None
        return len(run) >= 3 or (
            following is not None and 0 < following[0].number - run[-1].number <= MAX_FORWARD_GAP
        )

    out: list[tuple[tuple[int, str], Candidate]] = []
    if not sequence:
        return out
    current = sequence[0]
    section_high = 0

    for index, run in enumerate(runs):
        low, high = run[0].number, run[-1].number
        run_pages = sorted({cand.scan.index for cand in run})
        restarted = low <= RESTART_CEILING and section_high >= MIN_SECTION_LENGTH
        # Numbering that leaps far past where the section has got to is usually a number
        # inside the working - "|F| = 100." reads as problem 100 - rather than a run of
        # exercises nobody set.
        jumped = low > section_high + MAX_FORWARD_GAP
        heads = [own_head[page] for page in run_pages if page in own_head]
        last_head_page = max(
            (page for page, head in own_head.items() if head == current), default=-1
        )
        here = Counter(heads).most_common(1)[0][0] if heads else None

        if here is not None and here != current:
            # A page of the run names a different section: the boundary is here.
            current = here
            section_high = 0
        elif (restarted or jumped) and not corroborated(run, runs, index):
            # A number amid dense maths is a fragment, not a solution - whether it reads
            # low or high - even on a page that names a section, which is why this
            # outranks the head.
            report.dropped += len(run)
            continue
        elif here is None and restarted and run_pages[0] > last_head_page:
            # Numbering has restarted on pages naming no section. Either the next
            # section has begun a page early - its first page carries the even-page
            # running head - or this is a chapter review set, which belongs to no
            # section at all. The page that names a section next settles it: close by
            # means the section started here, far off means there is nothing to file
            # this under, and filing it under the section before would put the wrong
            # solution against a problem.
            upcoming = min((p for p in own_head if p > run_pages[-1]), default=None)
            if (
                upcoming is not None
                and upcoming - run_pages[-1] <= SECTION_LOOKAHEAD
                and own_head[upcoming] != current
            ):
                current = own_head[upcoming]
                section_high = 0
            else:
                report.dropped += len(run)
                continue
        elif here is None and run_pages[0] > last_head_page + 1:
            report.dropped += len(run)
            continue

        section_high = max(section_high, high)
        out.extend((current, cand) for cand in run)
    return out


def scan_by_flow(
    doc,
    pages: range,
    margin_tol: float,
    head_frac: float = 0.1,
    foot_frac: float = FOOT_FRACTION,
    lookahead: int = 3,
) -> tuple[dict[str, list[dict]], "ScanReport"]:
    """Read the manual as one continuous run of numbered solutions.

    The running head names a section on alternating pages only, and a page routinely
    carries the end of one section and the start of the next. So the heads are used only
    for the *sequence* of sections; the boundaries come from the numbering, which
    restarts at 1 in every section. A lone low number that the sequence does not sustain
    is a stray fragment of maths, and is dropped.
    """
    report = ScanReport()
    regions: dict[str, list[dict]] = {}

    scans: list[PageScan] = []
    sequence: list[tuple[int, str]] = []
    own_head: dict[int, tuple[int, str]] = {}
    chapter: int | None = None

    for page_index in pages:
        page = doc[page_index]
        lines = page_lines(page)
        head_limit = page.rect.height * head_frac
        for ln in lines:
            if ln.rect[1] >= head_limit:
                continue
            m = SECTION_HEAD.search(ln.text)
            if m:
                here = (int(m.group(1)), m.group(2))
                own_head[page_index] = here
                if not sequence or sequence[-1] != here:
                    sequence.append(here)
                break
            c = CHAPTER_HEADING.search(ln.text)
            if c:
                chapter = int(c.group(1))
        # Trim the running head and the copyright line at the foot: neither belongs to
        # the solution above it, and the last solution on a page would otherwise run all
        # the way down to the footer.
        foot_limit = page.rect.height * foot_frac
        body = [ln for ln in lines if head_limit <= ln.rect[1] < foot_limit]
        if body:
            shapes = [sh for sh in page_shapes(page) if head_limit <= sh[1] < foot_limit]
            scans.append(PageScan(page_index, page, body, foot_limit, shapes=shapes))

    if not sequence:
        report.unsectioned_pages = len(scans)
        return regions, report

    ordered: list[Candidate] = []
    for scan in scans:
        ordered.extend(candidates_in_order(scan, margin_tol))

    runs = build_runs(ordered)

    accepted: dict[int, list[tuple[str, Line]]] = {}
    for section, cand in attribute_runs(runs, own_head, sequence, report):
        chapter_number, section_number = section
        report.sections.add(f"{chapter_number}.{section_number}")
        key = normalize_key(chapter_number, section_number, cand.number)
        accepted.setdefault(cand.scan.index, []).append((key, cand.line))

    carried: str | None = None
    for scan in scans:
        entries = accepted.get(scan.index, [])
        if entries:
            report.pages += 1
        found, run_ons, carried = regions_for_page(scan, entries, carried)
        record(regions, report, found)
        attach(regions, report, run_ons)
    return regions, report


def scan_by_running_head(
    doc, pages: range, pattern: re.Pattern[str], margin_tol: float, head_frac: float = 0.1
) -> tuple[dict[str, list[dict]], ScanReport]:
    """The manual: sections come from running heads, boundaries from the numbering."""
    del pattern  # the flow scanner matches numbers itself
    return scan_by_flow(doc, pages, margin_tol, head_frac)


def scan_plain(
    doc, pages: range, pattern: re.Pattern[str], margin_tol: float, chapter: int | None
) -> tuple[dict[str, list[dict]], ScanReport]:
    """No sections: the chapter comes from "Chapter N" lines or --chapter (original D-5)."""
    report = ScanReport()
    regions: dict[str, list[dict]] = {}
    groups: list[tuple[int | None, list[PageScan]]] = []
    running = chapter

    for page_index in pages:
        page = doc[page_index]
        lines = page_lines(page)
        for ln in lines:
            m = CHAPTER_HEADING.match(ln.text.strip())
            if m:
                running = int(m.group(1))
        scan = PageScan(
            page_index, page, lines, page.rect.height - 36, shapes=page_shapes(page)
        )
        if groups and groups[-1][0] == running:
            groups[-1][1].append(scan)
        else:
            groups.append((running, [scan]))

    for chapter_number, scans in groups:
        scan_section(scans, pattern, chapter_number, None, margin_tol, regions, report)
    return regions, report


def open_doc(path: Path):
    try:
        # Imported lazily so the regex tests (D-14) need no dependency.
        import pymupdf
    except ImportError:  # pragma: no cover - older PyMuPDF, or none at all
        try:
            import fitz as pymupdf  # noqa: N813
        except ImportError:
            raise SystemExit("PyMuPDF is required: pip install pymupdf")
    return pymupdf.open(path)


def scan_pdf(
    path: Path,
    pattern: re.Pattern[str],
    section_from: str,
    pages: str | None = None,
    chapter: int | None = None,
    heading_size: float = 16.0,
    margin_tol: float = 12.0,
) -> tuple[dict[str, list[dict]], ScanReport]:
    doc = open_doc(path)
    page_range = parse_page_range(pages, doc.page_count)
    if section_from == "heading":
        result = scan_by_heading(doc, page_range, pattern, heading_size, margin_tol)
    elif section_from == "running-head":
        result = scan_by_running_head(doc, page_range, pattern, margin_tol)
    else:
        result = scan_plain(doc, page_range, pattern, margin_tol, chapter)
    doc.close()
    return result


# --- assembling the draft --------------------------------------------------------------


def _collapse(regions: list[dict]) -> dict | list[dict]:
    """D-3: one region stores as an object, several as a list."""
    return regions[0] if len(regions) == 1 else regions


def build_index(
    book: str,
    text_regions: dict[str, list[dict]],
    solution_regions: dict[str, list[dict]],
) -> dict:
    problems: dict[str, dict] = {}
    for key in sorted(set(text_regions) | set(solution_regions), key=sort_key):
        entry: dict[str, object] = {}
        if key in text_regions:
            entry["text"] = _collapse(text_regions[key])
        if key in solution_regions:
            entry["solution"] = _collapse(solution_regions[key])
        problems[key] = entry
    return {"book": book, "problems": problems}


def merge_overrides(base: dict, overrides: dict) -> tuple[dict, list[str]]:
    """D-8: fold an exported override file into an index. Overrides win, field by field."""
    merged = {"book": base.get("book") or overrides.get("book", "Unknown book"), "problems": {}}
    problems = dict(base.get("problems", {}))
    changed: list[str] = []
    for key, entry in overrides.get("problems", {}).items():
        current = dict(problems.get(key, {}))
        for field_name in ("text", "solution"):
            if entry.get(field_name):
                current[field_name] = entry[field_name]
        if current != problems.get(key):
            changed.append(key)
        problems[key] = current
    merged["problems"] = {k: problems[k] for k in sorted(problems, key=sort_key)}
    return merged, changed


def coverage_note(index: dict) -> str:
    """Q2: how much of the assignment space the manual actually covers."""
    problems = index.get("problems", {})
    with_text = [k for k, v in problems.items() if v.get("text")]
    with_solution = [k for k, v in problems.items() if v.get("solution")]
    missing = sorted(set(with_text) - set(with_solution), key=sort_key)
    orphan = sorted(set(with_solution) - set(with_text), key=sort_key)
    return "\n".join(
        [
            f"{len(problems)} keys: {len(with_text)} located in the textbook, "
            f"{len(with_solution)} in the manual",
            f"{len(missing)} problems have no solution region"
            + (f" (e.g. {', '.join(missing[:8])})" if missing else ""),
            f"{len(orphan)} solutions have no problem region"
            + (f" (e.g. {', '.join(orphan[:8])})" if orphan else ""),
        ]
    )


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--textbook", type=Path, help="textbook PDF to scan")
    parser.add_argument("--solutions", type=Path, help="solution manual PDF to scan")
    parser.add_argument("--book", default="Unknown book", help="title and edition for index.json")
    parser.add_argument(
        "--pattern", default="bare", choices=sorted(PATTERNS), help="problem-number style"
    )
    parser.add_argument(
        "--regex", help="custom pattern with named groups chapter/section/number/suffix"
    )
    parser.add_argument(
        "--section-from",
        default="heading",
        choices=("heading", "running-head", "none"),
        help="how to tell which section a textbook page belongs to",
    )
    parser.add_argument(
        "--solution-section-from",
        default="running-head",
        choices=("heading", "running-head", "none"),
        help="same, for the solution manual",
    )
    parser.add_argument("--pages", help="textbook page range, 0-based, e.g. 180-260")
    parser.add_argument("--solution-pages", help="manual page range, 0-based")
    parser.add_argument("--chapter", type=int, help="chapter to assume when --section-from none")
    parser.add_argument(
        "--margin-tolerance",
        type=float,
        default=12.0,
        help="points a problem number may sit right of its column's left edge",
    )
    parser.add_argument(
        "--heading-size",
        type=float,
        default=16.0,
        help="point size at or above which a line counts as an exercise-set heading",
    )
    parser.add_argument("-o", "--out", type=Path, default=Path("index.draft.json"))
    parser.add_argument(
        "--merge",
        nargs=2,
        metavar=("INDEX", "OVERRIDES"),
        type=Path,
        help="merge an override export into an index (D-8)",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.merge:
        base_path, override_path = args.merge
        base = json.loads(base_path.read_text(encoding="utf-8"))
        overrides = json.loads(override_path.read_text(encoding="utf-8"))
        merged, changed = merge_overrides(base, overrides)
        args.out.write_text(json.dumps(merged, indent=2) + "\n", encoding="utf-8")
        print(f"merged {len(changed)} key(s) into {args.out}: {', '.join(changed) or '(none)'}")
        return 0

    if not args.textbook and not args.solutions:
        parser.error("give --textbook and/or --solutions, or use --merge")

    pattern = compile_pattern(args.pattern, args.regex)
    text_regions: dict[str, list[dict]] = {}
    solution_regions: dict[str, list[dict]] = {}

    if args.textbook:
        text_regions, report = scan_pdf(
            args.textbook,
            pattern,
            args.section_from,
            args.pages,
            args.chapter,
            args.heading_size,
            args.margin_tolerance,
        )
        print(f"textbook: {report.note()}", file=sys.stderr)
    if args.solutions:
        solution_regions, report = scan_pdf(
            args.solutions,
            pattern,
            args.solution_section_from,
            args.solution_pages,
            args.chapter,
            args.heading_size,
            args.margin_tolerance,
        )
        print(f"manual:   {report.note()}", file=sys.stderr)
        if report.unsectioned_pages:
            print(
                f"          {report.unsectioned_pages} pages had no section in the running "
                f"head and were skipped",
                file=sys.stderr,
            )

    index = build_index(args.book, text_regions, solution_regions)
    args.out.write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    print(coverage_note(index), file=sys.stderr)
    print(
        f"wrote {args.out}. D-4: review and hand-correct it, then commit it as index.json.",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
