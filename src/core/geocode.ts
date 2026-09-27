/**
 * 地名の自動取得（DESIGN.md §8 A-2）のうち、通信を含まない部分。
 *
 * OpenStreetMap の Nominatim に座標を問い合わせて、場所に短い名前を付ける。
 * 位置データを外へ出す唯一の機能なので、利用者がボタンを押したときだけ動かし、
 * 送るのは場所の座標だけ（日時・滞在時間・訪問回数は送らない）。
 */

/** Nominatim の reverse（format=jsonv2）の返り値のうち、名前づけに使う部分 */
export interface NominatimReverse {
  name?: string
  display_name?: string
  address?: Record<string, string | undefined>
  error?: string
}

/**
 * 住所の部品を「どこか分かる短い名前」に組み立てる。
 *
 * 施設名（name）があればそれだけで十分。無ければ町名＋道路名のように、
 * 細かい地名と一段上の地名を 1 つずつ並べる（全部並べると 290px の幅に収まらない）。
 */
const FINE_KEYS = ['neighbourhood', 'quarter', 'hamlet', 'suburb', 'village', 'road'] as const
const COARSE_KEYS = ['city_district', 'town', 'city', 'county', 'state'] as const

export function nameFromNominatim(r: NominatimReverse): string | null {
  if (r.error) return null
  const name = r.name?.trim()
  if (name) return name
  const a = r.address ?? {}
  const fine = FINE_KEYS.map((k) => a[k]?.trim()).find(Boolean)
  const coarse = COARSE_KEYS.map((k) => a[k]?.trim()).find((v) => v && v !== fine)
  const parts = [coarse, fine].filter(Boolean)
  if (parts.length > 0) return parts.join(' ')
  // 部品が無ければ display_name の先頭の 2 区切り（一番細かい 2 段）を使う
  const head = r.display_name?.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 2)
  return head && head.length > 0 ? head.reverse().join(' ') : null
}

/** 問い合わせ URL。座標は 5 桁（約 1m）に丸める。それ以上の精度を送る理由が無い */
export function reverseUrl(lat: number, lon: number): string {
  const q = new URLSearchParams({
    format: 'jsonv2',
    lat: lat.toFixed(5),
    lon: lon.toFixed(5),
    zoom: '18',
    'accept-language': 'ja',
  })
  return `https://nominatim.openstreetmap.org/reverse?${q.toString()}`
}
