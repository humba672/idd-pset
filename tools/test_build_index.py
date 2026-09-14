"""D-14: unit tests for the problem-number regex against sample strings, and for the
section attribution that decides which exercise set a solution belongs to.

These exercise the pure parts of build_index.py only, so they run without PyMuPDF
installed (the import in `open_doc` is deliberately lazy).

    python -m unittest discover -s tools -p 'test_*.py'
"""

import unittest
from types import SimpleNamespace

from build_index import (
    Line,
    SUBPART_LABEL,
    content_top,
    instruction_span,
    rejoin_hyphenated,
    ScanReport,
    attribute_runs,
    build_index,
    build_runs,
    column_margins,
    compile_pattern,
    coverage_note,
    flip_rect,
    match_problem,
    merge_overrides,
    normalize_key,
    parse_page_range,
    sort_key,
)

BARE = compile_pattern("bare")
CHAPTER_DOT = compile_pattern("chapter-dot")


def candidate(number: int, page: int):
    """A stand-in for a numbered line found on a page."""
    return SimpleNamespace(number=number, scan=SimpleNamespace(index=page), line=None)


class TestBarePattern(unittest.TestCase):
    """How Thomas' Calculus numbers its exercises: bare numbers, per section."""

    def test_recognizes_the_common_forms(self):
        cases = {
            "14. Find the domain.": "1.1.14",
            "14) Find the domain.": "1.1.14",
            "14a) Find the domain.": "1.1.14a",
            "14.": "1.1.14",  # the manual prints many solution numbers alone on a line
            "  14.  leading whitespace is fine": "1.1.14",
        }
        for line, expected in cases.items():
            with self.subTest(line=line):
                self.assertEqual(match_problem(line, BARE, chapter=1, section="1"), expected)

    def test_without_a_section_the_key_is_two_parts(self):
        self.assertEqual(match_problem("14. Find the domain.", BARE, chapter=3), "3.14")

    def test_needs_a_chapter_from_context(self):
        self.assertIsNone(match_problem("14. Find the domain.", BARE))

    def test_rejects_lines_that_merely_start_with_a_number(self):
        for line in [
            "14.5 grams of reagent",
            "Figure 1.14 shows the graph.",
            "Table 1.1 Values",
            "Example 3 Worked in the text.",
            "The domain is all reals.",
            "",
            "   ",
        ]:
            with self.subTest(line=line):
                self.assertIsNone(match_problem(line, BARE, chapter=1, section="1"))


class TestChapterDotPattern(unittest.TestCase):
    """The other common style, for books numbered per chapter."""

    def test_recognizes_and_rejects(self):
        self.assertEqual(match_problem("3.14 A block slides.", CHAPTER_DOT), "3.14")
        self.assertEqual(match_problem("3.14a A block slides.", CHAPTER_DOT), "3.14a")
        self.assertIsNone(match_problem("3.14159 is close enough.", CHAPTER_DOT))
        self.assertIsNone(match_problem("0.5 mol of gas", CHAPTER_DOT))


class TestKeysAndSorting(unittest.TestCase):
    def test_normalize_key_at_either_depth(self):
        self.assertEqual(normalize_key(3, 14), "3.14")
        self.assertEqual(normalize_key(12, "3", 7), "12.3.7")
        self.assertEqual(normalize_key(12, 3, 7, suffix="A"), "12.3.7a")

    def test_sorts_by_each_part_then_suffix(self):
        keys = ["12.3.16", "12.3.2", "12.10.1", "12.3.2a", "2.1.9"]
        self.assertEqual(
            sorted(keys, key=sort_key),
            ["2.1.9", "12.3.2", "12.3.2a", "12.3.16", "12.10.1"],
        )


class TestGeometry(unittest.TestCase):
    def test_flip_rect_moves_the_origin_to_the_bottom_left(self):
        # A box 100pt from the top of a 792pt page ends 692pt from the bottom (D-3).
        self.assertEqual(flip_rect([72, 100, 300, 200], 792, pad=0), [72.0, 592.0, 300.0, 692.0])

    def test_padding_grows_the_box_on_every_side(self):
        self.assertEqual(flip_rect([72, 100, 300, 200], 792, pad=2), [70.0, 590.0, 302.0, 694.0])

    def test_no_padding_by_default(self):
        # The box means exactly what it covers; the app adds its own breathing room when
        # it draws, and padding at both ends used to spill into the neighbouring problem.
        self.assertEqual(flip_rect([72, 100, 300, 200], 792), [72.0, 592.0, 300.0, 692.0])


