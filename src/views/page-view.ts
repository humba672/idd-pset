// P-10 (extends D-7): the whole page, when the region is not enough.
//
// D-7 shows a problem as its own region and nothing else, which is right nearly always
// and wrong exactly when the index has placed that region badly - or when the problem
// leans on a figure or a worked example beside it. Rather than make the reader guess what
// has been cut off, let them look at the page it came from, and step either side of it.

import { pageCount, renderPage } from '../pdf/render'
import { SLOT_LABELS, type PdfSlot } from '../pdf/store'
import type { Settings } from '../state/db'
import { el } from './dom'

export interface PageViewOptions {
  slot: PdfSlot
  /** 0-based PDF page index to open on (D-3). */
  page: number
  settings: Settings
  /** Called when the reader is done looking; put the region back. */
  onClose: () => void
}

/** D-6: printed page = PDF page + offset. Shown so a paper copy can be followed. */
export function pageLabel(pageIndex: number, total: number, offset: number): string {
  const printed = pageIndex + offset + 1
  const printedPart = printed > 0 ? `, printed p. ${printed}` : ''
  return `PDF page ${pageIndex + 1} of ${total}${printedPart}`
}

export function pageView(options: PageViewOptions): HTMLElement {
  const { slot, settings, onClose } = options
  const offset = slot === 'textbook' ? settings.textbookOffset : settings.solutionOffset

  let page = Math.max(0, options.page)
  let total = 0

  const canvas = el('canvas', { class: 'render' })
  const label = el('span', { class: 'muted' })
  const previous = el('button', { text: '< Prev' })
  const next = el('button', { text: 'Next >' })

  const draw = async () => {
    try {
      total = total || (await pageCount(slot))
      page = Math.min(Math.max(0, page), Math.max(0, total - 1))
      label.textContent = pageLabel(page, total, offset)
      previous.disabled = page === 0
      next.disabled = page >= total - 1
      await renderPage(slot, page, canvas, settings.zoom)
    } catch (err) {
      label.textContent = String((err as Error).message)
    }
  }

  previous.addEventListener('click', () => {
    page -= 1
    void draw()
  })
  next.addEventListener('click', () => {
    page += 1
    void draw()
  })

  void draw()

  return el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'stepper' },
      el('strong', { text: SLOT_LABELS[slot] }),
      previous,
      next,
      label,
      el('button', { text: 'Back to the problem', on: { click: onClose } }),
    ),
    el('div', { class: 'render-box' }, canvas),
  )
}
