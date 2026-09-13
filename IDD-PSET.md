# IDD-PSET: Textbook Problem-Set Workbench

Status: Draft v0.1, 2026-09-13
Owner: Rajiv
Methodology: Intent-Driven Development. This document is the source of truth; code is the compiled artifact. Any behavior not traceable to a numbered decision here is a bug or a proposal, not a feature.

## 1. Intent

A single-page web app, hosted on GitHub Pages, that lets one person work through assigned textbook problems: enter the assignment (chapter, page range, problem numbers), see each problem pulled from the textbook PDF, record an answer, and when done, reveal the matching solution from the solution-manual PDF and mark the attempt right or wrong by hand. Progress persists between sessions.

The app exists to remove friction from the loop "find the problem, work it, find the solution, compare." It does not attempt to judge answers.

## 2. Non-goals

- No LLM or automated grading. The user compares against the manual and records the verdict.
- No backend, accounts, or sync. Single user, single browser, local storage.
- No redistribution of the PDFs. They are never committed, uploaded, or served.
- No general-purpose PDF reader. Only the views needed for the loop above.
- No support for scanned or image-only PDFs in v1.

## 3. Constraints

- C1: GitHub Pages is static hosting. All logic runs in the browser.
- C2: Textbook and solution manual are copyrighted. The repo may contain only user-authored data (index, notes, progress exports), never book content.
- C3: Both PDFs are text-based (confirmed). Extraction quality is still uneven for math and figures; the design must tolerate that.
- C4: Assignments arrive as chapter plus page range plus problem numbers, in whatever notation the course uses. Input parsing must be forgiving.

## 4. Decisions

D-1 Hosting and stack. Static site deployed to GitHub Pages from a `dist/` build via GitHub Actions. Vite plus vanilla TypeScript (no framework) unless a later decision changes this. pdf.js for all PDF work.

D-2 PDFs stay local. On first use the app asks the user to pick the textbook PDF and the solution-manual PDF. Files are stored in the browser's Origin Private File System (fallback: IndexedDB as a Blob) and reloaded on subsequent visits. A "replace PDF" control exists in settings. The PDFs are gitignored by name pattern (`*.pdf`) as a belt-and-braces measure.

D-3 The index is the only book-derived artifact in the repo. `index.json` maps each problem key to textbook and solution locations:

```
{
  "book": "<title, edition>",
  "problems": {
    "3.14": {
      "text": { "page": 187, "bbox": [x0, y0, x1, y1] },
      "solution": { "page": 42, "bbox": [x0, y0, x1, y1] }
    }
  }
}
```

Pages are PDF page indices (0-based), not printed page numbers. `bbox` is in PDF user-space units. A problem that spans pages stores a list of `{page, bbox}` entries. The index contains no text from either book.

D-4 Index construction is a separate tool. A Python script (`tools/build_index.py`, PyMuPDF) scans both PDFs for problem-number patterns and emits a draft `index.json`. The draft is reviewed and hand-corrected; the corrected file is committed. The app never builds the index itself. The script is run locally and is not part of the deployed site.

D-5 Problem key format. Canonical key is `<chapter>.<number>` with optional letter suffix (`3.14`, `3.14a`). The assignment parser accepts common inputs and normalizes to canonical keys: `3.14, 3.16-3.20, 3.22a`, `Ch 3: 14, 16-20`, one per line, etc. Unrecognized fragments are shown back to the user for correction rather than silently dropped.

D-6 Printed-page to PDF-page offset. Settings holds one integer offset per PDF (printed page = PDF page + offset). Used only to help the user navigate when a problem is missing from the index; the index itself always uses PDF page indices.

D-7 Display uses rendered images, not extracted text. Each problem and solution is shown as a canvas rendering of its `bbox` region at readable resolution. Extracted text is not shown by default. Rationale: C3; math and figures survive rendering and not extraction. A "show extracted text" toggle exists for copy-paste convenience and is labeled as best-effort.

D-8 Missing-index fallback. If an assignment references a key not in the index, the app shows the full textbook page nearest to the user's stated page range (using D-6) with a page stepper, plus a control to "mark this region as problem X" that draws a bbox and writes it into a local index-override store. Overrides are exportable as JSON so they can be merged into the committed `index.json`.