class TestContentTop(unittest.TestCase):
    """Where a problem's box starts, when maths sits above the line introducing it."""

    def rect(self, y0, y1, x0=64.0, x1=300.0):
        return [x0, y0, x1, y1]

    def test_adopts_a_row_sitting_just_above_its_own_line(self):
        # A cross product prints "i j k" above the text saying "u x v =".
        line = Line(text="u x v =", rect=self.rect(142, 153, x0=86), size=10.0)
        column = [self.rect(100, 111), self.rect(127, 138, x0=117), line.rect]
        self.assertLess(content_top(line, column), 130)

    def test_takes_in_maths_set_around_its_own_label(self):
        # A braced system starts above the "27." that labels it and ends below.
        line = Line(text="27.", rect=self.rect(106, 117, x0=64), size=10.0)
        system = self.rect(99, 125, x0=92)
        column = [self.rect(70, 84), system, line.rect]
        self.assertLessEqual(content_top(line, column), 99)

    def test_leaves_a_labelled_part_with_the_problem_above(self):
        # "h. ..." belongs to the problem it is a part of, however close the next one is.
        line = Line(text="28. Which of the following", rect=self.rect(671, 680, x0=54), size=9.0)
        part = self.rect(651, 667, x0=70)
        column = [self.rect(629, 638, x0=70), part, line.rect]
        blocked = frozenset({tuple(part)})
        self.assertGreater(content_top(line, column, 0.0, blocked), 667)

    def test_leaves_a_wrapped_line_with_the_problem_it_wraps_from(self):
        # "30. Compute ... What can you conclude" / "about the associativity ..." - the
        # second line belongs to 30, though it sits closer to 31 underneath it.
        first = self.rect(252, 262, x0=330)
        wrap = self.rect(264, 273, x0=346)
        line = Line(text="31. Let u, v, and w", rect=self.rect(278, 287, x0=330), size=9.0)
        column = [first, wrap, line.rect]
        self.assertGreater(content_top(line, column, limit=first[3]), 273)

    def test_subpart_pattern(self):
        for text in ("a. u . v", "h. (u x v) . w", "c) something"):
            self.assertTrue(SUBPART_LABEL.match(text), text)
        for text in ("i", "27. Which", "and so on"):
            self.assertFalse(SUBPART_LABEL.match(text), text)


class TestInstructionSpan(unittest.TestCase):
    """Which exercises does a shared instruction introduce? (D-3.)"""

    def test_dashed_ranges(self):
        self.assertEqual(instruction_span("In Exercises 37-40, use the result"), (37, 40))
        self.assertEqual(instruction_span("In Exercises 37–40, use the result"), (37, 40))
        self.assertEqual(
            instruction_span("Find the angles between the vectors in Exercises 9-12"), (9, 12)
        )

    def test_a_pair_may_be_joined_by_a_word(self):
        self.assertEqual(instruction_span("In Exercises 25 and 26, find the torque"), (25, 26))
        self.assertEqual(instruction_span("Exercises 25 & 26 ask for"), (25, 26))

    def test_a_list_is_not_a_range(self):
        # "1, 3, and 5" names three exercises, not everything from 1 to 3.
        self.assertIsNone(instruction_span("In Exercises 1, 3, and 5 do something"))

    def test_reads_a_range_split_across_a_line_break(self):
        # "...joining the points in Exer-" / "cises 13-20. Draw coordinate axes..."
        joined = rejoin_hyphenated(
            "Find parametrizations for the line segments joining the points in Exer-",
            "cises 13-20. Draw coordinate axes and sketch each segment,",
        )
        self.assertEqual(instruction_span(joined), (13, 20))

    def test_rejoin_needs_a_hyphen(self):
        self.assertEqual(rejoin_hyphenated("no hyphen here", "cises 13-20"), "")

    def test_rejects_nonsense(self):
        self.assertIsNone(instruction_span("no range here"))
        self.assertIsNone(instruction_span("In Exercises 40-37, backwards"))


