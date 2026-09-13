// D-14: the assignment parser has unit tests.
import { describe, expect, it } from 'vitest'
import { canonicalKey, compareKeys, parseAssignment, parseKey } from './assignment'

const keysOf = (input: string, defaultSection?: string) =>
  parseAssignment(input, defaultSection ? { defaultSection } : {}).keys

describe('canonical keys', () => {
  it('formats a dotted path with an optional suffix', () => {
    expect(canonicalKey([3, 14])).toBe('3.14')
    expect(canonicalKey([12, 3, 7])).toBe('12.3.7')
    expect(canonicalKey([12, 3, 7], 'A')).toBe('12.3.7a')
  })

  it('round-trips through parseKey at either depth', () => {
    expect(parseKey('3.14')).toEqual({ parts: [3, 14], suffix: '' })
    expect(parseKey('12.3.7a')).toEqual({ parts: [12, 3, 7], suffix: 'a' })
    expect(parseKey('14')).toBeNull()
  })

  it('sorts by each part in turn, then by suffix', () => {
    expect(['12.3.16', '12.3.2', '12.10.1', '12.3.2a', '2.1.9'].sort(compareKeys)).toEqual([
      '2.1.9',
      '12.3.2',
      '12.3.2a',
      '12.3.16',
      '12.10.1',
    ])
  })
})

describe('section-numbered books (Thomas)', () => {
  it('parses a section header followed by numbers', () => {
    expect(keysOf('12.3: 1, 5-7')).toEqual(['12.3.1', '12.3.5', '12.3.6', '12.3.7'])
    expect(keysOf('Section 12.3: 1, 5')).toEqual(['12.3.1', '12.3.5'])
    expect(keysOf('§12.3 1, 5')).toEqual(['12.3.1', '12.3.5'])
  })

  it('carries the section across lines until a new header', () => {
    expect(keysOf('Section 12.3\n1\n5-6\n12.4: 2')).toEqual([
      '12.3.1',
      '12.3.5',
      '12.3.6',
      '12.4.2',
    ])
  })

  it('accepts fully-qualified keys with no header', () => {
    expect(keysOf('12.3.7, 12.4.1')).toEqual(['12.3.7', '12.4.1'])
  })

  it('narrows a range with odd or even', () => {
    expect(keysOf('12.3: 1-9 odd')).toEqual(['12.3.1', '12.3.3', '12.3.5', '12.3.7', '12.3.9'])
    expect(keysOf('12.3: 1-8 even')).toEqual(['12.3.2', '12.3.4', '12.3.6', '12.3.8'])
    expect(keysOf('12.3: 1-5 odds, 8')).toEqual(['12.3.1', '12.3.3', '12.3.5', '12.3.8'])
  })

  it('expands a letter run within one problem', () => {
    expect(keysOf('12.3: 7a-c')).toEqual(['12.3.7a', '12.3.7b', '12.3.7c'])
  })

  it('keeps page references as hints rather than keys', () => {
    const result = parseAssignment('12.3, pp. 700-705: 1, 2')
    expect(result.keys).toEqual(['12.3.1', '12.3.2'])
    expect(result.pageHints).toEqual(['700-705'])
    expect(result.unrecognized).toEqual([])
  })

  it('reports a range that crosses sections', () => {
    const result = parseAssignment('12.3.7-12.4.2')
    expect(result.keys).toEqual([])
    expect(result.unrecognized[0]?.reason).toBe('range crosses sections')
  })
})

describe('chapter-numbered books', () => {
  it('still parses the two-part notation in the original D-5', () => {
    expect(keysOf('3.14, 3.16-3.18, 3.22a')).toEqual([
      '3.14',
      '3.16',
      '3.17',
      '3.18',
      '3.22a',
    ])
    expect(keysOf('Ch 3: 14, 16-18')).toEqual(['3.14', '3.16', '3.17', '3.18'])
  })
})

describe('forgiveness (C4)', () => {
  it('tolerates dashes, "to", and stray whitespace', () => {
    expect(keysOf('12.3: 6 – 8')).toEqual(['12.3.6', '12.3.7', '12.3.8'])
    expect(keysOf('12.3: 6 to 8')).toEqual(['12.3.6', '12.3.7', '12.3.8'])
    expect(keysOf('  12.3 :  6 -8  ')).toEqual(['12.3.6', '12.3.7', '12.3.8'])
  })

  it('ignores filler words', () => {
    expect(keysOf('12.3: problems 1, 2 and 3')).toEqual(['12.3.1', '12.3.2', '12.3.3'])
  })

  it('de-duplicates while keeping written order', () => {
    expect(keysOf('12.3: 5, 4, 5, 4-5')).toEqual(['12.3.5', '12.3.4'])
  })

  it('reports bare numbers with no section instead of dropping them', () => {
    const result = parseAssignment('14, 16')
    expect(result.keys).toEqual([])
    expect(result.unrecognized.map((u) => u.text)).toEqual(['14', '16'])
    expect(result.unrecognized[0]?.reason).toBe('no section given')
  })

  it('uses a default section when one is supplied', () => {
    expect(keysOf('14, 16', '12.3')).toEqual(['12.3.14', '12.3.16'])
  })

  it('reports ranges it refuses to expand', () => {
    expect(parseAssignment('12.3: 20-14').unrecognized[0]?.reason).toBe('range runs backwards')
    expect(parseAssignment('12.3: 1-999').unrecognized[0]?.reason).toMatch(/longer than/)
  })

  it('reports unreadable fragments verbatim', () => {
    const result = parseAssignment('12.3: 14, the hard one, 16')
    expect(result.keys).toEqual(['12.3.14', '12.3.16'])
    expect(result.unrecognized.map((u) => u.text)).toEqual(['the', 'hard', 'one'])
  })

  it('returns nothing for empty input', () => {
    expect(parseAssignment('   \n  ')).toEqual({ keys: [], unrecognized: [], pageHints: [] })
  })
})
