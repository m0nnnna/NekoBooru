import { describe, expect, it } from 'vitest'
import { clampSelection, formatTimecode, parseTimecode } from './timecode'

describe('remote clip timecodes', () => {
  it('parses seconds, minute, and hour forms to integer milliseconds', () => {
    expect(parseTimecode('35.125')).toBe(35_125)
    expect(parseTimecode('32:35')).toBe(1_955_000)
    expect(parseTimecode('1:02:03.004')).toBe(3_723_004)
  })

  it('rejects malformed and out-of-range components', () => {
    expect(parseTimecode('')).toBeNull()
    expect(parseTimecode('1:60')).toBeNull()
    expect(parseTimecode('a:b')).toBeNull()
    expect(parseTimecode('1:2:3:4')).toBeNull()
  })

  it('formats stable editor timecodes', () => {
    expect(formatTimecode(1_955_000)).toBe('32:35.000')
    expect(formatTimecode(3_723_004)).toBe('1:02:03.004')
  })

  it('clamps selections to source and X duration limits', () => {
    expect(clampSelection(-5, 200_000, 300_000)).toEqual({ startMs: 0, endMs: 140_000 })
    expect(clampSelection(9_900, 10_000, 10_000)).toEqual({ startMs: 9_500, endMs: 10_000 })
  })
})
