// D-12 view 1: the assignments list, plus the form that turns the course's notation
// into canonical keys (D-5) before anything is saved.

import {
  STORE_ASSIGNMENTS,
  STORE_ATTEMPTS,
  deleteAssignment,
  getAll,
  newId,
  put,
  type Assignment,
  type Attempt,
} from '../state/db'
import { parseAssignment } from '../parse/assignment'
import { clear, el, formatDate, toast } from './dom'

function statusCounts(attempts: Attempt[], keys: string[]) {
  const byKey = new Map(attempts.map((a) => [a.key, a]))
  let done = 0
  let graded = 0
  for (const key of keys) {
    const status = byKey.get(key)?.status ?? 'unattempted'
    if (status !== 'unattempted') done++
    if (status === 'correct' || status === 'incorrect' || status === 'partial') graded++
  }
  return { done, graded, total: keys.length }
}

function assignmentRow(assignment: Assignment, attempts: Attempt[], reload: () => void) {
  const { done, graded, total } = statusCounts(attempts, assignment.keys)
  const pct = total ? Math.round((done / total) * 100) : 0

  return el(
    'div',
    { class: 'list-item' },
    el(
      'div',
      { class: 'grow' },
      el('a', { href: `#/a/${assignment.id}`, text: assignment.title }),
      el('div', {
        class: 'muted',
        text: `${total} problem${total === 1 ? '' : 's'} · created ${formatDate(assignment.created)} · ${graded} graded`,
      }),
    ),
    el('div', { class: 'progress', attrs: { title: `${done} of ${total} attempted` } }, el('span', { style: `width:${pct}%` })),
    el('div', { class: 'actions' },
      el('a', { href: `#/a/${assignment.id}` }, el('button', { text: 'Work' })),
      el('a', { href: `#/a/${assignment.id}/review` }, el('button', { text: 'Review' })),
      el('button', {
        class: 'danger',
        text: 'Delete',
        on: {
          click: async () => {
            if (!confirm(`Delete "${assignment.title}" and its ${total} attempt records?`)) return
            await deleteAssignment(assignment.id)
            toast('Assignment deleted.')
            reload()
          },
        },
      }),
    ),
  )
}

function newAssignmentForm(): HTMLElement {
  const title = el('input', { type: 'text', placeholder: 'Problem set 4' })
  const source = el('textarea', {
    placeholder: 'Ch 3, pp. 180-190: 14, 16-20, 22a',
  })
  const preview = el('div', { class: 'muted' })
  const createButton = el('button', { class: 'primary', text: 'Create assignment', disabled: true })

  let parsed = parseAssignment('')

  const update = () => {
    parsed = parseAssignment(source.value)
    clear(preview)
    if (!source.value.trim()) {
      preview.append('Paste the assignment as the course writes it. Chapter context carries across lines.')
    } else {
      preview.append(
        el('div', {
          text: parsed.keys.length
            ? `${parsed.keys.length} problem${parsed.keys.length === 1 ? '' : 's'}: ${parsed.keys.join(', ')}`
            : 'No problems recognized yet.',
        }),
      )
      if (parsed.pageHints.length) {
        preview.append(el('div', { text: `Pages: ${parsed.pageHints.join(', ')} (used only for the missing-index fallback)` }))
      }
      // D-5: unrecognized fragments are shown back, never silently dropped.
      for (const bad of parsed.unrecognized) {
        preview.append(el('div', { class: 'warn', text: `Not understood: "${bad.text}" — ${bad.reason}` }))
      }
    }
    createButton.disabled = parsed.keys.length === 0
  }

  source.addEventListener('input', update)
  update()

  createButton.addEventListener('click', async () => {
    const assignment: Assignment = {
      id: newId(),
      title: title.value.trim() || `Assignment ${formatDate(new Date().toISOString())}`,
      created: new Date().toISOString(),
      keys: parsed.keys,
      pageHint: parsed.pageHints.join(', ') || undefined,
    }
    await put(STORE_ASSIGNMENTS, assignment)
    toast(`Created with ${assignment.keys.length} problems.`)
    // The hash change schedules the router's render; re-rendering here too would
    // leave this view stacked underneath the workspace.
    location.hash = `#/a/${assignment.id}`
  })

  return el(
    'div',
    { class: 'card' },
    el('h2', { text: 'New assignment' }),
    el('div', { class: 'field' }, el('label', { text: 'Title' }), title),
    el('div', { class: 'field' }, el('label', { text: 'Problems as assigned' }), source),
    el('div', { class: 'field' }, preview),
    el('div', { class: 'actions' }, createButton),
  )
}

export async function renderAssignments(root: HTMLElement): Promise<void> {
  const [assignments, attempts] = await Promise.all([
    getAll<Assignment>(STORE_ASSIGNMENTS),
    getAll<Attempt>(STORE_ATTEMPTS),
  ])
  assignments.sort((a, b) => b.created.localeCompare(a.created))
  const reload = () => void renderAssignments(clear(root))

  root.append(
    el('h1', { text: 'Assignments' }),
    el('p', { class: 'sub', text: 'Enter an assignment, work the problems, reveal the manual, mark it yourself.' }),
    newAssignmentForm(),
  )

  if (!assignments.length) {
    root.append(el('p', { class: 'muted', text: 'No assignments yet.' }))
    return
  }

  const list = el('div', { class: 'list' })
  for (const assignment of assignments) {
    list.append(
      assignmentRow(
        assignment,
        attempts.filter((a) => a.assignmentId === assignment.id),
        reload,
      ),
    )
  }
  root.append(el('h2', { text: 'Saved' }), list)
}
