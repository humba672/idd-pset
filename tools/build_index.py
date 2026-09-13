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

Usage
-----
    python tools/build_index.py --textbook book.pdf --solutions manual.pdf \
        --book "Author, Title, 4th ed" --pattern chapter-dot -o index.draft.json

    python tools/build_index.py --merge index.json index.overrides.json -o index.json

Q1 is unresolved, so the problem-number pattern is a flag rather than a constant:

    chapter-dot   3.14, 3.14a          (key is taken verbatim)
    bare          14, 14a              (chapter comes from a running "Chapter N" heading
                                        or --chapter)
    --regex       your own, with named groups (?P<chapter>) (?P<number>) (?P<suffix>)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Iterator, Sequence

# --- problem-number recognition (D-5 keys, unit-tested in test_build_index.py) ---------

PATTERNS: dict[str, str] = {
    # 3.14  3.14a  3.14)  3.14.
    "chapter-dot": r"^(?P<chapter>\d{1,2})\.(?P<number>\d{1,3})(?P<suffix>[a-z])?\s*[.):\s]",
    # 14.  14)  14a)
    "bare": r"^(?P<number>\d{1,3})(?P<suffix>[a-z])?\s*[.):]\s",
}

CHAPTER_HEADING = re.compile(r"^\s*(?:chapter|ch\.?|unit)\s+(\d{1,2})\b", re.IGNORECASE)

# A line that opens with a number is not always a problem: "0.5 mol of ...", "3.14159",
# page headers and figure captions all look similar. These guards cut the obvious ones.
FALSE_START = re.compile(
    r"^\s*(?:figure|fig\.?|table|example|eq\.?|equation|section|page|chapter)\b",
    re.IGNORECASE,
)

# Points left between a region's bottom and the next problem's first line.
NEXT_PROBLEM_GAP = 4

MAX_CHAPTER = 99
MAX_NUMBER = 999


