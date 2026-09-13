// D-5: canonical problem key is `<chapter>.<number>` with an optional letter suffix.
// The parser is deliberately forgiving (C4) and never silently drops a fragment it
// does not understand: unrecognized pieces come back for the user to correct.

export interface ParsedKey {
  chapter: string
  number: number
  suffix: string
}

export interface ParseResult {
  /** Canonical keys, de-duplicated, in the order they were written. */
  keys: string[]
  /** Fragments the parser could not turn into a key, verbatim, with a reason. */
  unrecognized: { text: string; reason: string }[]
  /** Page references seen along the way (`pp. 180-190`), kept as a D-6/D-8 hint. */
  pageHints: string[]
}

/** Refuse to expand an implausible range rather than generating thousands of keys. */
const MAX_RANGE = 200

const CHAPTER_HEADER =
  /^\s*(?:ch(?:apter|ap)?|sec(?:tion)?|§|unit|lesson)\s*\.?\s*(\d+)\s*(?:[:.)\-–—]|\b)\s*/i
const NOISE_WORD = /^(?:problems?|exercises?|questions?|probs?|do|and|nos?\.?|number|numbers|#)$/i
const PAGE_WORD = /^(?:p|pp|pg|pgs|page|pages)\.?$/i
const PAGE_INLINE = /^(?:p|pp|pg|pgs|page|pages)\.?\s*([\d\-–—\s]+)$/i

const KEY_TOKEN = /^(\d+)\.(\d+)([a-z]{1,2})?$/i
const BARE_TOKEN = /^(\d+)([a-z]{1,2})?$/i

export function canonicalKey(chapter: string, number: number, suffix = ''): string {
  return `${chapter}.${number}${suffix.toLowerCase()}`
}

export function parseKey(key: string): ParsedKey | null {
  const m = KEY_TOKEN.exec(key.trim())
  if (!m) return null
  return { chapter: m[1]!, number: Number(m[2]), suffix: (m[3] ?? '').toLowerCase() }
}

/** Sorts keys the way a problem set reads: chapter, then number, then suffix. */
export function compareKeys(a: string, b: string): number {
  const pa = parseKey(a)
  const pb = parseKey(b)
  if (!pa || !pb) return a.localeCompare(b)
  return (
    Number(pa.chapter) - Number(pb.chapter) ||
    pa.number - pb.number ||
    pa.suffix.localeCompare(pb.suffix)
  )
}

/** `a`..`c` -> ['a','b','c']; returns null for anything that is not a simple run. */
function letterRun(from: string, to: string): string[] | null {
  if (from.length !== 1 || to.length !== 1) return null
  const start = from.charCodeAt(0)
  const end = to.charCodeAt(0)
  if (end < start || end - start > 25) return null
  const out: string[] = []
  for (let c = start; c <= end; c++) out.push(String.fromCharCode(c))
  return out
}

/**
 * Normalizes the many ways a range gets written (`16-20`, `16 – 20`, `16 to 20`)
 * into a single `16-20` form so whitespace splitting cannot break a range apart.
 */
function normalizeRanges(line: string): string {
  return line
    .replace(/[‐-―]/g, '-')
    .replace(/\s*\b(?:to|through|thru|until)\b\s*(?=\d)/gi, '-')
    .replace(/\s*-\s*/g, '-')
}

interface Emit {
  push(key: string): void
  reject(text: string, reason: string): void
}

function emitRange(
  token: string,
  left: ParsedKey,
  right: ParsedKey,
  out: Emit,
): void {
  if (left.chapter !== right.chapter) {
    out.reject(token, 'range crosses chapters')
    return
  }
  if (left.number === right.number && (left.suffix || right.suffix)) {
    const letters = letterRun(left.suffix || 'a', right.suffix || 'a')
    if (!letters) {
      out.reject(token, 'unreadable letter range')
      return
    }
    for (const l of letters) out.push(canonicalKey(left.chapter, left.number, l))
    return
  }
  if (left.suffix || right.suffix) {
    out.reject(token, 'range with letter suffixes is ambiguous')
    return
  }
  if (right.number < left.number) {
    out.reject(token, 'range runs backwards')
    return
  }
  if (right.number - left.number + 1 > MAX_RANGE) {
    out.reject(token, `range longer than ${MAX_RANGE} problems`)
    return
  }
  for (let n = left.number; n <= right.number; n++) out.push(canonicalKey(left.chapter, n))
}

function readToken(token: string, chapter: string | null): ParsedKey | null {
  const withChapter = KEY_TOKEN.exec(token)
  if (withChapter) {
    return {
      chapter: withChapter[1]!,
      number: Number(withChapter[2]),
      suffix: (withChapter[3] ?? '').toLowerCase(),
    }
  }
  const bare = BARE_TOKEN.exec(token)
  if (bare && chapter) {
    return { chapter, number: Number(bare[1]), suffix: (bare[2] ?? '').toLowerCase() }
  }
  return null
}

/**
 * Parses an assignment as the course writes it. Chapter context set by a header
 * (`Ch 3:`) carries forward across lines until another header replaces it, so both
 * `Ch 3: 14, 16-20` and a `Chapter 3` line followed by bare numbers work.
 */
export function parseAssignment(
  input: string,
  options: { defaultChapter?: string } = {},
): ParseResult {
  const keys: string[] = []
  const seen = new Set<string>()
  const unrecognized: ParseResult['unrecognized'] = []
  const pageHints: string[] = []
  let chapter: string | null = options.defaultChapter ?? null

  const out: Emit = {
    push(key) {
      if (!seen.has(key)) {
        seen.add(key)
        keys.push(key)
      }
    },
    reject(text, reason) {
      if (text.trim()) unrecognized.push({ text: text.trim(), reason })
    },
  }

  for (const rawLine of input.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (!line) continue

    const header = CHAPTER_HEADER.exec(line)
    if (header) {
      chapter = header[1]!
      line = line.slice(header[0].length)
    }

    line = normalizeRanges(line)
    let expectingPage = false

    for (const raw of line.split(/[,;\s]+/)) {
      // Course notation sprinkles brackets and trailing colons around numbers.
      const token = raw.replace(/^[#([]+/, '').replace(/[):\].]+$/, '')
      if (!token) continue

      if (PAGE_WORD.test(token)) {
        expectingPage = true
        continue
      }
      const inlinePage = PAGE_INLINE.exec(token)
      if (inlinePage) {
        pageHints.push(inlinePage[1]!.trim())
        continue
      }
      if (expectingPage) {
        expectingPage = false
        if (/^\d[\d-]*$/.test(token)) {
          pageHints.push(token)
          continue
        }
      }
      if (NOISE_WORD.test(token)) continue

      const parts = token.split('-')
      if (parts.length === 2) {
        const left = readToken(parts[0]!, chapter)
        const right = /^[a-z]{1,2}$/i.test(parts[1]!)
          ? left && { ...left, suffix: parts[1]!.toLowerCase() }
          : readToken(parts[1]!, left?.chapter ?? chapter)
        if (!left || !right) {
          out.reject(token, chapter ? 'not a problem range' : 'no chapter given')
          continue
        }
        emitRange(token, left, right, out)
        continue
      }
      if (parts.length > 2) {
        out.reject(token, 'not a problem range')
        continue
      }

      const single = readToken(token, chapter)
      if (!single) {
        out.reject(token, chapter ? 'not a problem number' : 'no chapter given')
        continue
      }
      out.push(canonicalKey(single.chapter, single.number, single.suffix))
    }
  }

  return { keys, unrecognized, pageHints }
}
