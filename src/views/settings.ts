// D-12 view 4: the PDF pickers (D-2), the page offsets (D-6), export/import (D-10) and
// the override export (D-8).

import {
  DEFAULT_SETTINGS,
  clearStore,
  exportAll,
  importAll,
  loadSettings,
  saveSettings,
  STORE_ASSIGNMENTS,
  STORE_ATTEMPTS,
  STORE_OVERRIDES,
  type Settings,
} from '../state/db'
import {
  SLOT_LABELS,
  clearPdf,
  formatSize,
  getPdfMeta,
  opfsAvailable,
  savePdf,
  type PdfSlot,
} from '../pdf/store'
import { invalidate, pageCount } from '../pdf/render'
import { exportOverridesAsIndex, invalidateOverrides, loadIndex, overrideCount } from '../index/load'
import { downloadJson, el, formatDate, pickFile, toast } from './dom'

async function pdfCard(slot: PdfSlot, reload: () => void): Promise<HTMLElement> {
  const meta = await getPdfMeta(slot)
  const status = el('p', { class: 'muted' })

  if (meta) {
    status.textContent = `${meta.name} - ${formatSize(meta.size)} - stored in ${
      meta.backend === 'opfs' ? 'the origin private file system' : 'IndexedDB'
    } on ${formatDate(meta.savedAt)}`
    void pageCount(slot)
      .then((n) => {
        if (n) status.textContent += ` - ${n} pages`
      })
      .catch(() => {
        status.textContent += ' - could not be opened; try replacing it'
      })
  } else {
    status.textContent = 'Not picked yet. The file stays on this machine and is never uploaded (D-2, C2).'
  }

  const pick = async () => {
    const file = await pickFile('application/pdf,.pdf')
    if (!file) return
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      toast('That does not look like a PDF.', 'error')
      return
    }
    await savePdf(slot, file)
    await invalidate(slot)
    toast(`${SLOT_LABELS[slot]} saved.`)
    reload()
  }

  return el(
    'div',
    { class: 'card' },
    el('h2', { text: SLOT_LABELS[slot] }),
    status,
    el(
      'div',
      { class: 'actions' },
      el('button', { class: meta ? '' : 'primary', text: meta ? 'Replace PDF' : 'Pick PDF', on: { click: () => void pick() } }),
      meta &&
        el('button', {
          class: 'danger',
          text: 'Forget',
          on: {
            click: async () => {
              if (!confirm(`Forget the ${SLOT_LABELS[slot].toLowerCase()}? Your assignments stay.`)) return
              await clearPdf(slot)
              await invalidate(slot)
              reload()
            },
          },
        }),
    ),
  )
}

function offsetsCard(settings: Settings, reload: () => void): HTMLElement {
  const textbook = el('input', { type: 'number', value: String(settings.textbookOffset) })
  const solutions = el('input', { type: 'number', value: String(settings.solutionOffset) })
  const scale = el('input', { type: 'number', min: '1', max: '4', step: '0.5', value: String(settings.renderScale) })
  const extracted = el('input', { type: 'checkbox', checked: settings.showExtractedText })

  return el(
    'div',
    { class: 'card' },
    el('h2', { text: 'Pages and rendering' }),
    el('p', {
      class: 'muted',
      text: 'D-6: printed page = PDF page + offset. Used only to help you navigate when a problem is missing from the index; the index itself always stores PDF page indices.',
    }),
    el(
      'div',
      { class: 'row' },
      el('div', { class: 'field' }, el('label', { text: 'Textbook offset' }), textbook),
      el('div', { class: 'field' }, el('label', { text: 'Solution manual offset' }), solutions),
      el('div', { class: 'field' }, el('label', { text: 'Render scale (canvas px per point)' }), scale),
    ),
    el('div', { class: 'field' }, el('label', { text: 'Show extracted text by default (best-effort, D-7)' }), extracted),
    el(
      'div',
      { class: 'actions' },
      el('button', {
        class: 'primary',
        text: 'Save settings',
        on: {
          click: async () => {
            await saveSettings({
              textbookOffset: Number(textbook.value) || 0,
              solutionOffset: Number(solutions.value) || 0,
              renderScale: Math.min(4, Math.max(1, Number(scale.value) || DEFAULT_SETTINGS.renderScale)),
              showExtractedText: extracted.checked,
            })
            toast('Settings saved.')
            reload()
          },
        },
      }),
    ),
  )
}

async function dataCard(reload: () => void): Promise<HTMLElement> {
  const [index, overrides] = await Promise.all([loadIndex(), overrideCount()])
  const indexed = Object.keys(index.problems).length

  const doImport = async () => {
    const file = await pickFile('application/json,.json')
    if (!file) return
    if (!confirm('Import replaces every assignment, attempt and override in this browser. Continue?')) return
    try {
      await importAll(JSON.parse(await file.text()))
      invalidateOverrides()
      toast('Import complete.')
      reload()
    } catch (err) {
      toast(`Import failed: ${(err as Error).message}`, 'error')
    }
  }

  return el(
    'div',
    { class: 'card' },
    el('h2', { text: 'Data' }),
    el('p', {
      class: 'muted',
      text: `Index: ${index.book} - ${indexed} problem${indexed === 1 ? '' : 's'} located. Local overrides: ${overrides}.`,
    }),
    el('p', {
      class: 'muted',
      text: 'D-10: export is the only backup. It carries assignments, attempts, settings and overrides - never book content or the PDFs themselves.',
    }),
    el(
      'div',
      { class: 'actions' },
      el('button', {
        class: 'primary',
        text: 'Export everything',
        on: {
          click: async () => {
            downloadJson(`idd-pset-${new Date().toISOString().slice(0, 10)}.json`, await exportAll())
          },
        },
      }),
      el('button', { text: 'Import (replaces)', on: { click: () => void doImport() } }),
      el('button', {
        text: 'Export index overrides',
        disabled: overrides === 0,
        on: {
          click: async () => {
            // D-8: shaped like index.json so it can be merged into the committed file.
            downloadJson('index.overrides.json', await exportOverridesAsIndex())
          },
        },
      }),
      el('button', {
        class: 'danger',
        text: 'Wipe local data',
        on: {
          click: async () => {
            if (!confirm('Delete all assignments, attempts and overrides in this browser? Export first.')) return
            await Promise.all([
              clearStore(STORE_ASSIGNMENTS),
              clearStore(STORE_ATTEMPTS),
              clearStore(STORE_OVERRIDES),
            ])
            invalidateOverrides()
            toast('Local data wiped. The PDFs are untouched.')
            reload()
          },
        },
      }),
    ),
  )
}

export async function renderSettings(root: HTMLElement): Promise<void> {
  const settings = await loadSettings()
  const reload = () => {
    root.replaceChildren()
    void renderSettings(root)
  }

  root.append(
    el('h1', { text: 'Settings' }),
    el('p', { class: 'sub', text: 'Everything here is local to this browser.' }),
    await pdfCard('textbook', reload),
    await pdfCard('solutions', reload),
    offsetsCard(settings, reload),
    await dataCard(reload),
  )

  // Q5: worth knowing which storage backend this browser actually gave us.
  const opfs = await opfsAvailable()
  root.append(
    el('p', {
      class: 'muted',
      text: opfs
        ? 'Storage: origin private file system (D-2 preferred path).'
        : 'Storage: IndexedDB fallback - this browser did not offer a writable OPFS (D-2).',
    }),
  )
}
