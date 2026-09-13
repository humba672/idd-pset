// D-10: assignments, attempts, settings and index overrides live in one versioned
// IndexedDB database. Export/import of the whole thing as a single JSON file is the
// only backup mechanism.

export const DB_NAME = 'idd-pset'
export const DB_VERSION = 1

export const STORE_ASSIGNMENTS = 'assignments'
export const STORE_ATTEMPTS = 'attempts'
export const STORE_SETTINGS = 'settings'
export const STORE_OVERRIDES = 'overrides'
/** D-2 fallback: PDF blobs when OPFS is unavailable. Never included in an export. */
export const STORE_PDFS = 'pdfs'

const ALL_STORES = [
  STORE_ASSIGNMENTS,
  STORE_ATTEMPTS,
  STORE_SETTINGS,
  STORE_OVERRIDES,
  STORE_PDFS,
] as const

/** D-9 */
export type AttemptStatus =
  | 'unattempted'
  | 'attempted'
  | 'correct'
  | 'incorrect'
  | 'partial'

/** D-9: an assignment is {id, title, created, keys[]}. */
export interface Assignment {
  id: string
  title: string
  created: string
  keys: string[]
  /** Free-text page range the user typed, kept for the D-8 fallback's starting guess. */
  pageHint?: string
}

/**
 * D-9 per-key attempt record. `revealed` is view state, not status (see D-9).
 *
 * There is no answer field: Rajiv works problems on paper and only records the verdict
 * (2026-09-13 ruling, superseding D-11). `notes` is for anything worth reading back at
 * review time - "sign error in part b", "redo this one".
 */
export interface Attempt {
  /** `${assignmentId}::${problemKey}` */
  id: string
  assignmentId: string
  key: string
  status: AttemptStatus
  notes: string
  revealed: boolean
  updated: string
}

/** D-6: printed page = PDF page + offset, one integer per PDF. */
export interface Settings {
  textbookOffset: number
  solutionOffset: number
  showExtractedText: boolean
  renderScale: number
}

/**
 * The offsets default to the copies this install is built around - Thomas' Calculus:
 * Early Transcendentals 13th ed and its instructor manual - measured from their front
 * matter: printed page 11 is PDF page 24 in the textbook, printed 3 is PDF 8 in the
 * manual. Settings still overrides them (D-6); a different scan of the same book, or a
 * different book, only needs the number changed there.
 */
export const DEFAULT_SETTINGS: Settings = {
  textbookOffset: -13,
  solutionOffset: -5,
  showExtractedText: false,
  renderScale: 2,
}

/** D-8: a locally drawn region for a key missing from the committed index. */
export interface OverrideRecord {
  /** problem key */
  id: string
  text?: { page: number; bbox: [number, number, number, number] }[]
  solution?: { page: number; bbox: [number, number, number, number] }[]
  updated: string
}

export interface ExportBundle {
  format: 'idd-pset-export'
  version: number
  exported: string
  assignments: Assignment[]
  attempts: Attempt[]
  settings: Settings
  overrides: OverrideRecord[]
}

let dbPromise: Promise<IDBDatabase> | null = null

export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        for (const name of ALL_STORES) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: 'id' })
          }
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = run(t.objectStore(store))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

export function getAll<T>(store: string): Promise<T[]> {
  return tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>)
}

export function get<T>(store: string, id: string): Promise<T | undefined> {
  return tx<T | undefined>(store, 'readonly', (s) => s.get(id) as IDBRequest<T | undefined>)
}

export function put<T extends { id: string }>(store: string, value: T): Promise<T> {
  return tx(store, 'readwrite', (s) => s.put(value) as IDBRequest<IDBValidKey>).then(() => value)
}

export function del(store: string, id: string): Promise<void> {
  return tx(store, 'readwrite', (s) => s.delete(id) as IDBRequest<undefined>).then(() => undefined)
}

export function clearStore(store: string): Promise<void> {
  return tx(store, 'readwrite', (s) => s.clear() as IDBRequest<undefined>).then(() => undefined)
}

// --- domain helpers -------------------------------------------------------

export function attemptId(assignmentId: string, key: string): string {
  return `${assignmentId}::${key}`
}

export function newAttempt(assignmentId: string, key: string): Attempt {
  return {
    id: attemptId(assignmentId, key),
    assignmentId,
    key,
    status: 'unattempted',
    notes: '',
    revealed: false,
    updated: new Date().toISOString(),
  }
}

export async function loadAttempt(assignmentId: string, key: string): Promise<Attempt> {
  const existing = await get<Attempt>(STORE_ATTEMPTS, attemptId(assignmentId, key))
  return existing ?? newAttempt(assignmentId, key)
}

export async function saveAttempt(attempt: Attempt): Promise<Attempt> {
  return put(STORE_ATTEMPTS, { ...attempt, updated: new Date().toISOString() })
}

export async function loadSettings(): Promise<Settings> {
  const row = await get<Settings & { id: string }>(STORE_SETTINGS, 'settings')
  if (!row) return { ...DEFAULT_SETTINGS }
  const { id: _id, ...rest } = row
  return { ...DEFAULT_SETTINGS, ...rest }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await put(STORE_SETTINGS, { id: 'settings', ...settings })
}

export async function deleteAssignment(id: string): Promise<void> {
  const attempts = await getAll<Attempt>(STORE_ATTEMPTS)
  await Promise.all(
    attempts.filter((a) => a.assignmentId === id).map((a) => del(STORE_ATTEMPTS, a.id)),
  )
  await del(STORE_ASSIGNMENTS, id)
}

export function newId(): string {
  return crypto.randomUUID()
}

// --- D-10: export / import -------------------------------------------------

export async function exportAll(): Promise<ExportBundle> {
  const [assignments, attempts, settings, overrides] = await Promise.all([
    getAll<Assignment>(STORE_ASSIGNMENTS),
    getAll<Attempt>(STORE_ATTEMPTS),
    loadSettings(),
    getAll<OverrideRecord>(STORE_OVERRIDES),
  ])
  return {
    format: 'idd-pset-export',
    version: DB_VERSION,
    exported: new Date().toISOString(),
    assignments,
    attempts,
    settings,
    overrides,
  }
}

/**
 * Replaces assignments, attempts, settings and overrides with the bundle's contents.
 * PDF blobs are untouched: they are not part of an export (C2, D-2).
 */
export async function importAll(bundle: unknown): Promise<void> {
  const b = bundle as Partial<ExportBundle>
  if (!b || b.format !== 'idd-pset-export' || !Array.isArray(b.assignments)) {
    throw new Error('Not an IDD-PSET export file.')
  }
  await Promise.all([
    clearStore(STORE_ASSIGNMENTS),
    clearStore(STORE_ATTEMPTS),
    clearStore(STORE_OVERRIDES),
  ])
  for (const a of b.assignments) await put(STORE_ASSIGNMENTS, a)
  for (const a of b.attempts ?? []) await put(STORE_ATTEMPTS, a)
  for (const o of b.overrides ?? []) await put(STORE_OVERRIDES, o)
  if (b.settings) await saveSettings({ ...DEFAULT_SETTINGS, ...b.settings })
}
