# IDD-PSET

A single-page workbench for grinding through assigned textbook problems: enter the
assignment, see each problem rendered from the textbook PDF, work it on paper, reveal the
matching solution from the manual, and mark yourself.

[IDD-PSET.md](IDD-PSET.md) is the source of truth. Every module here cites the decision it
implements; if you change behaviour, change the decision first.

## Getting started

```sh
npm install          # also copies pdf.js cmaps + fonts into public/pdfjs (D-13)
npm run dev          # http://localhost:5173
```

On first load, open **Settings** and pick the two PDFs. They are stored in this browser's
Origin Private File System (IndexedDB if OPFS is unavailable) and never uploaded — there is
no server to upload them to (C1, C2, D-2).

## The loop

1. **Assignments** — paste the assignment as the course writes it: `12.3: 1, 5-9`,
   `Section 12.3`, `§12.3 #7`, `12.3.7`, `12.3: 1-15 odd`, one per line. The parser
   normalizes to canonical keys and shows anything it could not read instead of dropping
   it (D-5).
2. **Workspace** — the problem renders from the textbook; work it on paper; the solution
   stays hidden until you mark the problem attempted or explicitly reveal it (D-9).
   Verdicts (correct / partial / incorrect) are yours to set — nothing is auto-graded.
   Answers are not recorded, by ruling; there is one optional note field per problem.
3. **Review** — the whole assignment with solutions open and statuses editable. Prints.
4. **Study** — pick a chapter and draw a problem at random from those with a worked
   solution that no assignment has ever set (P-8). Each draw is recorded under
   "Study — chapter N", so nothing comes round twice and the attempts export like any
   other.
5. **Settings** — PDFs, page offsets, export/import, override export.

A key marked `*` in the problem list is not in `index.json`: the workspace shows the page
with a stepper, you drag a box around the problem, and the region is saved as a local
override you can export and merge (D-8). Any problem, indexed or not, has a **Fix this
region** control for the same purpose — the scan still places some boxes badly on pages
of stacked fractions (P-9).

## Building the index

`index.json` is the only book-derived artifact in the repo, and it holds locations only —
page indices and boxes, never text (C2, D-3).

```sh
pip install pymupdf
python tools/build_index.py \
    --textbook book.pdf --solutions manual.pdf \
    --book "Author, Title, 4th ed" --pattern bare \
    -o index.draft.json
```

Review the draft, fix what the regex got wrong, and commit it as `index.json`. The app
never builds an index itself (D-4). `--pattern bare` is the right one for this book:
problems restart at 1 each chapter, and the chapter comes from running "Chapter N"
headings. `--pattern chapter-dot` suits books printed as `3.14`; `--regex` takes your own
pattern with `chapter`/`number`/`suffix` groups.

To fold an override export back in:

```sh
python tools/build_index.py --merge index.json index.overrides.json -o index.json
```

**Keys.** A key is the dotted path to the problem plus an optional letter suffix:
`12.3.7` for a book numbered per section (Thomas), `3.14` for one numbered per chapter.

**Shared instructions.** Thomas states a question once above a run of problems ("Find the
angles between the vectors in Exercises 9-12...") and prints only the data under each
number. The builder captures that instruction as its own region and attaches it to every
problem in its range, so the workspace shows the question and the data together.

**Page offsets** (D-6): the app ships with the offsets for these copies already set -
textbook **-13**, manual **-5** - because it is built around this one pair of PDFs.
Settings overrides them if you ever swap in a different scan.

**Coordinates.** `page` is a 0-based PDF page index. `bbox` is `[x0, y0, x1, y1]` in PDF
user space: origin bottom-left, y upward, points. PyMuPDF's top-left rects are flipped once
in `flip_rect`, so what the tool writes is what pdf.js reads.

## Tests

```sh
npm test              # assignment parser (D-14)
npm run test:py       # problem-number regex, geometry, merge (D-14)
npm run build         # typecheck + production build
```

The Python tests import only the pure parts of `build_index.py`, so they run without
PyMuPDF installed. PDF rendering is verified by hand against the P1 checklist, not by unit
tests (D-14).

## Deploying

Push to `main`: [.github/workflows/pages.yml](.github/workflows/pages.yml) runs the tests,
builds, and publishes `dist/` to GitHub Pages (D-1). Enable Pages with source "GitHub
Actions" once. The build uses a relative base, so it works at
`<user>.github.io/<repo>/` without configuration.

The PDFs are gitignored by pattern (`*.pdf`) and the site makes no external network calls
at runtime — the pdf.js worker and font assets ship with it (D-13).

## Layout

```
index.json                 committed index, hand-corrected (D-3)
tools/build_index.py       draft generator, local only (D-4)
src/pdf/store.ts           OPFS / IndexedDB PDF persistence (D-2)
src/pdf/render.ts          bbox -> canvas, text extraction (D-7)
src/index/load.ts          index + local overrides merged at load (D-3, D-8)
src/parse/assignment.ts    assignment notation -> canonical keys (D-5)
src/state/db.ts            assignments, attempts, settings, overrides (D-9, D-10)
src/views/                 the four views (D-12)
```
