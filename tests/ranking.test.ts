import { describe, it, expect } from 'vitest'
import type { Dataset, Place, Visit } from '../src/core/types'
import {
  autoLabel,
  clipVisitsToWindow,
  coordHint,
  hasReliableTime,
  isDerivedOnly,
  placeName,
  placesInWindow,
  rankPlaces,
  sortPlaces,
} from '../src/core/ranking'

/**
 * 期間連動の場所ランキング（core/ranking.ts）。
 * 座標・placeId はすべて架空の値（実データは使わない）。
 */

const H = 3600
const DAY = 86400
/** 2025-03-10T00:00:00Z。tzOffsetMin 0 の訪問ならここが暦日の境目 */
const T0 = Math.floor(Date.UTC(2025, 2, 10) / 1000)

function visit(p: Partial<Visit> & { start: number; end: number }): Visit {
  return {
    tzOffsetMin: 0,
    lat: 12.3456,
    lon: 56.7891,
    semanticType: 'UNKNOWN',
    hierarchyLevel: 0,
    probability: 0.9,
    source: 'google',
    durationReliable: true,
    ...p,
  }
}

/** 軌跡から復元した滞在（placeId 無し・時間は信用しない） */
function derived(start: number, end: number, lat: number, lon: number): Visit {
  return visit({ start, end, lat, lon, source: 'derived', durationReliable: false })
}

const ALL = { start: T0 - 365 * DAY, end: T0 + 365 * DAY }

describe('clipVisitsToWindow / 期間での切り詰め', () => {
  const w = { start: T0, end: T0 + 10 * DAY }

  it('期間をまたぐ滞在ははみ出した分を数えない', () => {
    const vs = [
      visit({ placeId: 'fake-a', start: T0 - 2 * H, end: T0 + 1 * H }), // 頭がはみ出す
      visit({ placeId: 'fake-a', start: T0 + 10 * DAY - H, end: T0 + 10 * DAY + 5 * H }), // 尻がはみ出す
    ]
    const [p] = placesInWindow(vs, w)
    expect(p!.reliableSeconds).toBe(2 * H)
    expect(p!.observedSeconds).toBe(2 * H)
    expect(p!.firstSeen).toBe(w.start)
    expect(p!.lastSeen).toBe(w.end)
  })

  it('前日から続く滞在は期間の初日の訪問として数える', () => {
    // 前日 22 時〜当日 2 時。切らずに数えると訪問日が期間外の前日になる
    const vs = [visit({ placeId: 'fake-a', start: T0 - 2 * H, end: T0 + 2 * H })]
    const [p] = placesInWindow(vs, w)
    expect(p!.visitDays).toBe(1)
    expect(Object.keys(p!.byYear)).toEqual(['2025'])
    // 切らなければ日曜 22 時台の訪問になる。期間の頭（月曜 0 時台）に寄せられていること
    expect(p!.byHour[0]).toBe(1)
    expect(p!.byWeekday[1]).toBe(1)
  })

  it('期間に重ならない滞在・境界ちょうどで終わる滞在は入れない', () => {
    const vs = [
      visit({ placeId: 'fake-out', start: T0 - 3 * H, end: T0 - H }),
      visit({ placeId: 'fake-edge', start: T0 - H, end: T0 }),
      visit({ placeId: 'fake-after', start: T0 + 10 * DAY, end: T0 + 10 * DAY + H }),
      visit({ placeId: 'fake-in', start: T0 + H, end: T0 + 2 * H }),
    ]
    expect(placesInWindow(vs, w).map((p) => p.id)).toEqual(['fake-in'])
  })

  it('期間内に収まる訪問は同じオブジェクトのまま、入力は書き換えない', () => {
    const inside = visit({ placeId: 'fake-a', start: T0 + H, end: T0 + 2 * H })
    const across = visit({ placeId: 'fake-a', start: T0 - H, end: T0 + H })
    const out = clipVisitsToWindow([inside, across], w)
    expect(out[0]).toBe(inside)
    expect(out[1]!.start).toBe(T0)
    expect(across.start).toBe(T0 - H)
  })

  it('記録側の TZ で暦日を数える（JST の 0 時をまたぐ期間）', () => {
    // 期間 = JST の 3/10 0:00 から 2 日間。UTC では 3/9 15:00 から
    const jst = { start: T0 - 9 * H, end: T0 - 9 * H + 2 * DAY }
    const vs = [
      visit({ placeId: 'fake-a', tzOffsetMin: 540, start: jst.start - H, end: jst.start + H }),
      visit({ placeId: 'fake-a', tzOffsetMin: 540, start: jst.start + 3 * H, end: jst.start + 4 * H }),
    ]
    // どちらも JST の 3/10（1 件目は期間の頭に寄せられる）
    expect(placesInWindow(vs, jst)[0]!.visitDays).toBe(1)
  })
})