class TestColumnMargins(unittest.TestCase):
    def line(self, x0, x1=500.0, y=100.0):
        return Line(text="x", rect=[x0, y, x1, y + 10], size=10.0)

    def test_single_column(self):
        lines = [self.line(64) for _ in range(10)]
        self.assertEqual(column_margins(lines, 595), [64.0])

    def test_finds_a_second_column(self):
        lines = [self.line(64) for _ in range(8)] + [self.line(306) for _ in range(8)]
        self.assertEqual(column_margins(lines, 611), [64.0, 306.0])

    def test_ignores_scattered_fragments(self):
        # A page of dense maths: fragments start all over, but none of them repeat.
        lines = [self.line(64) for _ in range(8)] + [
            self.line(x) for x in (312, 348, 371, 402, 447)
        ]
        self.assertEqual(column_margins(lines, 595), [64.0])

    def test_prefers_the_leftmost_supported_cluster_over_the_busiest(self):
        # Indented sub-parts ("a.", "b.", ...) outnumber the lines at the column's margin.
        lines = [self.line(64) for _ in range(8)] + [self.line(306) for _ in range(4)]
        lines += [self.line(322) for _ in range(9)]
        self.assertEqual(column_margins(lines, 611), [64.0, 306.0])


class TestRuns(unittest.TestCase):
    def numbers(self, runs):
        return [[c.number for c in run] for run in runs]

    def test_consecutive_numbering_is_one_run(self):
        runs = build_runs([candidate(n, 1) for n in (1, 2, 3, 5, 9)])
        self.assertEqual(self.numbers(runs), [[1, 2, 3, 5, 9]])

    def test_a_restart_breaks_the_run(self):
        runs = build_runs([candidate(n, 1) for n in (70, 71, 72, 1, 2)])
        self.assertEqual(self.numbers(runs), [[70, 71, 72], [1, 2]])

    def test_a_large_forward_jump_breaks_the_run(self):
        runs = build_runs([candidate(n, 1) for n in (1, 2, 40, 41)])
        self.assertEqual(self.numbers(runs), [[1, 2], [40, 41]])


class TestAttributeRuns(unittest.TestCase):
    """Which section does a run of solutions belong to? (The manual, D-3/D-4.)"""

    def attribute(self, runs, own_head, sequence):
        report = ScanReport()
        placed = attribute_runs(runs, own_head, sequence, report)
        return [(f"{s[0]}.{s[1]}", c.number) for s, c in placed], report

    def test_a_restart_moves_to_the_section_named_on_the_page(self):
        runs = build_runs(
            [candidate(n, 8) for n in (70, 71, 72)] + [candidate(n, 9) for n in (1, 2, 3)]
        )
        placed, _ = self.attribute(runs, {8: (1, "1"), 9: (1, "2")}, [(1, "1"), (1, "2")])
        self.assertEqual(
            placed, [("1.1", 70), ("1.1", 71), ("1.1", 72), ("1.2", 1), ("1.2", 2), ("1.2", 3)]
        )

    def test_a_headless_page_continues_the_section_before_it(self):
        runs = build_runs([candidate(n, 8) for n in (10, 11)] + [candidate(n, 9) for n in (12, 13)])
        placed, _ = self.attribute(runs, {8: (1, "1")}, [(1, "1")])
        self.assertEqual([s for s, _ in placed], ["1.1"] * 4)

    def test_interleaved_columns_stay_in_one_section(self):
        # The manual sets odd solutions in the left column and even in the right, so the
        # numbers dip back partway through the page without a section having changed.
        runs = build_runs(
            [candidate(n, 8) for n in (15, 17, 19, 21, 23)]
            + [candidate(n, 8) for n in (16, 18, 20)]
        )
        placed, report = self.attribute(runs, {8: (1, "1")}, [(1, "1"), (1, "2")])
        self.assertEqual({s for s, _ in placed}, {"1.1"})
        self.assertEqual(report.dropped, 0)

    def test_a_lone_low_number_is_dropped_as_a_fragment(self):
        runs = build_runs(
            [candidate(n, 8) for n in range(1, 15)]
            + [candidate(1, 8)]
            + [candidate(n, 9) for n in (15, 16, 17)]
        )
        placed, report = self.attribute(runs, {8: (1, "1")}, [(1, "1"), (1, "2")])
        self.assertEqual(report.dropped, 1)
        self.assertEqual([n for _s, n in placed], list(range(1, 15)) + [15, 16, 17])

    def test_chapter_review_exercises_are_dropped_not_mis_filed(self):
        # "Chapter 1 Practice Exercises" names no section, and sits past the last page
        # that claimed one. Filing it under the previous section would be a lie.
        runs = build_runs(
            [candidate(n, 8) for n in (10, 11, 12)] + [candidate(n, 20) for n in (1, 2, 3)]
        )
        placed, report = self.attribute(runs, {8: (1, "6")}, [(1, "6")])
        self.assertEqual([n for _s, n in placed], [10, 11, 12])
        self.assertEqual(report.dropped, 3)