D-9 Assignment lifecycle. An assignment is `{id, title, created, keys[]}`. Each key within an assignment has an attempt record `{answer, status, notes, updated}` where `status` is one of `unattempted | attempted | correct | incorrect | partial`. Solutions are hidden until the user marks the problem `attempted` (or explicitly reveals). Revealing does not change status; the user sets `correct/incorrect/partial` by hand.

D-10 Persistence. Assignments, attempts, settings, and index overrides live in IndexedDB under a single versioned store. Export and import of the entire store as one JSON file is a first-class feature; this is the only backup mechanism.

D-11 Answer capture. The answer field is plain text (textarea). Optional attachment of a photo of handwritten work is deferred (see Open Questions).

D-12 Views. Exactly four: Assignments list, Assignment workspace (problem list on the left, current problem render and answer field on the right, solution panel collapsed), Review (same assignment with all solutions revealed and statuses editable), Settings (PDF pickers, page offsets, export/import, index-override export).

D-13 No analytics, no external network calls at runtime. The site loads its own assets and nothing else. pdf.js worker is bundled, not fetched from a CDN.

D-14 Testing. The index-building script has unit tests on the problem-number regex against sample strings. The assignment parser (D-5) has unit tests. PDF rendering is verified manually against a checklist in P1 acceptance; it is not unit tested in v1.

## 5. Architecture (compiled from decisions)

```
repo/
  index.json                 (D-3, committed, hand-corrected)
  tools/build_index.py       (D-4, local only)
  tools/test_build_index.py  (D-14)
  src/
    main.ts
    pdf/store.ts             (D-2: OPFS/IndexedDB persistence of PDF blobs)
    pdf/render.ts            (D-7: bbox to canvas)
    index/load.ts            (D-3 plus D-8 overrides merged at load)
    parse/assignment.ts      (D-5)
    state/db.ts              (D-10)
    views/*.ts               (D-12)
  .github/workflows/pages.yml
  .gitignore                 (*.pdf)
```

## 6. Phases

P0 Scaffold. Vite project, Pages workflow deploying to `<user>.github.io/<repo>`, PDF pickers persisting to OPFS, render a chosen PDF page to canvas. Acceptance: reload the site, both PDFs are still there, page 1 of each renders.

P1 Index. `build_index.py` produces a draft for one chapter of each PDF; hand-correct; app renders problem and solution regions for that chapter from `index.json`. Acceptance: pick five problems from the chapter, all five render legibly with the correct solution paired; document the regex miss rate observed.

P2 Workflow. Assignment parser, assignment workspace, attempt statuses, solution reveal gating, IndexedDB persistence, export/import. Acceptance: create an assignment from the course's actual notation, work three problems end to end, close the browser, reopen, state intact; export, wipe storage, import, state intact.

P3 Coverage and fallback. Run the index script on the full books, hand-correct, commit. Implement D-8 fallback and override export. Acceptance: an assignment containing a deliberately un-indexed key is workable via fallback, and the override merges cleanly into `index.json`.

P4 Polish (optional). Keyboard navigation between problems, print view of an assignment with statuses, dark mode.

## 7. Open questions (need Rajiv's ruling before P1)

Q1 Subject and title/edition of the textbook. Affects the problem-number regex and whether problems use `chapter.number`, `number` only per chapter, or named exercises.

Q2 Does the solution manual cover every problem, or a subset (e.g. odd-numbered)? If subset, D-9 needs a `no-solution` marker so those problems skip the reveal step.

Q3 Answer capture: is plain text enough, or should attempts allow a photo of handwritten work (stored as a Blob in IndexedDB)? Default if no ruling: plain text, photo deferred to P4.

Q4 Repo visibility. Public is fine under C2 since no book content is committed; confirm, or state a reason for private.

Q5 Browser. OPFS support is solid in current Chrome and Edge, and in Safari and Firefox recent versions. If a specific browser is required, P0 verifies it first.

## 8. Ledger

Decision changes are appended here with date and reason. D-numbers are never reused.