describe('hierarchyLevel 1 の扱い', () => {
  it('level 1 は数えない（level 0 と時間が重複するため）', () => {
    const vs = [
      visit({ placeId: 'fake-shop', start: T0 + H, end: T0 + 2 * H }),
      // 同じ時間帯の「施設全体」レコード
      visit({ placeId: 'fake-mall', hierarchyLevel: 1, start: T0 + H, end: T0 + 2 * H }),
      visit({ placeId: 'fake-shop', hierarchyLevel: 1, start: T0 + H, end: T0 + 2 * H }),
    ]
    const places = rankPlaces(vs, ALL, 'time')
    expect(places.map((p) => p.id)).toEqual(['fake-shop'])
    expect(places[0]!.reliableSeconds).toBe(H)
    expect(places[0]!.visitCount).toBe(1)
  })

  it('clipVisitsToWindow の時点で level 1 を落とす', () => {
    const vs = [visit({ placeId: 'fake-mall', hierarchyLevel: 1, start: T0, end: T0 + H })]
    expect(clipVisitsToWindow(vs, ALL)).toEqual([])
  })
})

describe('並べ替え', () => {
  // p1: 3 日・3 回・30 分 / p2: 1 日・1 回・10 時間 / p3: 1 日・5 回・25 分
  // 推定: 2 日・2 回・時間なし（観測上は長い）
  const vs: Visit[] = [
    ...[0, 1, 2].map((d) =>
      visit({ placeId: 'p1', start: T0 + d * DAY + 8 * H, end: T0 + d * DAY + 8 * H + 600 }),
    ),
    visit({ placeId: 'p2', start: T0 + 9 * H, end: T0 + 19 * H }),
    ...[0, 1, 2, 3, 4].map((k) =>
      visit({ placeId: 'p3', start: T0 + 12 * H + k * 1200, end: T0 + 12 * H + k * 1200 + 300 }),
    ),
    derived(T0 + 3 * DAY, T0 + 3 * DAY + 20 * H, 23.4567, 67.891),
    derived(T0 + 4 * DAY, T0 + 4 * DAY + 20 * H, 23.4567, 67.891),
  ]
  const derivedId = placesInWindow(vs, ALL).find((p) => p.id.startsWith('grid:'))!.id

  it('日数: visitDays の降順、同点は id の昇順', () => {
    expect(rankPlaces(vs, ALL, 'days').map((p) => p.id)).toEqual(['p1', derivedId, 'p2', 'p3'])
  })

  it('時間: reliableSeconds の降順、時間の無い場所は末尾', () => {
    expect(rankPlaces(vs, ALL, 'time').map((p) => p.id)).toEqual(['p2', 'p1', 'p3', derivedId])
  })

  it('回数: visitCount の降順', () => {
    expect(rankPlaces(vs, ALL, 'count').map((p) => p.id)).toEqual(['p3', 'p1', derivedId, 'p2'])
  })

  it('時間の無い場所は日数が多くても時間のある場所より後、その中では日数順', () => {
    const many = [
      ...[0, 1, 2, 3, 4, 5].map((d) => derived(T0 + d * DAY, T0 + d * DAY + 5 * H, 40.1, 60.1)),
      derived(T0, T0 + 5 * H, 41.1, 61.1),
      visit({ placeId: 'short', start: T0 + H, end: T0 + H + 60 }),
    ]
    const ranked = rankPlaces(many, ALL, 'time')
    expect(ranked.map((p) => p.id)[0]).toBe('short')
    expect(ranked.map((p) => p.visitDays)).toEqual([1, 6, 1])
  })

  it('同点の並びは入力の順序に左右されない', () => {
    const a = visit({ placeId: 'fake-b', start: T0, end: T0 + H })
    const b = visit({ placeId: 'fake-a', start: T0 + 2 * H, end: T0 + 3 * H })
    const c = visit({ placeId: 'fake-c', start: T0 + 4 * H, end: T0 + 5 * H })
    for (const order of [[a, b, c], [c, b, a], [b, c, a]]) {
      expect(rankPlaces(order, ALL, 'days').map((p) => p.id)).toEqual(['fake-a', 'fake-b', 'fake-c'])
      expect(rankPlaces(order, ALL, 'count').map((p) => p.id)).toEqual(['fake-a', 'fake-b', 'fake-c'])
    }
  })

  it('sortPlaces は入力の配列を並べ替えない', () => {
    const places = placesInWindow(vs, ALL)
    const before = places.map((p) => p.id)
    sortPlaces(places, 'count')
    expect(places.map((p) => p.id)).toEqual(before)
  })

  it('期間を変えると順位が変わる（全期間の集計を使い回していない）', () => {
    const firstDay = { start: T0, end: T0 + DAY }
    // 初日だけなら p1 も p2 も p3 も 1 日。同点なので id 順
    expect(rankPlaces(vs, firstDay, 'days').map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
    const later = { start: T0 + 3 * DAY, end: T0 + 10 * DAY }
    expect(rankPlaces(vs, later, 'days').map((p) => p.id)).toEqual([derivedId])
  })

  it('hasReliableTime: 推定の場所しか無い期間では false', () => {
    const later = { start: T0 + 3 * DAY, end: T0 + 10 * DAY }
    expect(hasReliableTime(placesInWindow(vs, later))).toBe(false)
    expect(hasReliableTime(placesInWindow(vs, ALL))).toBe(true)
    expect(hasReliableTime([])).toBe(false)
  })
})

describe('推定バッジ（isDerivedOnly）', () => {
  it('推定の滞在だけの場所は true、Google の訪問が混ざれば false', () => {
    const vs = [
      derived(T0, T0 + 5 * H, 30.5, 70.5),
      // 推定の滞在と、同じ格子に落ちる placeId の無い Google の訪問
      derived(T0 + DAY, T0 + DAY + 5 * H, 33.3, 77.7),
      visit({ start: T0 + 2 * DAY, end: T0 + 2 * DAY + H, lat: 33.3, lon: 77.7 }),
      visit({ placeId: 'fake-g', start: T0, end: T0 + H }),
    ]
    const byCoord = (lat: number) => placesInWindow(vs, ALL).find((p) => p.lat === lat)!
    expect(isDerivedOnly(byCoord(30.5))).toBe(true)
    expect(byCoord(30.5).sources).toEqual(['derived'])
    expect(isDerivedOnly(byCoord(33.3))).toBe(false)
    expect(isDerivedOnly(placesInWindow(vs, ALL).find((p) => p.id === 'fake-g')!)).toBe(false)
  })

  it('推定の場所の id は格子キーで、期間を変えても同じ（ラベルのキーに使うため）', () => {
    const vs = [derived(T0, T0 + 5 * H, 30.5, 70.5), derived(T0 + 5 * DAY, T0 + 5 * DAY + 5 * H, 30.5, 70.5)]
    const a = placesInWindow(vs, { start: T0, end: T0 + DAY })[0]!.id
    const b = placesInWindow(vs, { start: T0 + 4 * DAY, end: T0 + 6 * DAY })[0]!.id
    expect(a).toMatch(/^grid:/)
    expect(a).toBe(b)
  })
})

describe('名前（autoLabel / placeName）', () => {
  function place(p: Partial<Place>): Place {
    return {
      id: 'fake-place-0001',
      lat: 12.3456,
      lon: 56.7891,
      semanticType: 'UNKNOWN',
      visitCount: 1,
      visitDays: 1,
      reliableSeconds: 0,
      observedSeconds: 0,
      firstSeen: T0,
      lastSeen: T0,
      byYear: {},
      byHour: new Int32Array(24),
      byWeekday: new Int32Array(7),
      sources: ['google'],
      ...p,
    }
  }
  const anchors: Dataset['anchors'] = [
    { placeId: 'fake-home', lat: 1, lon: 2, label: 'HOME' },
    { placeId: 'fake-work', lat: 3, lon: 4, label: 'WORK' },
    { placeId: 'fake-other', lat: 5, lon: 6, label: 'SCHOOL' },
    { placeId: 'fake-nolabel', lat: 7, lon: 8 },
  ]

  it('userLocationProfile の HOME / WORK を placeId で当てる', () => {
    expect(autoLabel(place({ id: 'fake-home' }), anchors)).toBe('自宅')
    expect(autoLabel(place({ id: 'fake-work' }), anchors)).toBe('職場')
  })

  it('anchor は semanticType より優先する', () => {
    expect(autoLabel(place({ id: 'fake-home', semanticType: 'INFERRED_WORK' }), anchors)).toBe('自宅')
  })

  it('HOME / WORK 以外の anchor やラベルの無い anchor は使わず semanticType に落ちる', () => {
    expect(autoLabel(place({ id: 'fake-other', semanticType: 'WORK' }), anchors)).toBe('職場')
    expect(autoLabel(place({ id: 'fake-nolabel' }), anchors)).toBeUndefined()
  })

  it('semanticType の対応', () => {
    expect(autoLabel(place({ semanticType: 'HOME' }), [])).toBe('自宅')
    expect(autoLabel(place({ semanticType: 'WORK' }), [])).toBe('職場')
    expect(autoLabel(place({ semanticType: 'INFERRED_HOME' }), [])).toBe('自宅（推定）')
    expect(autoLabel(place({ semanticType: 'INFERRED_WORK' }), [])).toBe('職場（推定）')
    expect(autoLabel(place({ semanticType: 'SEARCHED_ADDRESS' }), [])).toBe('検索した場所')
    expect(autoLabel(place({ semanticType: 'UNKNOWN' }), [])).toBeUndefined()
  })

  it('優先順位: 利用者のラベル > 自動ラベル > 場所 #順位', () => {
    const home = place({ id: 'fake-home' })
    expect(placeName(home, 1, { 'fake-home': '実家' }, anchors)).toEqual({ text: '実家', kind: 'user' })
    expect(placeName(home, 1, {}, anchors)).toEqual({ text: '自宅', kind: 'auto' })
    expect(placeName(place({}), 7, {}, anchors)).toEqual({ text: '場所 #7', kind: 'fallback' })
  })

  it('空白だけの利用者ラベルは無視し、前後の空白は落とす', () => {
    const home = place({ id: 'fake-home' })
    expect(placeName(home, 1, { 'fake-home': '   ' }, anchors).text).toBe('自宅')
    expect(placeName(home, 1, { 'fake-home': ' 実家 ' }, anchors).text).toBe('実家')
  })

  it('placeId を名前に出さない', () => {
    const p = place({ id: 'ChIJ-fake-google-place-id' })
    expect(placeName(p, 3, {}, []).text).not.toContain(p.id)
  })

  it('座標の目安は小数 2 桁', () => {
    expect(coordHint({ lat: 12.3456, lon: 56.7891 })).toBe('12.35, 56.79')
    expect(coordHint({ lat: -33.8688, lon: -70.1 })).toBe('-33.87, -70.10')
  })
})
