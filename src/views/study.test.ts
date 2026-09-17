// D-14: the study view's choice of problem is unit tested. Rendering is not (D-7).
import { describe, expect, it } from 'vitest'
import { chapterOf, eligibleKeys, pickOne, studyTitle } from './study'

const SOLVABLE = ['12.3.1', '12.3.2', '12.3.10', '12.4.1', '13.1.1']

describe('chapterOf', () => {
  it('reads the chapter off a key of either depth', () => {
    expect(chapterOf('12.3.7')).toBe('12')
    expect(chapterOf('3.14')).toBe('3')
    expect(chapterOf('nonsense')).toBeNull()
  })
})

describe('eligibleKeys', () => {
  it('keeps only this chapter', () => {
    expect(eligibleKeys(SOLVABLE, new Set(), '12')).toEqual([
      '12.3.1',
      '12.3.2',
      '12.3.10',
      '12.4.1',
    ])
  })

  it('leaves out anything an assignment has already named', () => {
    const used = new Set(['12.3.1', '12.4.1'])
    expect(eligibleKeys(SOLVABLE, used, '12')).toEqual(['12.3.2', '12.3.10'])
  })

  it('returns nothing once the chapter is exhausted', () => {
    expect(eligibleKeys(SOLVABLE, new Set(SOLVABLE), '12')).toEqual([])
  })

  it('sorts the way a problem set reads', () => {
    expect(eligibleKeys(['12.3.10', '12.3.2'], new Set(), '12')).toEqual(['12.3.2', '12.3.10'])
  })

  it('never offers a problem with no worked solution, because it is not in the pool', () => {
    // The caller passes only problems carrying both halves; this pins the contract.
    const solvableOnly = ['12.3.2']
    expect(eligibleKeys(solvableOnly, new Set(), '12')).toEqual(['12.3.2'])
  })
})

describe('pickOne', () => {
  it('picks by the given draw', () => {
    expect(pickOne(['a', 'b', 'c'], () => 0)).toBe('a')
    expect(pickOne(['a', 'b', 'c'], () => 0.99)).toBe('c')
  })

  it('returns nothing from an empty pool', () => {
    expect(pickOne([], () => 0)).toBeNull()
  })

  it('can reach every problem in the pool', () => {
    const pool = ['a', 'b', 'c', 'd']
    const seen = new Set(pool.map((_, i) => pickOne(pool, () => i / pool.length)))
    expect(seen).toEqual(new Set(pool))
  })
})

describe('studyTitle', () => {
  it('names one assignment per chapter, so drawing twice extends it', () => {
    expect(studyTitle('12')).toBe(studyTitle('12'))
    expect(studyTitle('12')).not.toBe(studyTitle('13'))
    expect(studyTitle('12')).toContain('12')
  })
})
