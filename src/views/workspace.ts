// D-12 view 2: problem list on the left; the current problem and a collapsed solution
// panel on the right. This is the loop the app exists for (Section 1).

import {
  STORE_ASSIGNMENTS,
  get,
  loadAttempt,
  loadSettings,
  saveAttempt,
  type Assignment,
  type Attempt,
  type AttemptStatus,
  type Settings,
} from '../state/db'
import { resolveAll, resolveProblem, saveOverride, type ResolvedProblem } from '../index/load'
import { extractText, renderRegions, type Region } from '../pdf/render'
import type { PdfSlot } from '../pdf/store'
import { regionPicker } from './region-picker'
import { clear, el, toast } from './dom'

const STATUS_LABELS: Record<AttemptStatus, string> = {
  unattempted: 'Not started',
  attempted: 'Attempted',
  correct: 'Correct',
  incorrect: 'Incorrect',
  partial: 'Partial',
}

/** D-9: the user sets these by hand; the app never judges an answer (Section 2). */
const VERDICTS: AttemptStatus[] = ['correct', 'partial', 'incorrect']

export function statusChip(status: AttemptStatus): HTMLElement {
  return el('span', { class: `chip ${status}`, text: STATUS_LABELS[status] })
}

/** D-6: printed page = PDF page + offset, so a printed page hint lands at printed - offset. */
export function pdfPageFromHint(hint: string | undefined, offset: number): number {
  const first = /\d+/.exec(hint ?? '')
  if (!first) return 0
  return Math.max(0, Number(first[0]) - offset)
}

async function renderInto(
  box: HTMLElement,
  slot: PdfSlot,
  regions: Region[],
  scale: number,
): Promise<void> {
  box.classList.add('loading')
  try {
    await renderRegions(slot, regions, box, scale)
  } catch (err) {
    clear(box).append(el('p', { class: 'error', text: String((err as Error).message) }))
  } finally {
    box.classList.remove('loading')
  }
}

function extractedTextToggle(
  slot: PdfSlot,
  regions: Region[],
  settings: Settings,
): HTMLElement {
  // D-7: the rendering is the source of truth; this is a labelled best-effort convenience.
  const out = el('pre', { class: 'extracted', hidden: true })
  const button = el('button', { text: 'Show extracted text' })
  let loaded = false

  button.addEventListener('click', async () => {
    out.hidden = !out.hidden
    button.textContent = out.hidden ? 'Show extracted text' : 'Hide extracted text'
    if (out.hidden || loaded) return
    out.textContent = 'Extracting...'
    const parts: string[] = []
    for (const region of regions) {
      parts.push(await extractText(slot, region.page, region.bbox))
    }
    out.textContent =
      parts.join('\n\n').trim() || 'Nothing extractable here - this region is probably a figure.'
    loaded = true
  })

  if (settings.showExtractedText) queueMicrotask(() => button.click())

  return el(
    'div',
    {},
    el('div', { class: 'actions' }, button, el('span', { class: 'muted', text: 'best-effort (D-7)' })),
    out,
  )
}

