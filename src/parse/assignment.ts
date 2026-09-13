// D-5 (amended 2026-09-13): a canonical key is the dotted path that identifies a problem,
// plus an optional letter suffix. Books numbered per chapter give two parts (`3.14`);
// books numbered per section, as Thomas' Calculus is, give three (`12.3.7`, `12.3.7a`).
//
// The parser is deliberately forgiving (C4) and never silently drops a fragment it does
// not understand: unrecognized pieces come back for the user to correct.

export interface ParsedKey {
  /** `[chapter, number]` or `[chapter, section, number]`. */
  parts: number[]
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

/** `Section 12.3:`, `§12.3`, `Ch 3:` - a word makes it unambiguously a header. */
const WORD_HEADER =
  /^\s*(?:§|section|sect|sec|chapter|chap|ch|unit|lesson)\.?\s*(\d{1,2}(?:\.\d{1,2})?)\s*[:.#)\]]?\s*/i
/** `12.3:` - a bare dotted prefix needs a colon or hash to read as a header. */
const NUMERIC_HEADER = /^\s*(\d{1,2}\.\d{1,2})\s*[:#]\s*/

const NOISE_WORD =
  /^(?:problems?|exercises?|questions?|probs?|do|and|also|nos?\.?|number|numbers|#)$/i
/** `pp. 700-705`, `page 700` - a page reference anywhere in the line (D-6, D-8 hint). */
const PAGE_REF = /\b(?:pp?|pgs?|pages?)\.?\s*(\d{1,4}(?:\s*[-‐-―]\s*\d{1,4})?)/gi
const PARITY_WORD = /^(odd|even)s?$/i

/** A full dotted key: two or three parts, optional letter suffix. */
const ABSOLUTE_TOKEN = /^(\d{1,2}(?:\.\d{1,3}){1,2})([a-z]{1,2})?$/i
/** A problem number on its own, meaningful only under a section or chapter header. */
const BARE_TOKEN = /^(\d{1,3})([a-z]{1,2})?$/i

export function canonicalKey(parts: number[], suffix = ''): string {
  return `${parts.join('.')}${suffix.toLowerCase()}`
}

export function parseKey(key: string): ParsedKey | null {
  const m = ABSOLUTE_TOKEN.exec(key.trim())
  if (!m) return null
  return {
    parts: m[1]!.split('.').map(Number),
    suffix: (m[2] ?? '').toLowerCase(),
  }
}

/** Sorts keys the way a problem set reads: by each dotted part, then by suffix. */
export function compareKeys(a: string, b: string): number {
  const pa = parseKey(a)
  const pb = parseKey(b)
  if (!pa || !pb) return a.localeCompare(b)
  const depth = Math.max(pa.parts.length, pb.parts.length)
  for (let i = 0; i < depth; i++) {
    const diff = (pa.parts[i] ?? -1) - (pb.parts[i] ?? -1)
    if (diff !== 0) return diff
  }
  return pa.suffix.localeCompare(pb.suffix)
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

/** Resolves one token against the current header context, or null if it cannot be. */
function readToken(token: string, context: number[] | null): ParsedKey | null {
  const absolute = ABSOLUTE_TOKEN.exec(token)
  if (absolute) {
    return {
      parts: absolute[1]!.split('.').map(Number),
      suffix: (absolute[2] ?? '').toLowerCase(),
    }
  }
  const bare = BARE_TOKEN.exec(token)
  if (bare && context) {
    return { parts: [...context, Number(bare[1])], suffix: (bare[2] ?? '').toLowerCase() }
  }
  return null
}

function samePath(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** Expands `25-34` (and `14a-c`) into the keys it covers. */
function expandRange(
  token: string,
  left: ParsedKey,
  right: ParsedKey,
  reject: (text: string, reason: string) => void,
): string[] | null {
  const leftPath = left.parts.slice(0, -1)
  const rightPath = right.parts.slice(0, -1)
  const from = left.parts.at(-1)!
  const to = right.parts.at(-1)!

  if (!samePath(leftPath, rightPath)) {
    reject(token, 'range crosses sections')
    return null
  }
  if (from === to && (left.suffix || right.suffix)) {
    const letters = letterRun(left.suffix || 'a', right.suffix || 'a')
    if (!letters) {
      reject(token, 'unreadable letter range')
      return null
    }
    return letters.map((letter) => canonicalKey(left.parts, letter))
  }
  if (left.suffix || right.suffix) {
    reject(token, 'range with letter suffixes is ambiguous')
    return null
  }
  if (to < from) {
    reject(token, 'range runs backwards')
    return null
  }
  if (to - from + 1 > MAX_RANGE) {
    reject(token, `range longer than ${MAX_RANGE} problems`)
    return null
  }
  const out: string[] = []
  for (let n = from; n <= to; n++) out.push(canonicalKey([...leftPath, n]))
  return out
}

/**
 * Parses an assignment as the course writes it. Header context (`12.3:`, `Section 12.3`,
 * `Ch 3:`) carries forward across lines until another header replaces it, so both
 * `12.3: 1, 5-9` and a `Section 12.3` line followed by bare numbers work. A range may be
 * narrowed by a trailing `odd` or `even`, as assignments in this course often are.
 */
export function parseAssignment(
  input: string,
  options: { defaultSection?: string } = {},
): ParseResult {
  const keys: string[] = []
  const seen = new Set<string>()
  const unrecognized: ParseResult['unrecognized'] = []
  const pageHints: string[] = []

  let context: number[] | null = options.defaultSection
    ? options.defaultSection.split('.').map(Number)
    : null

  const push = (key: string) => {
    if (!seen.has(key)) {
      seen.add(key)
      keys.push(key)
    }
  }
  const reject = (text: string, reason: string) => {
    if (text.trim()) unrecognized.push({ text: text.trim(), reason })
  }

  for (const rawLine of input.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (!line) continue

    // Pull page references out first. They are a hint, not a key, and in
    // "12.3, pp. 700-705: 1, 2" the comma would otherwise hide the section header.
    line = line.replace(PAGE_REF, (_full, ref: string) => {
      pageHints.push(ref.replace(/\s*[-‐-―]\s*/, '-'))
      return ' '
    })
    line = line.replace(/[,;]\s*(?=[,;:])/g, ' ').replace(/[,;]\s*:/g, ':').trim()
    if (!line) continue

    const header = WORD_HEADER.exec(line) ?? NUMERIC_HEADER.exec(line)
    if (header) {
      context = header[1]!.split('.').map(Number)
      line = line.slice(header[0].length)
    }

    line = normalizeRanges(line)
    const tokens = line
      .split(/[,;\s]+/)
      // Course notation sprinkles brackets and trailing colons around numbers.
      .map((t) => t.replace(/^[#([]+/, '').replace(/[):\].]+$/, ''))
      .filter(Boolean)

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!

      // A parity word is consumed by the range it follows; alone it means nothing.
      if (PARITY_WORD.test(token) || NOISE_WORD.test(token)) continue

      const parts = token.split('-')
      if (parts.length > 2) {
        reject(token, 'not a problem range')
        continue
      }

      if (parts.length === 2) {
        const left = readToken(parts[0]!, context)
        const right = /^[a-z]{1,2}$/i.test(parts[1]!)
          ? left && { ...left, suffix: parts[1]!.toLowerCase() }
          : readToken(parts[1]!, left ? left.parts.slice(0, -1) : context)
        if (!left || !right) {
          reject(token, context ? 'not a problem range' : 'no section given')
          continue
        }
        const expanded = expandRange(token, left, right, reject)
        if (!expanded) continue

        // `25-34 odd` keeps the odd-numbered problems only.
        const parity = PARITY_WORD.exec(tokens[i + 1] ?? '')
        if (parity) {
          i++
          const wantOdd = parity[1]!.toLowerCase() === 'odd'
          for (const key of expanded) {
            const n = parseKey(key)?.parts.at(-1)
            if (n !== undefined && n % 2 === (wantOdd ? 1 : 0)) push(key)
          }
          continue
        }
        for (const key of expanded) push(key)
        continue
      }

      const single = readToken(token, context)
      if (!single) {
        reject(token, context ? 'not a problem number' : 'no section given')
        continue
      }
      push(canonicalKey(single.parts, single.suffix))
    }
  }

  return { keys, unrecognized, pageHints }
}
