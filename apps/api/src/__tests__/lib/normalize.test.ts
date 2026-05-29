import { describe, it, expect } from 'bun:test'
import { toE164 } from '../../lib/normalize'

describe('normalize — toE164', () => {
  it('converts US formatted number to E.164', () => {
    expect(toE164('(555) 123-4567', 'US')).toBe('+15551234567')
  })

  it('converts international number to E.164', () => {
    expect(toE164('+44 20 7123 4567', 'GB')).toBe('+442071234567')
  })

  it('returns already-E.164 number unchanged', () => {
    expect(toE164('+15551234567', 'US')).toBe('+15551234567')
  })

  it('throws on invalid number', () => {
    expect(() => toE164('not-a-phone', 'US')).toThrow()
  })
})