function solutionPanel(
  problem: ResolvedProblem,
  attempt: Attempt,
  settings: Settings,
  onChange: () => void,
): HTMLElement {
  const panel = el('div', { class: 'solution-panel' })
  panel.append(el('h3', { text: 'Solution' }))

  const showSolution = () => {
    if (!problem.hasSolution) {
      // Q2: the manual may cover only a subset. Say so rather than pretending to look.
      panel.append(
        el('p', { class: 'muted', text: 'No solution region is indexed for this problem.' }),
        regionPicker({
          slot: 'solutions',
          initialPage: 0,
          settings,
          label: 'Find it in the manual and mark the region',
          onSave: async (regions) => {
            await saveOverride(problem.key, 'solution', regions)
            toast('Solution region saved as a local override.')
            onChange()
          },
        }),
      )
      return
    }
    const box = el('div', { class: 'render-box' })
    panel.append(box, extractedTextToggle('solutions', problem.solution, settings))
    void renderInto(box, 'solutions', problem.solution, settings.zoom)
    panel.append(
      el('p', {
        class: 'muted',
        text: 'Compare, then mark the attempt yourself - the app does not grade (Section 2).',
      }),
    )
  }

  if (attempt.revealed) {
    showSolution()
    return panel
  }

  // D-9: revealing does not set a verdict; the user still marks correct/incorrect/partial.
  const reveal = async (markAttempted: boolean) => {
    attempt.revealed = true
    if (markAttempted && attempt.status === 'unattempted') attempt.status = 'attempted'
    await saveAttempt(attempt)
    onChange()
  }

  panel.append(
    el('p', { class: 'muted', text: 'Hidden until you have had a go at it (D-9).' }),
    el(
      'div',
      { class: 'actions' },
      attempt.status === 'unattempted'
        ? el('button', {
            class: 'primary',
            text: 'Mark attempted and reveal',
            on: { click: () => void reveal(true) },
          })
        : el('button', {
            class: 'primary',
            text: 'Reveal solution',
            on: { click: () => void reveal(false) },
          }),
      attempt.status === 'unattempted' &&
        el('button', { text: 'Reveal without marking', on: { click: () => void reveal(false) } }),
    ),
  )
  return panel
}

/** Also used by the study view (P-8), which works one problem at a time. */
export function problemPane(
  assignment: Assignment,
  key: string,
  problem: ResolvedProblem,
  attempt: Attempt,
  settings: Settings,
  onChange: () => void,
): HTMLElement {
  const pane = el('div', { class: 'card' })

  pane.append(
    el(
      'div',
      { class: 'actions', style: 'justify-content:space-between' },
      el('h2', { text: `Problem ${key}`, style: 'margin:0' }),
      el(
        'div',
        { class: 'actions' },
        statusChip(attempt.status),
        problem.textSource === 'override' && el('span', { class: 'chip', text: 'local override' }),
      ),
    ),
  )

  // The problem itself (D-7), or the D-8 fallback when it is not indexed.
  if (problem.missing) {
    pane.append(
      el('p', {
        class: 'warn',
        text: `${key} is not in index.json. Find it below and mark the region - the override is yours to export and merge (D-8).`,
      }),
      regionPicker({
        slot: 'textbook',
        initialPage: pdfPageFromHint(assignment.pageHint, settings.textbookOffset),
        settings,
        label: `Mark this region as problem ${key}`,
        onSave: async (regions) => {
          await saveOverride(key, 'text', regions)
          toast(`Region saved for ${key}.`)
          onChange()
        },
      }),
    )
  } else {
    const box = el('div', { class: 'render-box' })
    pane.append(box, extractedTextToggle('textbook', problem.text, settings))
    void renderInto(box, 'textbook', problem.text, settings.zoom)

    {
      // Any region can be wrong, not just a hand-drawn one: the index is built by a
      // script against a book full of stacked fractions and figures (D-4), and a box it
      // places badly is only fixable from here. The override exports for merging (D-8).
      const remark = el('button', {
        text: problem.textSource === 'override' ? 'Re-mark region' : 'Fix this region',
      })
      const holder = el('div', { class: 'actions' }, remark)
      remark.addEventListener('click', () => {
        holder.remove()
        box.replaceWith(
          regionPicker({
            slot: 'textbook',
            initialPage: problem.text[0]?.page ?? 0,
            settings,
            label: `Re-mark the region for problem ${key}`,
            onSave: async (regions) => {
              await saveOverride(key, 'text', regions)
              toast(`Region updated for ${key}.`)
              onChange()
            },
          }),
        )
      })
      pane.append(holder)
    }
  }

  // 2026-09-13 ruling (supersedes D-11): answers are not captured. The work happens on
  // paper; the app records the verdict and anything worth reading back at review time.
  const notes = el('input', {
    type: 'text',
    value: attempt.notes,
    placeholder: 'Note for review (optional)',
  })
  const savedMark = el('span', { class: 'muted' })

  let timer: number | undefined
  const queueSave = () => {
    savedMark.textContent = 'saving...'
    clearTimeout(timer)
    timer = window.setTimeout(async () => {
      attempt.notes = notes.value
      await saveAttempt(attempt)
      savedMark.textContent = 'saved'
    }, 400)
  }
  notes.addEventListener('input', queueSave)

  const setStatus = async (status: AttemptStatus) => {
    clearTimeout(timer)
    attempt.notes = notes.value
    attempt.status = status
    await saveAttempt(attempt)
    onChange()
  }

  pane.append(
    el('div', { class: 'field', style: 'margin-top:16px' }, el('label', { text: 'Note' }), notes),
    el(
      'div',
      { class: 'actions' },
      el('button', {
        text: attempt.status === 'unattempted' ? 'Mark attempted' : 'Reset to not started',
        on: {
          click: () =>
            void setStatus(attempt.status === 'unattempted' ? 'attempted' : 'unattempted'),
        },
      }),
      ...VERDICTS.map((verdict) =>
        el('button', {
          class: attempt.status === verdict ? 'primary' : '',
          text: STATUS_LABELS[verdict],
          on: { click: () => void setStatus(verdict) },
        }),
      ),
      savedMark,
    ),
    solutionPanel(problem, attempt, settings, onChange),
  )

  return pane
}

