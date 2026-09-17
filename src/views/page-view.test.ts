// D-14: the page label is the one piece of arithmetic in the page view (D-6).
import { describe, expect, it } from 'vitest'
import { pageLabel } from './page-view'

describe('pageLabel', () => {
  it('gives both numbers, so a paper copy can be followed', () => {
    // These books: printed page = PDF page - 13 in the textbook (P-7).
    expect(pageLabel(736, 1205, -13)).toBe('PDF page 737 of 1205, printed p. 724')
  })

  it('counts from one, the way a reader does', () => {
    expect(pageLabel(0, 10, 0)).toBe('PDF page 1 of 10, printed p. 1')
  })

  it('leaves the printed number out where there is none', () => {
    // Front matter sits before printed page 1, so the offset puts it at zero or below.
    expect(pageLabel(2, 1205, -13)).toBe('PDF page 3 of 1205')
  })
})
