// D-3: index.json is the only book-derived artifact in the repo -- locations, never text.
// D-8: local overrides for keys missing from the committed index are merged in here, at
// load, so the rest of the app never has to know where a region came from.

import { STORE_OVERRIDES, getAll, put, type OverrideRecord } from '../state/db'
import type { Bbox, Region } from '../pdf/render'

/** A location in the index: one region, or a list when the problem spans pages (D-3). */
type RawLocation = Region | Region[] | null | undefined

export interface RawProblemEntry {
  text?: RawLocation
  solution?: RawLocation
}

export interface ProblemIndex {
  book: string
  problems: Record<string, RawProblemEntry>
}

export type RegionSource = 'index' | 'override'

export interface ResolvedProblem {
  key: string
  text: Region[]
  solution: Region[]
  textSource: RegionSource | null
  solutionSource: RegionSource | null
  /** False when the manual does not cover this problem (Q2) or it was never indexed. */
  hasSolution: boolean
  /** True when neither the index nor an override locates the problem text (D-8). */
  missing: boolean
}

const EMPTY_INDEX: ProblemIndex = { book: 'Unknown book', problems: {} }

let cached: Promise<ProblemIndex> | null = null
let overrides: Map<string, OverrideRecord> | null = null

function toRegions(location: RawLocation): Region[] {
  if (!location) return []
  const list = Array.isArray(location) ? location : [location]
  return list.filter(
    (r): r is Region =>
      !!r && typeof r.page === 'number' && Array.isArray(r.bbox) && r.bbox.length === 4,
  )
}

export async function loadIndex(): Promise<ProblemIndex> {
  if (!cached) {
    cached = (async () => {
      try {
        const res = await fetch(new URL('index.json', document.baseURI), { cache: 'no-cache' })
        if (!res.ok) throw new Error(`index.json: HTTP ${res.status}`)
        const data = (await res.json()) as Partial<ProblemIndex>
        return {
          book: data.book ?? EMPTY_INDEX.book,
          problems: data.problems ?? {},
        }
      } catch (err) {
        console.warn('No usable index.json; every problem falls back to D-8.', err)
        return { ...EMPTY_INDEX }
      }
    })()
  }
  return cached
}

async function loadOverrides(): Promise<Map<string, OverrideRecord>> {
  if (!overrides) {
    const rows = await getAll<OverrideRecord>(STORE_OVERRIDES)
    overrides = new Map(rows.map((r) => [r.id, r]))
  }
  return overrides
}

/** Index plus overrides, with overrides winning field by field (D-8). */
export async function resolveProblem(key: string): Promise<ResolvedProblem> {
  const [index, over] = await Promise.all([loadIndex(), loadOverrides()])
  const entry = index.problems[key]
  const override = over.get(key)

  const indexText = toRegions(entry?.text)
  const indexSolution = toRegions(entry?.solution)
  const overrideText = toRegions(override?.text)
  const overrideSolution = toRegions(override?.solution)

  const text = overrideText.length ? overrideText : indexText
  const solution = overrideSolution.length ? overrideSolution : indexSolution

  return {
    key,
    text,
    solution,
    textSource: overrideText.length ? 'override' : indexText.length ? 'index' : null,
    solutionSource: overrideSolution.length ? 'override' : indexSolution.length ? 'index' : null,
    hasSolution: solution.length > 0,
    missing: text.length === 0,
  }
}

export async function resolveAll(keys: string[]): Promise<Map<string, ResolvedProblem>> {
  const entries = await Promise.all(keys.map(async (k) => [k, await resolveProblem(k)] as const))
  return new Map(entries)
}

/** D-8: "mark this region as problem X" writes here. */
export async function saveOverride(
  key: string,
  which: 'text' | 'solution',
  regions: { page: number; bbox: Bbox }[],
): Promise<void> {
  const map = await loadOverrides()
  const existing = map.get(key)
  const record: OverrideRecord = {
    id: key,
    text: which === 'text' ? regions : existing?.text,
    solution: which === 'solution' ? regions : existing?.solution,
    updated: new Date().toISOString(),
  }
  await put(STORE_OVERRIDES, record)
  map.set(key, record)
}

export async function overrideCount(): Promise<number> {
  return (await loadOverrides()).size
}

/**
 * D-8: overrides export in index.json's own shape so the file can be merged into the
 * committed index by hand (or with `python tools/build_index.py --merge`).
 */
export async function exportOverridesAsIndex(): Promise<ProblemIndex> {
  const [index, map] = await Promise.all([loadIndex(), loadOverrides()])
  const problems: Record<string, RawProblemEntry> = {}
  for (const [key, record] of map) {
    const entry: RawProblemEntry = {}
    if (record.text?.length) entry.text = record.text
    if (record.solution?.length) entry.solution = record.solution
    problems[key] = entry
  }
  return { book: index.book, problems }
}

/** Called after an import replaces the override store (D-10). */
export function invalidateOverrides(): void {
  overrides = null
}
