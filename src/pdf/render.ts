// D-7: problems and solutions are shown as canvas renderings of a bbox region, not as
// extracted text. D-13: the pdf.js worker and font assets are bundled with the site;
// nothing is fetched from a CDN.

import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { loadPdfBytes, type PdfSlot } from './store'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

const assetBase = (path: string) => new URL(`pdfjs/${path}`, document.baseURI).href

/**
 * D-3: a region is a PDF page index (0-based) plus a bbox in PDF user space
 * ([x0, y0, x1, y1], origin bottom-left, units of points). tools/build_index.py
 * emits this convention; PyMuPDF's top-left rects are flipped there, not here.
 */
export type Bbox = [number, number, number, number]

export interface Region {
  page: number
  bbox: Bbox
}

const docs = new Map<PdfSlot, Promise<PDFDocumentProxy | null>>()
const tasks = new WeakMap<HTMLCanvasElement, RenderTask>()

/**
 * Padding in PDF points added around a bbox so glyphs are not clipped. Kept small:
 * problem regions abut each other, and generous padding shows the next problem.
 */
const PAD = 2

export function getDoc(slot: PdfSlot): Promise<PDFDocumentProxy | null> {
  let existing = docs.get(slot)
  if (!existing) {
    existing = (async () => {
      const bytes = await loadPdfBytes(slot)
      if (!bytes) return null
      return pdfjs.getDocument({
        data: bytes,
        cMapUrl: assetBase('cmaps/'),
        cMapPacked: true,
        standardFontDataUrl: assetBase('standard_fonts/'),
        isEvalSupported: false,
      }).promise
    })()
    docs.set(slot, existing)
  }
  return existing
}

/** Call after replacing a PDF in settings so the next render re-reads storage. */
export async function invalidate(slot: PdfSlot): Promise<void> {
  const existing = docs.get(slot)
  docs.delete(slot)
  if (existing) {
    const doc = await existing.catch(() => null)
    await doc?.destroy().catch(() => {})
  }
}

export async function pageCount(slot: PdfSlot): Promise<number> {
  const doc = await getDoc(slot)
  return doc?.numPages ?? 0
}

async function getPage(slot: PdfSlot, pageIndex: number): Promise<PDFPageProxy> {
  const doc = await getDoc(slot)
  if (!doc) throw new Error(`No ${slot} PDF loaded. Pick one in Settings.`)
  const pageNumber = pageIndex + 1
  if (pageNumber < 1 || pageNumber > doc.numPages) {
    throw new Error(`Page ${pageIndex} is outside this PDF (${doc.numPages} pages).`)
  }
  return doc.getPage(pageNumber)
}

export interface RenderOptions {
  /** Omit to render the whole page (D-8 fallback view). */
  bbox?: Bbox | null
  /** Canvas pixels per PDF point. 2 is readable on a typical display (D-7). */
  scale?: number
}

/**
 * Renders `region` into `canvas`, sized to the region. Returns the region's size in
 * PDF points so callers can lay out around it.
 */
