// D-12 view 3: the same assignment with every solution revealed and statuses editable.
// Nothing here is graded automatically (Section 2); the verdict buttons are the point.

import {
  STORE_ASSIGNMENTS,
  get,
  loadAttempt,
  loadSettings,
  saveAttempt,
  type Assignment,
  type Attempt,
  type AttemptStatus,
} from '../state/db'
import { resolveAll } from '../index/load'
import { renderRegions } from '../pdf/render'
import { clear, el } from './dom'
import { statusChip } from './workspace'

const VERDICTS: AttemptStatus[] = ['correct', 'partial', 'incorrect']
const VERDICT_LABELS: Record<string, string> = {
  correct: 'Correct',
  partial: 'Partial',
  incorrect: 'Incorrect',
}

export async function renderReview(root: HTMLElement, assignmentId: string): Promise<void> {
  const assignment = await get<Assignment>(STORE_ASSIGNMENTS, assignmentId)
  if (!assignment) {
    root.append(
      el(
        'div',
        { class: 'card' },
        el('h2', { text: 'Assignment not found' }),
        el('a', { href: '#/assignments' }, el('button', { text: 'Back to assignments' })),
      ),
    )
    return
  }

  const settings = await loadSettings()
  const problems = await resolveAll(assignment.keys)
  const attempts = new Map<string, Attempt>()
  for (const key of assignment.keys) attempts.set(key, await loadAttempt(assignment.id, key))

  const tally = (status: AttemptStatus) =>
    assignment.keys.filter((key) => attempts.get(key)?.status === status).length

  const summary = el('div', {
    class: 'muted',
    text: `${tally('correct')} correct | ${tally('partial')} partial | ${tally('incorrect')} incorrect | ${
      assignment.keys.length - tally('correct') - tally('partial') - tally('incorrect')
    } ungraded`,
  })

  root.append(
    el(
      'div',
      { class: 'actions', style: 'justify-content:space-between;margin-bottom:12px' },
      el('div', {}, el('h1', { text: `${assignment.title} - review`, style: 'margin:0' }), summary),
      el(
        'div',
        { class: 'actions' },
        el('a', { href: `#/a/${assignment.id}` }, el('button', { text: 'Back to work' })),
        el('button', { text: 'Print', on: { click: () => window.print() } }),
      ),
    ),
  )

  const body = el('div', { class: 'card' })
  root.append(body)

  for (const key of assignment.keys) {
    const problem = problems.get(key)!
    const attempt = attempts.get(key)!
    const chipHolder = el('span', {}, statusChip(attempt.status))

    const setStatus = async (status: AttemptStatus) => {
      attempt.status = status
      await saveAttempt(attempt)
      clear(chipHolder).append(statusChip(status))
      summary.textContent = `${tally('correct')} correct | ${tally('partial')} partial | ${tally(
        'incorrect',
      )} incorrect | ${
        assignment.keys.length - tally('correct') - tally('partial') - tally('incorrect')
      } ungraded`
      for (const [verdict, button] of verdictButtons) {
        button.className = status === verdict ? 'primary' : ''
      }
    }

    const verdictButtons = VERDICTS.map(
      (verdict) =>
        [
          verdict,
          el('button', {
            class: attempt.status === verdict ? 'primary' : '',
            text: VERDICT_LABELS[verdict]!,
            on: { click: () => void setStatus(verdict) },
          }),
        ] as const,
    )

    const problemBox = el('div', { class: 'render-box' })
    const solutionBox = el('div', { class: 'render-box' })

    body.append(
      el(
        'div',
        { class: 'review-item' },
        el(
          'div',
          { class: 'actions', style: 'justify-content:space-between' },
          el('h2', { text: `Problem ${key}`, style: 'margin:0' }),
          el('div', { class: 'actions' }, chipHolder, ...verdictButtons.map(([, b]) => b)),
        ),
        el(
          'div',
          { class: 'two-col' },
          el(
            'div',
            {},
            el('h3', { text: 'Problem' }),
            problem.missing
              ? el('p', { class: 'warn', text: 'Not in the index - open it in the workspace to mark a region (D-8).' })
              : problemBox,
            attempt.notes &&
              el('p', { class: 'muted', style: 'margin-top:12px', text: `Note: ${attempt.notes}` }),
          ),
          el(
            'div',
            {},
            el('h3', { text: 'Solution' }),
            problem.hasSolution
              ? solutionBox
              : el('p', { class: 'muted', text: 'No solution indexed for this problem.' }),
          ),
        ),
      ),
    )

    // Rendering is sequential on purpose: pdf.js is happier, and review pages can be long.
    if (!problem.missing) {
      await renderRegions('textbook', problem.text, problemBox, settings.renderScale).catch(
        (err: Error) => problemBox.append(el('p', { class: 'error', text: err.message })),
      )
    }
    if (problem.hasSolution) {
      await renderRegions('solutions', problem.solution, solutionBox, settings.renderScale).catch(
        (err: Error) => solutionBox.append(el('p', { class: 'error', text: err.message })),
      )
    }
  }
}
