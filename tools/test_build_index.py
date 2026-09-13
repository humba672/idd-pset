"""D-14: unit tests for the problem-number regex against sample strings.

These exercise the pure parts of build_index.py only, so they run without PyMuPDF
installed (the `import fitz` in scan_pdf is deliberately lazy).

    python -m unittest discover -s tools -p 'test_*.py'
"""

import unittest

from build_index import (
    build_index,
    compile_pattern,
    coverage_note,
    flip_rect,
    match_problem,
    merge_overrides,
    normalize_key,
    parse_page_range,
    sort_key,
)

CHAPTER_DOT = compile_pattern("chapter-dot")
BARE = compile_pattern("bare")


class TestChapterDotPattern(unittest.TestCase):
    def test_recognizes_the_common_forms(self):
        cases = {
            "3.14 A block slides down a ramp.": "3.14",
            "3.14. A block slides down a ramp.": "3.14",
            "3.14) A block slides down a ramp.": "3.14",
            "3.14a Find the acceleration.": "3.14a",
            "10.7 Show that the series converges.": "10.7",
            "  3.14  leading whitespace is fine": "3.14",
        }
        for line, expected in cases.items():
            with self.subTest(line=line):
                self.assertEqual(match_problem(line, CHAPTER_DOT), expected)

    def test_rejects_lines_that_merely_start_with_a_number(self):
        for line in [
            "3.14159 is close enough for this problem.",
            "0.5 mol of an ideal gas",
            "Figure 3.14 shows the apparatus.",
            "Table 3.1 Thermodynamic data",
            "Example 3.14 Worked in the text.",
            "Section 3.14 Review",
            "A block of mass m slides down.",
            "",
            "   ",
        ]:
            with self.subTest(line=line):
                self.assertIsNone(match_problem(line, CHAPTER_DOT))

    def test_rejects_implausible_numbers(self):
        self.assertIsNone(match_problem("100.4 Not a chapter", CHAPTER_DOT))
        self.assertIsNone(match_problem("0.4 Not a problem", CHAPTER_DOT))


class TestBarePattern(unittest.TestCase):
    def test_needs_a_chapter_from_context(self):
        self.assertIsNone(match_problem("14. Find the flux.", BARE))
        self.assertEqual(match_problem("14. Find the flux.", BARE, chapter=3), "3.14")
        self.assertEqual(match_problem("14a) Find the flux.", BARE, chapter=3), "3.14a")

    def test_a_line_with_its_own_chapter_ignores_context(self):
        self.assertEqual(match_problem("3.14 Find the flux.", CHAPTER_DOT, chapter=9), "3.14")


class TestCustomRegex(unittest.TestCase):
    def test_named_groups_drive_the_key(self):
        pattern = compile_pattern(
            "chapter-dot",
            r"^Exercise\s+(?P<chapter>\d+)-(?P<number>\d+)(?P<suffix>[a-z])?\b",
        )
        self.assertEqual(match_problem("Exercise 3-14 Solve.", pattern), "3.14")
        self.assertEqual(match_problem("Exercise 3-14b Solve.", pattern), "3.14b")
        self.assertIsNone(match_problem("Exercise three", pattern))


class TestKeysAndSorting(unittest.TestCase):
    def test_normalize_key(self):
        self.assertEqual(normalize_key(3, 14), "3.14")
        self.assertEqual(normalize_key("03", "014", "A"), "3.14a")

    def test_sorts_numerically_then_by_suffix(self):
        keys = ["10.1", "3.2a", "3.16", "3.2"]
        self.assertEqual(sorted(keys, key=sort_key), ["3.2", "3.2a", "3.16", "10.1"])


class TestGeometry(unittest.TestCase):
    def test_flip_rect_moves_the_origin_to_the_bottom_left(self):
        # A box 100pt from the top of a 792pt page ends 692pt from the bottom (D-3).
        bbox = flip_rect([72, 100, 300, 200], 792, pad=0)
        self.assertEqual(bbox, [72.0, 592.0, 300.0, 692.0])

    def test_padding_grows_the_box_on_every_side(self):
        bbox = flip_rect([72, 100, 300, 200], 792, pad=2)
        self.assertEqual(bbox, [70.0, 590.0, 302.0, 694.0])


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
            "3.14": [{"page": 187, "bbox": [1, 2, 3, 4]}],
            "3.15": [{"page": 187, "bbox": [1, 2, 3, 4]}, {"page": 188, "bbox": [1, 2, 3, 4]}],
        }
        self.solutions = {"3.14": [{"page": 42, "bbox": [5, 6, 7, 8]}]}

    def test_single_region_collapses_and_spans_stay_lists(self):
        index = build_index("Book, 4th ed", self.text, self.solutions)
        self.assertEqual(index["book"], "Book, 4th ed")
        self.assertEqual(index["problems"]["3.14"]["text"], {"page": 187, "bbox": [1, 2, 3, 4]})
        self.assertEqual(len(index["problems"]["3.15"]["text"]), 2)

    def test_a_problem_without_a_solution_simply_omits_it(self):
        # Q2: the manual may cover only a subset; the app treats a missing key as such.
        index = build_index("Book", self.text, self.solutions)
        self.assertNotIn("solution", index["problems"]["3.15"])

    def test_coverage_note_counts_both_sides(self):
        note = coverage_note(build_index("Book", self.text, self.solutions))
        self.assertIn("2 keys", note)
        self.assertIn("1 problems have no solution region", note)


class TestMergeOverrides(unittest.TestCase):
    def test_override_wins_field_by_field(self):
        base = {
            "book": "Book",
            "problems": {"3.14": {"text": {"page": 1, "bbox": [0, 0, 1, 1]}}},
        }
        overrides = {
            "problems": {
                "3.14": {"solution": {"page": 9, "bbox": [2, 2, 3, 3]}},
                "3.99": {"text": {"page": 5, "bbox": [4, 4, 5, 5]}},
            }
        }
        merged, changed = merge_overrides(base, overrides)
        self.assertEqual(merged["problems"]["3.14"]["text"], {"page": 1, "bbox": [0, 0, 1, 1]})
        self.assertEqual(merged["problems"]["3.14"]["solution"]["page"], 9)
        self.assertIn("3.99", merged["problems"])
        self.assertEqual(sorted(changed), ["3.14", "3.99"])

    def test_merging_nothing_changes_nothing(self):
        base = {"book": "Book", "problems": {"3.14": {"text": {"page": 1, "bbox": [0, 0, 1, 1]}}}}
        merged, changed = merge_overrides(base, {"problems": {}})
        self.assertEqual(changed, [])
        self.assertEqual(merged["problems"], base["problems"])


if __name__ == "__main__":
    unittest.main()
