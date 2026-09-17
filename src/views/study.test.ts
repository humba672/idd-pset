// D-14: how the study view chooses a practice set is unit tested. Rendering is not (D-7).
import { describe, expect, it } from 'vitest'
import {
  bySection,
  chapterOf,
  drawSet,
  eligibleKeys,
  sample,
  sectionOf,
  studyTitle,
} from './study'

/** A chapter of three sections: 12.1 has 5 problems, 12.2 has 4, 12.3 has 2. */
const SOLVABLE = [
  ...[1, 2, 3, 4, 5].map((n) => `12.1.${n}`),
  ...[1, 2, 3, 4].map((n) => `12.2.${n}`),
  ...[1, 2].map((n) => `12.3.${n}`),
  '13.1.1',
]

/** A predictable stand-in for Math.random: walks the unit interval in fixed steps. */
function cyclingRandom(...values: number[]): () => number {
  let i = 0
  return () => values[i++ % values.length]!
}

describe('keys', () => {
  it('reads chapter and section off a key', () => {
    expect(chapterOf('12.3.7')).toBe('12')
    expect(sectionOf('12.3.7')).toBe('12.3')
  })

  it('treats a chapter-numbered book as having one section per chapter', () => {
    expect(chapterOf('3.14')).toBe('3')
    expect(sectionOf('3.14')).toBe('3')
  })

  it('returns nothing for a key it cannot read', () => {
    expect(chapterOf('nonsense')).toBeNull()
    expect(sectionOf('nonsense')).toBeNull()
  })
})

describe('bySection', () => {
  it('groups a chapter into its sections, in reading order', () => {
    const grouped = bySection(['12.3.1', '12.1.2', '12.10.1', '12.2.1'])
    expect([...grouped.keys()]).toEqual(['12.1', '12.2', '12.3', '12.10'])
  })
})

describe('sample', () => {
  it('takes the number asked for, without repeating', () => {
    const picked = sample(['a', 'b', 'c', 'd'], 3, cyclingRandom(0, 0, 0))
    expect(picked).toHaveLength(3)
    expect(new Set(picked).size).toBe(3)
  })

  it('takes what there is when asked for more', () => {
    expect(sample(['a', 'b'], 5, cyclingRandom(0)).sort()).toEqual(['a', 'b'])
  })

  it('takes nothing from nothing, or when asked for none', () => {
    expect(sample([], 3, cyclingRandom(0))).toEqual([])
    expect(sample(['a'], 0, cyclingRandom(0))).toEqual([])
  })

  it('leaves the list it was given alone', () => {
    const pool = ['a', 'b', 'c']
    sample(pool, 2, cyclingRandom(0.5))
    expect(pool).toEqual(['a', 'b', 'c'])
  })

  it('can reach every problem in the pool', () => {
    const pool = ['a', 'b', 'c', 'd']
    const seen = new Set<string>()
    for (const r of [0, 0.3, 0.6, 0.99]) seen.add(sample(pool, 1, cyclingRandom(r))[0]!)
    expect(seen.size).toBeGreaterThan(1)
  })
})

describe('drawSet', () => {
  it('takes n from every section of the chapter', () => {
    const keys = drawSet(SOLVABLE, new Set(), '12', 2, cyclingRandom(0))
    expect(keys.filter((k) => k.startsWith('12.1.'))).toHaveLength(2)
    expect(keys.filter((k) => k.startsWith('12.2.'))).toHaveLength(2)
    expect(keys.filter((k) => k.startsWith('12.3.'))).toHaveLength(2)
    expect(keys).toHaveLength(6)
  })

  it('stays inside the chapter asked for', () => {
    const keys = drawSet(SOLVABLE, new Set(), '12', 5, cyclingRandom(0))
    expect(keys.every((k) => k.startsWith('12.'))).toBe(true)
  })

  it('gives what a thin section has rather than skipping it', () => {
    // 12.3 holds two problems; asking for four still returns both.
    const keys = drawSet(SOLVABLE, new Set(), '12', 4, cyclingRandom(0))
    expect(keys.filter((k) => k.startsWith('12.3.'))).toHaveLength(2)
  })

  it('never returns a problem an assignment has already named', () => {
    const used = new Set(['12.1.1', '12.1.2', '12.1.3', '12.2.1'])
    const keys = drawSet(SOLVABLE, used, '12', 3, cyclingRandom(0))
    expect(keys.some((k) => used.has(k))).toBe(false)
    expect(keys.filter((k) => k.startsWith('12.1.'))).toHaveLength(2)
  })

  it('drops a section once it is used up, without dropping the chapter', () => {
    const used = new Set(['12.3.1', '12.3.2'])
    const keys = drawSet(SOLVABLE, used, '12', 2, cyclingRandom(0))
    expect(keys.some((k) => k.startsWith('12.3.'))).toBe(false)
    expect(keys.filter((k) => k.startsWith('12.1.'))).toHaveLength(2)
  })

  it('returns nothing once the chapter is exhausted', () => {
    expect(drawSet(SOLVABLE, new Set(SOLVABLE), '12', 3, cyclingRandom(0))).toEqual([])
  })

  it('hands back a set in reading order, with no repeats', () => {
    const keys = drawSet(SOLVABLE, new Set(), '12', 3, cyclingRandom(0.4, 0.1, 0.7))
    expect([...keys].sort((a, b) => keys.indexOf(a) - keys.indexOf(b))).toEqual(keys)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('eligibleKeys', () => {
  it('is the pool the set is drawn from: this chapter, never set', () => {
    expect(eligibleKeys(SOLVABLE, new Set(['12.1.1']), '12')).not.toContain('12.1.1')
    expect(eligibleKeys(SOLVABLE, new Set(), '12')).not.toContain('13.1.1')
  })
})

describe('studyTitle', () => {
  it('numbers each set, so a second draw does not look like the first', () => {
    expect(studyTitle('12', 1)).not.toBe(studyTitle('12', 2))
    expect(studyTitle('12', 1)).toContain('12')
  })
})