class TestPageRanges(unittest.TestCase):
    def test_forms(self):
        self.assertEqual(list(parse_page_range(None, 3)), [0, 1, 2])
        self.assertEqual(list(parse_page_range("0-1", 5)), [0, 1])
        self.assertEqual(list(parse_page_range("2", 5)), [2])
        self.assertEqual(list(parse_page_range("3-99", 5)), [3, 4])

    def test_rejects_nonsense(self):
        with self.assertRaises(SystemExit):
            parse_page_range("a-b", 5)


class TestIndexAssembly(unittest.TestCase):
    def setUp(self):
        self.text = {
            "12.3.7": [{"page": 187, "bbox": [1, 2, 3, 4]}],
            "12.3.8": [{"page": 187, "bbox": [1, 2, 3, 4]}, {"page": 188, "bbox": [1, 2, 3, 4]}],
        }
        self.solutions = {"12.3.7": [{"page": 42, "bbox": [5, 6, 7, 8]}]}

    def test_single_region_collapses_and_spans_stay_lists(self):
        index = build_index("Thomas, 13th ed", self.text, self.solutions)
        self.assertEqual(index["book"], "Thomas, 13th ed")
        self.assertEqual(index["problems"]["12.3.7"]["text"], {"page": 187, "bbox": [1, 2, 3, 4]})
        self.assertEqual(len(index["problems"]["12.3.8"]["text"]), 2)

    def test_a_problem_without_a_solution_simply_omits_it(self):
        index = build_index("Book", self.text, self.solutions)
        self.assertNotIn("solution", index["problems"]["12.3.8"])

    def test_coverage_note_counts_both_sides(self):
        note = coverage_note(build_index("Book", self.text, self.solutions))
        self.assertIn("2 keys", note)
        self.assertIn("1 problems have no solution region", note)


class TestMergeOverrides(unittest.TestCase):
    def test_override_wins_field_by_field(self):
        base = {"book": "Book", "problems": {"12.3.7": {"text": {"page": 1, "bbox": [0, 0, 1, 1]}}}}
        overrides = {
            "problems": {
                "12.3.7": {"solution": {"page": 9, "bbox": [2, 2, 3, 3]}},
                "12.9.1": {"text": {"page": 5, "bbox": [4, 4, 5, 5]}},
            }
        }
        merged, changed = merge_overrides(base, overrides)
        self.assertEqual(merged["problems"]["12.3.7"]["text"], {"page": 1, "bbox": [0, 0, 1, 1]})
        self.assertEqual(merged["problems"]["12.3.7"]["solution"]["page"], 9)
        self.assertIn("12.9.1", merged["problems"])
        self.assertEqual(sorted(changed), ["12.3.7", "12.9.1"])

    def test_merging_nothing_changes_nothing(self):
        base = {"book": "Book", "problems": {"12.3.7": {"text": {"page": 1, "bbox": [0, 0, 1, 1]}}}}
        merged, changed = merge_overrides(base, {"problems": {}})
        self.assertEqual(changed, [])
        self.assertEqual(merged["problems"], base["problems"])


if __name__ == "__main__":
    unittest.main()
