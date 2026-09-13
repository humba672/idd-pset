// D-14: the assignment parser has unit tests.
import { describe, expect, it } from 'vitest'
import { canonicalKey, compareKeys, parseAssignment, parseKey } from './assignment'

const keysOf = (input: string, defaultChapter?: string) =>
  parseAssignment(input, defaultChapter ? { defaultChapter } : {}).keys

describe('canonical keys', () => {
  it('formats chapter.number with optional suffix', () => {
    expect(canonicalKey('3', 14)).toBe('3.14')
    expect(canonicalKey('3', 14, 'A')).toBe('3.14a')
  })

  it('round-trips through parseKey', () => {
    expect(parseKey('3.14a')).toEqual({ chapter: '3', number: 14, suffix: 'a' })
    expect(parseKey('14')).toBeNull()
  })

  it('sorts by chapter, then number, then suffix', () => {
    expect(['3.16', '3.2', '10.1', '3.2a'].sort(compareKeys)).toEqual([
      '3.2',
      '3.2a',
      '3.16',
      '10.1',
    ])
  })
})

describe('parseAssignment', () => {
  it('parses the notation in D-5 verbatim', () => {
    expect(keysOf('3.14, 3.16-3.20, 3.22a')).toEqual([
      '3.14',
      '3.16',
      '3.17',
      '3.18',
      '3.19',
      '3.20',
      '3.22a',
    ])
    expect(keysOf('Ch 3: 14, 16-20')).toEqual(['3.14', '3.16', '3.17', '3.18', '3.19', '3.20'])
  })

  it('carries chapter context across lines until a new header', () => {
    expect(keysOf('Chapter 3\n14\n16-17\nCh. 4: 1')).toEqual(['3.14', '3.16', '3.17', '4.1'])
  })

  it('accepts one problem per line', () => {
    expect(keysOf('3.14\n3.15\n3.16')).toEqual(['3.14', '3.15', '3.16'])
  })

  it('tolerates dashes, "to", and stray whitespace', () => {
    expect(keysOf('Ch 3: 16 – 18')).toEqual(['3.16', '3.17', '3.18'])
    expect(keysOf('Ch 3: 16 to 18')).toEqual(['3.16', '3.17', '3.18'])
    expect(keysOf('  3.16 -3.18  ')).toEqual(['3.16', '3.17', '3.18'])
  })

  it('ignores filler words and section signs', () => {
    expect(keysOf('Problems: 3.1, 3.2 and 3.3')).toEqual(['3.1', '3.2', '3.3'])
    expect(keysOf('§3: exercises 1, 2')).toEqual(['3.1', '3.2'])
  })

  it('expands a letter run within one problem', () => {
    expect(keysOf('3.14a-c')).toEqual(['3.14a', '3.14b', '3.14c'])
  })

  it('de-duplicates while keeping written order', () => {
    expect(keysOf('3.5, 3.4, 3.5, 3.4-3.5')).toEqual(['3.5', '3.4'])
  })

  it('keeps page references as hints rather than keys', () => {
    const result = parseAssignment('Ch 3, pp. 180-190: 14, 15')
    expect(result.keys).toEqual(['3.14', '3.15'])
    expect(result.pageHints).toEqual(['180-190'])
    expect(result.unrecognized).toEqual([])
  })

  it('reports bare numbers with no chapter instead of dropping them', () => {
    const result = parseAssignment('14, 16')
    expect(result.keys).toEqual([])
    expect(result.unrecognized.map((u) => u.text)).toEqual(['14', '16'])
  })

  it('uses a default chapter when one is supplied', () => {
    expect(keysOf('14, 16', '3')).toEqual(['3.14', '3.16'])
  })

  it('reports ranges it refuses to expand', () => {
    const backwards = parseAssignment('3.20-3.14')
    expect(backwards.keys).toEqual([])
    expect(backwards.unrecognized[0]?.reason).toBe('range runs backwards')

    const crossing = parseAssignment('3.20-4.2')
    expect(crossing.unrecognized[0]?.reason).toBe('range crosses chapters')

    const huge = parseAssignment('3.1-3.999')
    expect(huge.unrecognized[0]?.reason).toMatch(/longer than/)
  })

  it('reports unreadable fragments verbatim', () => {
    const result = parseAssignment('Ch 3: 14, the hard one, 16')
    expect(result.keys).toEqual(['3.14', '3.16'])
    expect(result.unrecognized.map((u) => u.text)).toEqual(['the', 'hard', 'one'])
  })

  it('returns nothing for empty input', () => {
    expect(parseAssignment('   \n  ')).toEqual({ keys: [], unrecognized: [], pageHints: [] })
  })
})
