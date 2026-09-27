import { describe, expect, it } from 'vitest'
import { nameFromNominatim, reverseUrl } from '../src/core/geocode'

/** Nominatim の返り値は架空のもの（実在の住所は置かない） */

describe('nameFromNominatim', () => {
  it('施設名があればそれだけを使う', () => {
    expect(nameFromNominatim({ name: '架空図書館', address: { city: '架空市' } })).toBe('架空図書館')
  })

  it('施設名が無ければ「市区 町名」のように粗い地名と細かい地名を 1 つずつ並べる', () => {
    expect(
      nameFromNominatim({
        name: '',
        address: { road: '架空通り', neighbourhood: '一丁目', city: '架空市', state: '架空県' },
      }),
    ).toBe('架空市 一丁目')
  })

  it('細かい地名しか無ければそれだけ、同じ名前は重ねない', () => {
    expect(nameFromNominatim({ address: { suburb: '架空町' } })).toBe('架空町')
    expect(nameFromNominatim({ address: { suburb: '架空', city: '架空' } })).toBe('架空')
  })

  it('部品が無ければ display_name の細かい 2 段を使う', () => {
    expect(nameFromNominatim({ display_name: '3, 架空通り, 架空市, 日本' })).toBe('架空通り 3')
  })

  it('エラーや空の返り値は null（見つからなかった扱い）', () => {
    expect(nameFromNominatim({ error: 'Unable to geocode' })).toBeNull()
    expect(nameFromNominatim({})).toBeNull()
  })
})

describe('reverseUrl', () => {
  it('座標は 5 桁に丸め、日本語の地名を頼む', () => {
    const u = new URL(reverseUrl(35.123456789, 139.987654321))
    expect(u.origin).toBe('https://nominatim.openstreetmap.org')
    expect(u.searchParams.get('lat')).toBe('35.12346')
    expect(u.searchParams.get('lon')).toBe('139.98765')
    expect(u.searchParams.get('accept-language')).toBe('ja')
    expect(u.searchParams.get('format')).toBe('jsonv2')
  })
})