- 2026-09-13 v0.1 drafted. D-1 to D-14 proposed, none yet ratified.
- 2026-09-13 P0-P3 built against v0.1. The following came up in the build and are
  **proposals**, not ratified decisions: they are implemented, and each needs a ruling
  (or a reversal) before it counts as a decision.

  - P-1 (clarifies D-3) `bbox` origin. D-3 says "PDF user-space units" without fixing the
    origin. Implemented as origin bottom-left, y upward, points - pdf.js's own convention -
    with the flip from PyMuPDF's top-left rects done once, in `tools/build_index.py`.
  - P-2 (extends D-8) A region marked by hand can be re-marked. Without it a mis-drawn box
    is permanent, and D-8 is the recovery path for a bad index.
  - P-3 (extends D-8, answers Q2 provisionally) A problem whose solution is not in the
    index shows "no solution indexed" plus the same region picker pointed at the manual,
    so a subset-coverage manual is workable without a `no-solution` marker. If Q2 comes
    back "subset", the marker in Q2 is still the better answer for problems the manual
    genuinely omits.
  - P-4 (extends D-5) The parser keeps page references (`pp. 180-190`) as a hint on the
    assignment rather than reporting them as unrecognized fragments. The hint seeds the
    D-8 fallback's opening page via the D-6 offset.
  - P-5 (serves D-13) pdf.js cmaps and standard fonts are copied from node_modules into
    `public/pdfjs/` at install time. Generated, gitignored, shipped in `dist/` - the site
    still fetches nothing from a CDN.

  The problem-number pattern is a `--pattern` / `--regex` flag on the tool rather than a
  constant, so Q1 is answerable without touching code.

- 2026-09-13 Rajiv ruled on Q1-Q4. Q5 (browser) is still open and needs no ruling: the
  OPFS path is probed at runtime and falls back to IndexedDB on its own.

  - Q1 answered: problems are numbered bare, restarting each chapter. Keys are still
    canonical `<chapter>.<number>` (D-5 unchanged); the builder runs with
    `--pattern bare` and takes the chapter from running "Chapter N" headings.
  - Q2 answered: the manual covers every problem. No `no-solution` marker is needed.
    A gap found while indexing is therefore an index bug, not a coverage gap - the
    builder's coverage report is the place to catch it. P-3's picker stays as a repair
    path, not an expected step.
  - Q3 answered, superseding D-11: answers are not captured at all. The work happens on
    paper. An attempt record is `{status, notes, revealed, updated}` - the verdict, plus
    an optional one-line note worth reading back at review time. No textarea, no photo.
  - Q4 answered: public repo. Nothing book-derived is committed (C2), so Pages is free
    and no private-Pages plan is needed.

- 2026-09-13 The books arrived (Thomas' Calculus: Early Transcendentals, 13th ed, and its
  instructor solutions manual), and the first scan of them forced one decision change and
  produced several findings. The change is a **proposal** until Rajiv rules:

  - P-6 (amends D-5) **Keys carry the section.** Thomas numbers exercises per section,
    not per chapter: section 1.1 has problems 1-72 and so does 1.2, so D-5's
    `<chapter>.<number>` cannot tell 1.1's problem 5 from 1.2's. A canonical key is now
    the dotted path to the problem plus an optional letter suffix - three parts for a
    book numbered per section (`12.3.7`, `12.3.7a`), two for one numbered per chapter
    (`3.14`), which keeps every example in D-5 valid. The parser accepts `12.3: 1, 5-9`,
    `Section 12.3`, `§12.3 #7`, `12.3.7`, and a trailing `odd`/`even` on a range, since
    that is how calculus assignments are written.

  Findings, for the record:

  - Q1's answer was nearly right: numbering is bare and restarts, but per *section*.
  - Q2 confirmed by inspection: this is the instructor's manual, and it solves
    even-numbered exercises, so coverage is genuinely complete.
  - The file named "Multivariable" is the whole book: chapters 1-16 in both PDFs.
  - Printed page = PDF page - 13 in the textbook and - 5 in the manual (D-6 offsets).
  - Chapter review sets ("Chapter 1 Practice Exercises") belong to no section and are
    deliberately left out of the index; anything assigned from them is workable through
    the D-8 fallback. Indexing them needs a key form D-5 does not yet have.
