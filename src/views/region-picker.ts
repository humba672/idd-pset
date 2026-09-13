// D-8: when a key is missing from index.json, show the full page with a stepper and let
// the user drag a box around the problem (or its solution). The result is written to the
// local override store and can be exported for merging into the committed index.

import { normalizeBbox, pageCount, renderPage, type Bbox } from '../pdf/render'
import type { PdfSlot } from '../pdf/store'
import { SLOT_LABELS } from '../pdf/store'
import type { Settings } from '../state/db'
import { el, toast } from './dom'

export interface RegionPickerOptions {
  slot: PdfSlot
  /** 0-based PDF page index to open on (D-3, D-6). */
  initialPage: number
  settings: Settings
  label: string
  onSave: (regions: { page: number; bbox: Bbox }[]) => Promise<void>
}

interface Selection {
  x: number
  y: number
  w: number
  h: number
}

export function regionPicker(options: RegionPickerOptions): HTMLElement {
  const { slot, settings, label, onSave } = options
  const offset = slot === 'textbook' ? settings.textbookOffset : settings.solutionOffset

  let page = Math.max(0, options.initialPage)
  let total = 0
  let mapping: Awaited<ReturnType<typeof renderPage>> | null = null
  let selection: Selection | null = null
  const pending: { page: number; bbox: Bbox }[] = []

  const canvas = el('canvas', { class: 'render' })
  const marquee = el('div', { class: 'selection', hidden: true })
  const stage = el('div', { class: 'fallback-stage' }, canvas, marquee)
  const pageInput = el('input', { type: 'number', min: '1', value: String(page + 1) })
  const pageLabel = el('span', { class: 'muted' })
  const pendingList = el('div', { class: 'muted' })
  const addButton = el('button', { text: 'Add this region', disabled: true })
  const saveButton = el('button', { class: 'primary', text: 'Save', disabled: true })

  const drawPending = () => {
    pendingList.textContent = pending.length
      ? `Marked: ${pending.map((r) => `p.${r.page + 1}`).join(', ')} (a problem may span pages, D-3)`
      : 'Drag a box around the region, then add it.'
    saveButton.disabled = pending.length === 0
  }

  const draw = async () => {
    try {
      total = total || (await pageCount(slot))
      page = Math.min(Math.max(0, page), Math.max(0, total - 1))
      pageInput.value = String(page + 1)
      // D-6: printed page = PDF page + offset. Shown only to help the user navigate.
      pageLabel.textContent = `PDF page ${page + 1} of ${total} (printed p. ${page + offset + 1})`
      mapping = await renderPage(slot, page, canvas, settings.renderScale)
      selection = null
      marquee.hidden = true
      addButton.disabled = true
    } catch (err) {
      pageLabel.textContent = String((err as Error).message)
    }
  }

  // --- dragging a box over the rendered page
  let start: { x: number; y: number } | null = null

  const pointFromEvent = (ev: PointerEvent) => {
    const rect = canvas.getBoundingClientRect()
    return {
      x: Math.min(Math.max(0, ev.clientX - rect.left), rect.width),
      y: Math.min(Math.max(0, ev.clientY - rect.top), rect.height),
    }
  }

  stage.addEventListener('pointerdown', (ev) => {
    if (!mapping) return
    start = pointFromEvent(ev as PointerEvent)
    try {
      stage.setPointerCapture((ev as PointerEvent).pointerId)
    } catch {
      // Capture is a nicety: without it the drag still tracks, it just stops at the edge.
    }
    selection = { ...start, w: 0, h: 0 }
    marquee.hidden = false
  })

  stage.addEventListener('pointermove', (ev) => {
    if (!start) return
    const now = pointFromEvent(ev as PointerEvent)
    selection = {
      x: Math.min(start.x, now.x),
      y: Math.min(start.y, now.y),
      w: Math.abs(now.x - start.x),
      h: Math.abs(now.y - start.y),
    }
    marquee.style.left = `${selection.x}px`
    marquee.style.top = `${selection.y}px`
    marquee.style.width = `${selection.w}px`
    marquee.style.height = `${selection.h}px`
  })

  const endDrag = () => {
    start = null
    addButton.disabled = !selection || selection.w < 8 || selection.h < 8
  }
  stage.addEventListener('pointerup', endDrag)
  stage.addEventListener('pointercancel', endDrag)

  /** Displayed CSS pixels -> canvas pixels -> PDF user space (the index's units, D-3). */
  const toBbox = (sel: Selection): Bbox | null => {
    if (!mapping) return null
    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    const sx = canvas.width / rect.width
    const sy = canvas.height / rect.height
    const a = mapping.toPdfPoint(sel.x * sx, sel.y * sy)
    const b = mapping.toPdfPoint((sel.x + sel.w) * sx, (sel.y + sel.h) * sy)
    return normalizeBbox(a, b)
  }

  addButton.addEventListener('click', () => {
    if (!selection) return
    const bbox = toBbox(selection)
    if (!bbox) return
    pending.push({ page, bbox })
    drawPending()
    toast(`Region on PDF page ${page + 1} added.`)
  })

  saveButton.addEventListener('click', async () => {
    saveButton.disabled = true
    await onSave(pending)
  })

  const step = (delta: number) => {
    page += delta
    void draw()
  }

  pageInput.addEventListener('change', () => {
    page = Math.max(0, Number(pageInput.value) - 1)
    void draw()
  })

  drawPending()
  void draw()

  return el(
    'div',
    { class: 'card' },
    el('h3', { text: label }),
    el('p', { class: 'muted', text: `Source: ${SLOT_LABELS[slot]}` }),
    el(
      'div',
      { class: 'stepper' },
      el('button', { text: '< Prev', on: { click: () => step(-1) } }),
      pageInput,
      el('button', { text: 'Next >', on: { click: () => step(1) } }),
      pageLabel,
    ),
    stage,
    el('div', { class: 'stepper' }, addButton, saveButton, el('button', {
      text: 'Clear marks',
      on: {
        click: () => {
          pending.length = 0
          drawPending()
        },
      },
    })),
    pendingList,
  )
}