export async function renderWorkspace(root: HTMLElement, assignmentId: string): Promise<void> {
  const assignment = await get<Assignment>(STORE_ASSIGNMENTS, assignmentId)
  if (!assignment) {
    root.append(
      el(
        'div',
        { class: 'card' },
        el('h2', { text: 'Assignment not found' }),
        el('p', {
          class: 'muted',
          text: 'It may have been deleted, or this is a different browser profile.',
        }),
        el('a', { href: '#/assignments' }, el('button', { text: 'Back to assignments' })),
      ),
    )
    return
  }

  const settings = await loadSettings()
  const problems = await resolveAll(assignment.keys)
  const attempts = new Map<string, Attempt>()
  for (const key of assignment.keys) attempts.set(key, await loadAttempt(assignment.id, key))

  const remembered = sessionStorage.getItem(`current:${assignment.id}`)
  let currentKey =
    remembered && assignment.keys.includes(remembered) ? remembered : assignment.keys[0] ?? ''

  const listPane = el('div', { class: 'problem-list' })
  const detail = el('div', {})

  const drawList = (): void => {
    clear(listPane)
    for (const key of assignment.keys) {
      listPane.append(
        el(
          'button',
          { class: key === currentKey ? 'current' : '', on: { click: () => void show(key) } },
          el('span', { text: problems.get(key)?.missing ? `${key} *` : key }),
          statusChip(attempts.get(key)?.status ?? 'unattempted'),
        ),
      )
    }
  }

  async function show(key: string): Promise<void> {
    currentKey = key
    sessionStorage.setItem(`current:${assignment!.id}`, key)
    attempts.set(key, await loadAttempt(assignment!.id, key))
    problems.set(key, await resolveProblem(key))
    drawList()
    clear(detail).append(
      problemPane(
        assignment!,
        key,
        problems.get(key)!,
        attempts.get(key)!,
        settings,
        () => void show(key),
      ),
    )
  }

  const graded = assignment.keys.filter((key) => {
    const status = attempts.get(key)?.status
    return status === 'correct' || status === 'incorrect' || status === 'partial'
  }).length

  root.append(
    el(
      'div',
      { class: 'actions', style: 'justify-content:space-between;margin-bottom:12px' },
      el(
        'div',
        {},
        el('h1', { text: assignment.title, style: 'margin:0' }),
        el('div', {
          class: 'muted',
          text: `${assignment.keys.length} problems | ${graded} graded${
            assignment.pageHint ? ` | pp. ${assignment.pageHint}` : ''
          }`,
        }),
      ),
      el(
        'div',
        { class: 'actions' },
        el('a', { href: '#/assignments' }, el('button', { text: 'All assignments' })),
        el('a', { href: `#/a/${assignment.id}/review` }, el('button', { text: 'Review' })),
      ),
    ),
    el('div', { class: 'workspace' }, listPane, detail),
  )

  if (currentKey) await show(currentKey)
  else detail.append(el('p', { class: 'muted', text: 'This assignment has no problems.' }))
}