def normalize_key(chapter: str | int, number: str | int, suffix: str = "") -> str:
    """D-5 canonical key: <chapter>.<number> with an optional lowercase letter."""
    return f"{int(chapter)}.{int(number)}{(suffix or '').lower()}"


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
) -> str | None:
    """Returns the canonical key a line starts with, or None.

    `chapter` supplies the chapter for patterns that only capture a number (the `bare`
    pattern), and is ignored when the line carries its own chapter.
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
    return normalize_key(chapter_i, number_i, groups.get("suffix") or "")


def flip_rect(
    rect: Sequence[float], page_height: float, pad: float = 2.0
) -> list[float]:
    """PyMuPDF top-left rect -> PDF user space [x0, y0, x1, y1] with origin bottom-left."""
    x0, y0, x1, y1 = (float(v) for v in rect)
    return [
        round(x0 - pad, 2),
        round(page_height - y1 - pad, 2),
        round(x1 + pad, 2),
        round(page_height - y0 + pad, 2),
    ]


# --- scanning -------------------------------------------------------------------------


@dataclass
class Hit:
    """One problem start found on a page, with the block it began in."""

    key: str
    page: int
    rect: list[float]  # PyMuPDF coordinates, top-left origin
    column: int = 0


@dataclass
class ScanReport:
    pages: int = 0
    hits: int = 0
    keys: set[str] = field(default_factory=set)
    duplicates: list[str] = field(default_factory=list)

    def miss_rate_note(self) -> str:
        return (
            f"{self.hits} problem starts over {self.pages} pages, "
            f"{len(self.keys)} distinct keys, {len(self.duplicates)} duplicate keys"
        )


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


def _lines_with_rects(page) -> Iterator[tuple[str, list[float]]]:
    """Every text line on a page as (text, rect) in PyMuPDF coordinates."""
    data = page.get_text("dict")
    for block in data.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            text = "".join(span.get("text", "") for span in line.get("spans", []))
            if text.strip():
                yield text, list(line["bbox"])


def scan_pdf(
    path: Path,
    pattern: re.Pattern[str],
    pages: str | None = None,
    chapter: int | None = None,
    columns: int = 1,
) -> tuple[dict[str, list[dict]], ScanReport]:
    """Finds problem starts and turns each into a region running to the next start.

    Returns {key: [{"page": i, "bbox": [...]}, ...]} plus a report for the P1 acceptance
    note on regex miss rate.
    """
    try:
        # Imported lazily so the regex tests (D-14) need no dependency.
        import pymupdf as fitz
    except ImportError:  # pragma: no cover - older PyMuPDF, or none at all
        try:
            import fitz
        except ImportError:
            raise SystemExit("PyMuPDF is required: pip install pymupdf")

    doc = fitz.open(path)
    report = ScanReport()
    regions: dict[str, list[dict]] = {}
    running_chapter: int | None = chapter

    for page_index in parse_page_range(pages, doc.page_count):
        page = doc[page_index]
        height = page.rect.height
        mid_x = page.rect.width / 2
        report.pages += 1

        hits: list[Hit] = []
        lines = list(_lines_with_rects(page))
        for text, rect in lines:
            heading = CHAPTER_HEADING.match(text.strip())
            if heading:
                running_chapter = int(heading.group(1))
                continue
            key = match_problem(text, pattern, running_chapter)
            if key:
                column = 1 if columns > 1 and rect[0] >= mid_x else 0
                hits.append(Hit(key=key, page=page_index, rect=rect, column=column))

        # A problem runs from its own start down to the next start in the same column,
        # or to the bottom of the text on that page.
        for i, hit in enumerate(hits):
            column_lines = [
                rect
                for _, rect in lines
                if (1 if columns > 1 and rect[0] >= mid_x else 0) == hit.column
            ]
            same_column = [h for h in hits[i + 1 :] if h.column == hit.column]
            if same_column and same_column[0].rect[1] > hit.rect[1]:
                # Stop just short of the next problem's first line: both this box and
                # the renderer pad a little, and the two paddings must not overlap.
                bottom = same_column[0].rect[1] - NEXT_PROBLEM_GAP
            else:
                # Last problem in the column: stop at the last line of text, not at the
                # bottom of the page, so the box does not swallow the footer.
                below = [r[3] for r in column_lines if r[3] > hit.rect[1]]
                bottom = max(below) if below else page.rect.height - 36
            left = min((r[0] for r in column_lines), default=hit.rect[0])
            right = max((r[2] for r in column_lines), default=hit.rect[2])
            rect = [left, hit.rect[1], right, bottom]
            regions.setdefault(hit.key, []).append(
                {"page": page_index, "bbox": flip_rect(rect, height)}
            )
            report.hits += 1
            if hit.key in report.keys:
                report.duplicates.append(hit.key)
            report.keys.add(hit.key)

    doc.close()
    return regions, report


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


def sort_key(key: str) -> tuple[int, int, str]:
    m = re.fullmatch(r"(\d+)\.(\d+)([a-z]*)", key)
    if not m:
        return (10**6, 0, key)
    return (int(m.group(1)), int(m.group(2)), m.group(3))


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
    lines = [
        f"{len(problems)} keys: {len(with_text)} located in the textbook, "
        f"{len(with_solution)} in the manual",
        f"{len(missing)} problems have no solution region"
        + (f" (e.g. {', '.join(missing[:8])})" if missing else ""),
        f"{len(orphan)} solutions have no problem region"
        + (f" (e.g. {', '.join(orphan[:8])})" if orphan else ""),
    ]
    return "\n".join(lines)


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--textbook", type=Path, help="textbook PDF to scan")
    parser.add_argument("--solutions", type=Path, help="solution manual PDF to scan")
    parser.add_argument("--book", default="Unknown book", help="title and edition for index.json")
    parser.add_argument("--pattern", default="chapter-dot", choices=sorted(PATTERNS), help="problem-number style (Q1)")
    parser.add_argument("--regex", help="custom pattern with named groups chapter/number/suffix")
    parser.add_argument("--solution-pattern", help="different style in the manual; defaults to --pattern")
    parser.add_argument("--pages", help="textbook page range, 0-based, e.g. 180-260")
    parser.add_argument("--solution-pages", help="manual page range, 0-based")
    parser.add_argument("--chapter", type=int, help="chapter to assume for the `bare` pattern")
    parser.add_argument("--columns", type=int, default=1, choices=(1, 2), help="page layout")
    parser.add_argument("-o", "--out", type=Path, default=Path("index.draft.json"))
    parser.add_argument("--merge", nargs=2, metavar=("INDEX", "OVERRIDES"), type=Path, help="merge an override export into an index (D-8)")
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
    solution_pattern = (
        compile_pattern(args.solution_pattern, None) if args.solution_pattern else pattern
    )

    text_regions: dict[str, list[dict]] = {}
    solution_regions: dict[str, list[dict]] = {}

    if args.textbook:
        text_regions, report = scan_pdf(
            args.textbook, pattern, args.pages, args.chapter, args.columns
        )
        print(f"textbook:  {report.miss_rate_note()}", file=sys.stderr)
    if args.solutions:
        solution_regions, report = scan_pdf(
            args.solutions, solution_pattern, args.solution_pages, args.chapter, args.columns
        )
        print(f"manual:    {report.miss_rate_note()}", file=sys.stderr)

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
