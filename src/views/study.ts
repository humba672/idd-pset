// P-8 (amends D-12): a fifth view. Draw a problem from a chapter that no assignment has
// ever covered, work it, reveal the solution, mark it - the loop of Section 1, but with
// the app choosing the problem instead of a course.
//
// A drawn problem is appended to a study assignment for its chapter. That is what keeps
// the promise of "nothing you have already had": a problem, once drawn, appears in an
// assignment and so is out of the pool. It also means attempts, review, export and
// import (D-9, D-10) go on working exactly as they do for a real assignment.

import {
  STORE_ASSIGNMENTS,
  getAll,
  loadAttempt,
  loadSettings,
  newId,
  put,
  type Assignment,
} from '../state/db'
import { loadIndex, resolveProblem } from '../index/load'
import { compareKeys, parseKey } from '../parse/assignment'
import { problemPane } from './workspace'
import { clear, el, toast } from './dom'

const STUDY_PREFIX = 'Study'

export function studyTitle(chapter: string): string {
  return `${STUDY_PREFIX} — chapter ${chapter}`
}

export function chapterOf(key: string): string | null {
  const parsed = parseKey(key)
  return parsed ? String(parsed.parts[0]) : null
}

/**
 * The problems worth drawing: in this chapter, carrying both a problem and a worked
 * solution, and named by no assignment - study assignments included, which is what stops
 * a problem coming round twice.
 */
export function eligibleKeys(
  solvable: string[],
  used: ReadonlySet<string>,
  chapter: string,
): string[] {
  return solvable
    .filter((key) => chapterOf(key) === chapter && !used.has(key))
    .sort(compareKeys)
}

export function pickOne(keys: string[], random: () => number = Math.random): string | null {
  if (!keys.length) return null
  return keys[Math.floor(random() * keys.length)] ?? null
}

async function studyAssignment(chapter: string): Promise<Assignment> {
  const assignments = await getAll<Assignment>(STORE_ASSIGNMENTS)
  const existing = assignments.find((a) => a.title === studyTitle(chapter))
  if (existing) return existing
  const created: Assignment = {
    id: newId(),
    title: studyTitle(chapter),
    created: new Date().toISOString(),
    keys: [],
  }
  await put(STORE_ASSIGNMENTS, created)
  return created
}

export async function renderStudy(root: HTMLElement): Promise<void> {
  const [index, assignments, settings] = await Promise.all([
    loadIndex(),
    getAll<Assignment>(STORE_ASSIGNMENTS),
    loadSettings(),
  ])

  const used = new Set(assignments.flatMap((a) => a.keys))
  const solvable = Object.entries(index.problems)
    .filter(([, entry]) => entry.text && entry.solution)
    .map(([key]) => key)

  const chapters = [...new Set(solvable.map(chapterOf).filter(Boolean))].sort(
    (a, b) => Number(a) - Number(b),
  ) as string[]

  root.append(
    el('h1', { text: 'Study' }),
    el('p', {
      class: 'sub',
      text: 'Draw a problem you have not been set before, work it, then check it against the manual.',
    }),
  )

  if (!chapters.length) {
    root.append(
      el(
        'div',
        { class: 'card' },
        el('p', {
          class: 'muted',
          text: 'Nothing to draw from: index.json holds no problem with both a question and a solution. Build it with tools/build_index.py (D-4).',
        }),
      ),
    )
    return
  }

  const remembered = sessionStorage.getItem('study:chapter')
  let chapter = remembered && chapters.includes(remembered) ? remembered : chapters[0]!

  const picker = el('select', {}) as HTMLSelectElement
  const tally = el('span', { class: 'muted' })
  const drawButton = el('button', { class: 'primary', text: 'Draw a problem' })


  const countFor = (which: string) => eligibleKeys(solvable, used, which).length

  const refreshTally = () => {
    const left = countFor(chapter)
    const total = solvable.filter((key) => chapterOf(key) === chapter).length
    tally.textContent = `${left} of ${total} not yet set in any assignment`
    drawButton.disabled = left === 0
  }

  for (const value of chapters) {
    picker.append(
      el('option', {
        value,
        text: `Chapter ${value} (${countFor(value)} left)`,
        selected: value === chapter,
      }),
    )
  }
  picker.addEventListener('change', () => {
    chapter = picker.value
    sessionStorage.setItem('study:chapter', chapter)
    clear(problemHolder)
    actions.hidden = true
    refreshTally()
  })

  const problemHolder = el('div', {})
  const actions = el('div', { class: 'actions', style: 'margin-top:12px', hidden: true })

  const show = async (assignment: Assignment, key: string): Promise<void> => {
    const [problem, attempt] = await Promise.all([
      resolveProblem(key),
      loadAttempt(assignment.id, key),
    ])
    clear(problemHolder).append(
      problemPane(assignment, key, problem, attempt, settings, () => void show(assignment, key)),
    )
    clear(actions).append(
      el('button', { class: 'primary', text: 'Draw another', on: { click: () => void draw() } }),
      el('a', { href: `#/a/${assignment.id}` }, el('button', { text: 'Everything drawn so far' })),
    )
    actions.hidden = false
  }

  const draw = async (): Promise<void> => {
    const key = pickOne(eligibleKeys(solvable, used, chapter))
    if (!key) {
      refreshTally()
      return
    }
    // Record it before showing it: drawn is drawn, whether or not it gets worked, so the
    // same problem will not come round again.
    const assignment = await studyAssignment(chapter)
    if (!assignment.keys.includes(key)) {
      assignment.keys = [...assignment.keys, key]
      await put(STORE_ASSIGNMENTS, assignment)
    }
    used.add(key)
    refreshTally()
    await show(assignment, key)
  }

  drawButton.addEventListener('click', () => {
    void draw().catch((err: Error) => toast(err.message, 'error'))
  })

  refreshTally()
  root.append(
    el(
      'div',
      { class: 'card' },
      el('div', { class: 'row' }, el('div', { class: 'field' }, el('label', { text: 'Chapter' }), picker)),
      el('div', { class: 'field' }, tally),
      el('div', { class: 'actions' }, drawButton),
    ),
    problemHolder,
    actions,
  )
}
