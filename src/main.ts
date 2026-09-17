// D-12, amended by P-8: five views. This is the shell and the hash router between them.

import './styles.css'
import { clear, el, toast } from './views/dom'
import { renderAssignments } from './views/assignments'
import { renderWorkspace } from './views/workspace'
import { renderReview } from './views/review'
import { renderSettings } from './views/settings'
import { renderStudy } from './views/study'
import { getPdfMeta } from './pdf/store'

type Route =
  | { view: 'assignments' }
  | { view: 'workspace'; id: string }
  | { view: 'review'; id: string }
  | { view: 'study' }
  | { view: 'settings' }

function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  if (parts[0] === 'settings') return { view: 'settings' }
  if (parts[0] === 'study') return { view: 'study' }
  if (parts[0] === 'a' && parts[1]) {
    return parts[2] === 'review'
      ? { view: 'review', id: parts[1] }
      : { view: 'workspace', id: parts[1] }
  }
  return { view: 'assignments' }
}

function renderNav(route: Route): void {
  const nav = document.getElementById('nav')
  if (!nav) return
  const links: [string, string, boolean][] = [
    ['#/assignments', 'Assignments', route.view === 'assignments'],
    ['#/study', 'Study', route.view === 'study'],
    ['#/settings', 'Settings', route.view === 'settings'],
  ]
  clear(nav)
  for (const [href, label, active] of links) {
    nav.append(el('a', { href, text: label, class: active ? 'active' : '' }))
  }
}

/** D-2: without both PDFs nothing renders, so say so once, at the top, with a way out. */
async function renderSetupNotice(root: HTMLElement, route: Route): Promise<void> {
  if (route.view === 'settings') return
  const [textbook, solutions] = await Promise.all([
    getPdfMeta('textbook'),
    getPdfMeta('solutions'),
  ])
  const missing = [!textbook && 'the textbook', !solutions && 'the solution manual'].filter(
    Boolean,
  ) as string[]
  if (!missing.length) return
  root.prepend(
    el(
      'div',
      { class: 'card' },
      el('h2', { text: 'Finish setup' }),
      el('p', {
        class: 'muted',
        text: `This browser does not have ${missing.join(' or ')} yet. Problems cannot render until both PDFs are picked. They stay on this machine.`,
      }),
      el('div', { class: 'actions' }, el('a', { href: '#/settings' }, el('button', { class: 'primary', text: 'Open settings' }))),
    ),
  )
}

async function render(): Promise<void> {
  const root = document.getElementById('app')
  if (!root) return
  const route = parseRoute(location.hash)
  renderNav(route)
  clear(root)
  try {
    switch (route.view) {
      case 'assignments':
        await renderAssignments(root)
        break
      case 'workspace':
        await renderWorkspace(root, route.id)
        break
      case 'review':
        await renderReview(root, route.id)
        break
      case 'study':
        await renderStudy(root)
        break
      case 'settings':
        await renderSettings(root)
        break
    }
    await renderSetupNotice(root, route)
  } catch (err) {
    console.error(err)
    clear(root).append(
      el(
        'div',
        { class: 'card' },
        el('h2', { text: 'Something went wrong' }),
        el('p', { class: 'error', text: String((err as Error)?.message ?? err) }),
      ),
    )
    toast('Something went wrong. See the console.', 'error')
  }
}

/**
 * Views render asynchronously (pdf.js, IndexedDB), so two renders must never overlap:
 * they would both append into #app. Renders are queued, and a render that has already
 * been superseded by a newer one is dropped instead of drawing a stale view.
 */
let queue: Promise<void> = Promise.resolve()
let generation = 0

function scheduleRender(): void {
  const mine = ++generation
  queue = queue.then(() => (mine === generation ? render() : undefined))
}

window.addEventListener('hashchange', scheduleRender)
if (!location.hash) {
  location.hash = '#/assignments' // fires hashchange, which renders
} else {
  scheduleRender()
}
