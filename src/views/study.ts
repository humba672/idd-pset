// P-8 (amends D-12): a fifth view. Draw a practice set from a chapter - n problems from
// each of its sections, chosen at random from those no assignment has ever named.
//
// The set is saved as an assignment and opened in the workspace, so working it, marking
// it, reviewing it and exporting it (D-9, D-10, D-12) all happen exactly as they do for a
// set the course gave you. That is also what keeps the promise of "nothing you have
// already had": a drawn problem now belongs to an assignment, so it leaves the pool.

import {
  STORE_ASSIGNMENTS,
  getAll,
  newId,
  put,
  type Assignment,
} from '../state/db'
import { loadIndex } from '../index/load'
import { compareKeys, parseKey } from '../parse/assignment'
import { clear, el, toast } from './dom'

const DEFAULT_PER_SECTION = 3

export function chapterOf(key: string): string | null {
  const parsed = parseKey(key)
  return parsed ? String(parsed.parts[0]) : null
}

/** `12.3.7` -> `12.3`. A book numbered per chapter has no section: `3.14` -> `3`. */
export function sectionOf(key: string): string | null {
  const parsed = parseKey(key)
  if (!parsed) return null
  return parsed.parts.length >= 3 ? `${parsed.parts[0]}.${parsed.parts[1]}` : String(parsed.parts[0])
}

/**
 * The problems worth drawing: in this chapter, carrying both a problem and a worked
 * solution, and named by no assignment - study sets included, which is what stops a
 * problem coming round twice.
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

export function bySection(keys: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const key of keys) {
    const section = sectionOf(key)
    if (!section) continue
    out.set(section, [...(out.get(section) ?? []), key])
  }
  return new Map([...out].sort((a, b) => compareKeys(a[1][0]!, b[1][0]!)))
}

/** Takes `count` at random, without replacement. Fewer if there are fewer to take. */
export function sample(keys: string[], count: number, random: () => number = Math.random): string[] {
  const pool = [...keys]
  const take = Math.max(0, Math.min(count, pool.length))
  const picked: string[] = []
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(random() * (pool.length - i))
    ;[pool[i], pool[j]] = [pool[j]!, pool[i]!]
    picked.push(pool[i]!)
  }
  return picked
}

/**
 * n from every section of the chapter that still has anything to give. A section with
 * fewer than n left contributes what it has rather than being skipped: the point is
 * cover across the chapter, not an exact count.
 */
export function drawSet(
  solvable: string[],
  used: ReadonlySet<string>,
  chapter: string,
  perSection: number,
  random: () => number = Math.random,
): string[] {
  const out: string[] = []
  for (const [, keys] of bySection(eligibleKeys(solvable, used, chapter))) {
    out.push(...sample(keys, perSection, random))
  }
  return out.sort(compareKeys)
}

export function studyTitle(chapter: string, ordinal: number): string {
  return `Study — chapter ${chapter} #${ordinal}`
}

async function saveSet(chapter: string, keys: string[]): Promise<Assignment> {
  const assignments = await getAll<Assignment>(STORE_ASSIGNMENTS)
  const prefix = `Study — chapter ${chapter} #`
  const ordinal = assignments.filter((a) => a.title.startsWith(prefix)).length + 1
  const created: Assignment = {
    id: newId(),
    title: studyTitle(chapter, ordinal),
    created: new Date().toISOString(),
    keys,
  }
  await put(STORE_ASSIGNMENTS, created)
  return created
}

export async function renderStudy(root: HTMLElement): Promise<void> {
  const [index, assignments] = await Promise.all([
    loadIndex(),
    getAll<Assignment>(STORE_ASSIGNMENTS),
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
      text: 'Draw a practice set across a chapter: a few problems from each section, none of them ever set in an assignment.',
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
  let perSection = Number(sessionStorage.getItem('study:per-section')) || DEFAULT_PER_SECTION

  const picker = el('select', {}) as HTMLSelectElement
  const count = el('input', {
    type: 'number',
    min: '1',
    max: '20',
    value: String(perSection),
  })
  const breakdown = el('div', { class: 'muted' })
  const drawButton = el('button', { class: 'primary', text: 'Draw a set' })

  for (const value of chapters) {
    const left = eligibleKeys(solvable, used, value).length
    picker.append(
      el('option', { value, text: `Chapter ${value} (${left} unused)`, selected: value === chapter }),
    )
  }

  const refresh = () => {
    const sections = bySection(eligibleKeys(solvable, used, chapter))
    clear(breakdown)
    if (!sections.size) {
      breakdown.append(
        el('div', { text: `Every problem in chapter ${chapter} has been set at least once.` }),
      )
      drawButton.disabled = true
      return
    }
    const lines = [...sections].map(
      ([section, keys]) => `${section}: ${Math.min(perSection, keys.length)} of ${keys.length}`,
    )
    const total = [...sections].reduce(
      (sum, [, keys]) => sum + Math.min(perSection, keys.length),
      0,
    )
    breakdown.append(
      el('div', { text: `${sections.size} sections with problems left — ${lines.join(', ')}` }),
      el('div', {
        class: 'muted',
        text: 'A section with fewer left than you asked for gives what it has.',
      }),
    )
    drawButton.disabled = total === 0
    drawButton.textContent = `Draw ${total} problem${total === 1 ? '' : 's'}`
  }

  picker.addEventListener('change', () => {
    chapter = picker.value
    sessionStorage.setItem('study:chapter', chapter)
    refresh()
  })
  count.addEventListener('input', () => {
    perSection = Math.min(20, Math.max(1, Number(count.value) || DEFAULT_PER_SECTION))
    sessionStorage.setItem('study:per-section', String(perSection))
    refresh()
  })

  drawButton.addEventListener('click', async () => {
    const keys = drawSet(solvable, used, chapter, perSection)
    if (!keys.length) {
      refresh()
      return
    }
    const assignment = await saveSet(chapter, keys)
    toast(`Drew ${keys.length} problems from chapter ${chapter}.`)
    location.hash = `#/a/${assignment.id}`
  })

  refresh()
  root.append(
    el(
      'div',
      { class: 'card' },
      el(
        'div',
        { class: 'row' },
        el('div', { class: 'field' }, el('label', { text: 'Chapter' }), picker),
        el('div', { class: 'field' }, el('label', { text: 'Problems per section' }), count),
      ),
      el('div', { class: 'field' }, breakdown),
      el('div', { class: 'actions' }, drawButton),
    ),
  )
}