export async function renderRegion(
  slot: PdfSlot,
  pageIndex: number,
  canvas: HTMLCanvasElement,
  { bbox = null, scale = 2 }: RenderOptions = {},
): Promise<{ width: number; height: number }> {
  const page = await getPage(slot, pageIndex)
  const viewport = page.getViewport({ scale })

  let width = viewport.width
  let height = viewport.height
  let transform: number[] | undefined

  if (bbox) {
    const padded: Bbox = [bbox[0] - PAD, bbox[1] - PAD, bbox[2] + PAD, bbox[3] + PAD]
    const r = viewport.convertToViewportRectangle(padded)
    const x0 = Math.min(r[0], r[2])
    const y0 = Math.min(r[1], r[3])
    width = Math.abs(r[2] - r[0])
    height = Math.abs(r[3] - r[1])
    transform = [1, 0, 0, 1, -x0, -y0]
  }

  const pxWidth = Math.max(1, Math.ceil(width))
  const pxHeight = Math.max(1, Math.ceil(height))

  tasks.get(canvas)?.cancel()

  canvas.width = pxWidth
  canvas.height = pxHeight
  canvas.style.width = `${Math.round(pxWidth / scale)}px`
  canvas.style.height = 'auto'

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable.')
  ctx.clearRect(0, 0, pxWidth, pxHeight)

  const task = page.render({ canvasContext: ctx, viewport, transform, background: '#ffffff' })
  tasks.set(canvas, task)
  try {
    await task.promise
  } catch (err) {
    if ((err as { name?: string })?.name === 'RenderingCancelledException') {
      return { width: pxWidth / scale, height: pxHeight / scale }
    }
    throw err
  } finally {
    if (tasks.get(canvas) === task) tasks.delete(canvas)
  }
  return { width: pxWidth / scale, height: pxHeight / scale }
}

/** Renders a sequence of regions (D-3: a problem may span pages) into one container. */
export async function renderRegions(
  slot: PdfSlot,
  regions: Region[],
  container: HTMLElement,
  scale = 2,
): Promise<void> {
  container.replaceChildren()
  for (const region of regions) {
    const canvas = document.createElement('canvas')
    canvas.className = 'render'
    container.append(canvas)
    await renderRegion(slot, region.page, canvas, { bbox: region.bbox, scale })
  }
}

/**
 * D-7: best-effort text for copy-paste only. Math and figures do not survive this;
 * the rendering is the source of truth.
 */
export async function extractText(
  slot: PdfSlot,
  pageIndex: number,
  bbox?: Bbox | null,
): Promise<string> {
  const page = await getPage(slot, pageIndex)
  const content = await page.getTextContent()
  const lines: string[] = []
  let line = ''
  for (const item of content.items) {
    if (!('str' in item)) continue
    if (bbox) {
      const x = item.transform[4] as number
      const y = item.transform[5] as number
      if (x < bbox[0] - PAD || x > bbox[2] + PAD || y < bbox[1] - PAD || y > bbox[3] + PAD) {
        continue
      }
    }
    line += item.str
    if (item.hasEOL) {
      lines.push(line)
      line = ''
    }
  }
  if (line) lines.push(line)
  return lines.join('\n').replace(/[ \t]+\n/g, '\n').trim()
}

export interface PageRender {
  /** Page size in PDF points. */
  width: number
  height: number
  /** Canvas-pixel coordinates back to PDF user space, for drawing a bbox (D-8). */
  toPdfPoint(x: number, y: number): [number, number]
}

/**
 * D-8 fallback: renders a whole page and hands back the mapping needed to turn a
 * dragged rectangle into a bbox in the index's coordinate system.
 */
export async function renderPage(
  slot: PdfSlot,
  pageIndex: number,
  canvas: HTMLCanvasElement,
  scale = 2,
): Promise<PageRender> {
  const page = await getPage(slot, pageIndex)
  const viewport = page.getViewport({ scale })
  await renderRegion(slot, pageIndex, canvas, { bbox: null, scale })
  return {
    width: viewport.width / scale,
    height: viewport.height / scale,
    toPdfPoint(x, y) {
      const [px, py] = viewport.convertToPdfPoint(x, y)
      return [px as number, py as number]
    },
  }
}

/**
 * Orders a dragged selection into the index's [x0, y0, x1, y1] convention, rounded to
 * hundredths of a point so an exported override reads like a hand-written index entry.
 */
export function normalizeBbox(a: [number, number], b: [number, number]): Bbox {
  const round = (n: number) => Math.round(n * 100) / 100
  return [
    round(Math.min(a[0], b[0])),
    round(Math.min(a[1], b[1])),
    round(Math.max(a[0], b[0])),
    round(Math.max(a[1], b[1])),
  ]
}
