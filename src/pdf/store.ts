// D-2: the PDFs never leave the machine. They are picked once, kept in the Origin
// Private File System (fallback: an IndexedDB blob) and reloaded on later visits.
// C2: nothing here ever touches the network.

import { STORE_PDFS, get, put, del } from '../state/db'

export type PdfSlot = 'textbook' | 'solutions'

export const SLOT_LABELS: Record<PdfSlot, string> = {
  textbook: 'Textbook',
  solutions: 'Solution manual',
}

export interface PdfMeta {
  id: PdfSlot
  name: string
  size: number
  savedAt: string
  backend: 'opfs' | 'indexeddb'
}

interface PdfBlobRow {
  id: string
  blob: Blob
}

function blobRowId(slot: PdfSlot): string {
  return `${slot}:blob`
}

function opfsFileName(slot: PdfSlot): string {
  return `${slot}.pdf`
}

let opfsChecked: Promise<boolean> | null = null

/**
 * OPFS is only usable here if we can both open the root directory and get a
 * writable stream on the main thread; Safari historically offers the directory
 * but not `createWritable`, so we probe rather than feature-sniff (Q5).
 */
export function opfsAvailable(): Promise<boolean> {
  if (!opfsChecked) {
    opfsChecked = (async () => {
      try {
        if (!navigator.storage?.getDirectory) return false
        const root = await navigator.storage.getDirectory()
        const probe = await root.getFileHandle('.probe', { create: true })
        if (typeof (probe as FileSystemFileHandle).createWritable !== 'function') {
          await root.removeEntry('.probe').catch(() => {})
          return false
        }
        const w = await probe.createWritable()
        await w.close()
        await root.removeEntry('.probe').catch(() => {})
        return true
      } catch {
        return false
      }
    })()
  }
  return opfsChecked
}

export async function savePdf(slot: PdfSlot, file: File): Promise<PdfMeta> {
  const useOpfs = await opfsAvailable()
  if (useOpfs) {
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle(opfsFileName(slot), { create: true })
    const writable = await handle.createWritable()
    await writable.write(await file.arrayBuffer())
    await writable.close()
    await del(STORE_PDFS, blobRowId(slot)).catch(() => {})
  } else {
    await put<PdfBlobRow>(STORE_PDFS, { id: blobRowId(slot), blob: file })
  }
  const meta: PdfMeta = {
    id: slot,
    name: file.name,
    size: file.size,
    savedAt: new Date().toISOString(),
    backend: useOpfs ? 'opfs' : 'indexeddb',
  }
  await put(STORE_PDFS, meta)
  return meta
}

export function getPdfMeta(slot: PdfSlot): Promise<PdfMeta | undefined> {
  return get<PdfMeta>(STORE_PDFS, slot)
}

/**
 * Returns the stored bytes, or null if this slot has never been filled.
 * pdf.js takes ownership of (and detaches) the buffer it is handed, so callers
 * get a fresh copy each time.
 */
export async function loadPdfBytes(slot: PdfSlot): Promise<Uint8Array | null> {
  const meta = await getPdfMeta(slot)
  if (!meta) return null
  if (meta.backend === 'opfs') {
    try {
      const root = await navigator.storage.getDirectory()
      const handle = await root.getFileHandle(opfsFileName(slot))
      const file = await handle.getFile()
      return new Uint8Array(await file.arrayBuffer())
    } catch {
      return null
    }
  }
  const row = await get<PdfBlobRow>(STORE_PDFS, blobRowId(slot))
  if (!row) return null
  return new Uint8Array(await row.blob.arrayBuffer())
}

/** Settings' "replace PDF" control (D-2) clears before re-picking. */
export async function clearPdf(slot: PdfSlot): Promise<void> {
  const meta = await getPdfMeta(slot)
  if (meta?.backend === 'opfs') {
    try {
      const root = await navigator.storage.getDirectory()
      await root.removeEntry(opfsFileName(slot))
    } catch {
      /* already gone */
    }
  }
  await del(STORE_PDFS, blobRowId(slot)).catch(() => {})
  await del(STORE_PDFS, slot)
}

export function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}
