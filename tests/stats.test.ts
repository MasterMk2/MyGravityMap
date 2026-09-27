import { describe, expect, it } from 'vitest'
import type { Move, Place, TimeWindow, Trip, Visit } from '../src/core/types'
import { haversineMeters, localDayKey, localHour, localWeekday } from '../src/core/geo'
import { createTzLookup, localDayRange } from '../src/core/timezone'
import {
  activityProfile,
  dailySummary,
  distanceByYear,
  levelOf,
  localDayWindow,
  modeBreakdown,
  newPlacesByYear,
  quantileBreaks,
  weekdayOfKey,
  yearGrid,
} from '../src/core/stats'

/** 座標はすべて架空（DESIGN.md §9）。赤道付近の海の上に置いてある */

/** [絶対秒, lat, lon] の並びから Trip を作る */
function trip(points: Array<[number, number, number]>, isFlight = false): Trip {
  const coords = new Float64Array(points.length * 2)
  const times = new Int32Array(points.length)
  points.forEach(([t, lat, lon], i) => {
    coords[i * 2] = lon
    coords[i * 2 + 1] = lat
    times[i] = t
  })
  return {
    coords,
    times,
    tStart: points[0]![0],
    tEnd: points[points.length - 1]![0],
    mode: isFlight ? 'FLYING' : 'UNKNOWN',
    isFlight,
  }
}

function utc(y: number, mo: number, d: number, h = 0, mi = 0): number {
  return Date.UTC(y, mo - 1, d, h, mi) / 1000
}

const ALL: TimeWindow = { start: 0, end: 2 ** 31 - 1 }
const JST = createTzLookup([[0, 540]])
const seg = (aLat: number, aLon: number, bLat: number, bLon: number) =>
  haversineMeters(aLat, aLon, bLat, bLon) / 1000

function visit(start: number, over: Partial<Visit> = {}): Visit {
  return {
    start,
    end: start + 3600,
    tzOffsetMin: 540,
    lat: 1,
    lon: 1,
    semanticType: 'UNKNOWN',
    hierarchyLevel: 0,
    probability: 0.9,
    source: 'google',
    durationReliable: true,
    ...over,
  }
}

describe('タイムゾーン', () => {
  it('UTC 23:30 の記録は +540 なら翌日・8 時として数える', () => {
    const t0 = utc(2025, 3, 13, 23, 30)
    const tr = trip([
      [t0, 1.0, 1.0],
      [t0 + 600, 1.001, 1.0],
    ])
    const days = dailySummary({ trips: [tr], visits: [], tzChanges: [[0, 540]] })
    expect([...days.keys()]).toEqual(['2025-03-14'])
    expect(days.get('2025-03-14')!.tz).toBe(540)

    const p = activityProfile([tr], ALL, JST)
    expect(localHour(t0, 540)).toBe(8)
    // 111m / 10 分 ≒ 0.7 km/h なので停止中
    expect(p.hourStillSec[8]).toBe(600)
    expect(p.hourMovingSec.every((v) => v === 0)).toBe(true)
    // 2025-03-14 は金曜
    expect(p.weekdayStillSec[5]).toBe(600)
    expect(p.weekdayDays).toEqual([0, 0, 0, 0, 0, 1, 0])
  })

  it('時・曜日の通し番号計算は geo.ts の localHour / localWeekday と一致する（30 分単位の TZ も）', () => {
    for (const tz of [540, 330, -480, 0]) {
      const t0 = utc(2024, 2, 29, 21, 10)
      const p = activityProfile(
        [
          trip([
            [t0, 1.0, 1.0],
            [t0 + 60, 1.0001, 1.0],
          ]),
        ],
        ALL,
        createTzLookup([[0, tz]]),
      )
      expect(p.hourStillSec.indexOf(60)).toBe(localHour(t0, tz))
      expect(p.weekdayStillSec.indexOf(60)).toBe(localWeekday(t0, tz))
    }
  })
})

describe('移動距離', () => {
  it('点対の大圏距離を合計する', () => {
    const t0 = utc(2025, 5, 1, 1)
    const tr = trip([
      [t0, 1.0, 1.0],
      [t0 + 300, 1.01, 1.0],
      [t0 + 600, 1.02, 1.0],
    ])
    const years = distanceByYear([tr], ALL, JST)
    expect(years).toHaveLength(1)
    expect(years[0]!.year).toBe(2025)
    expect(years[0]!.groundKm).toBeCloseTo(seg(1, 1, 1.01, 1) + seg(1.01, 1, 1.02, 1), 6)
    expect(years[0]!.flightKm).toBe(0)
  })

  it('isFlight のトリップでは 2km を超える点対だけを飛行として地上距離から外す', () => {
    const t0 = utc(2025, 6, 1, 0)
    // 徒歩 → 補間された飛行区間 3 本 → 徒歩
    const tr = trip(
      [
        [t0, 1.0, 1.0],
        [t0 + 180, 1.0027, 1.0], // ≒ 300m
        [t0 + 780, 1.45, 1.0], // ≒ 50km
        [t0 + 1380, 1.9, 1.0],
        [t0 + 1980, 2.35, 1.0],
        [t0 + 2160, 2.3518, 1.0], // ≒ 200m
      ],
      true,
    )
    const [y] = distanceByYear([tr], ALL, JST)
    expect(y!.groundKm).toBeCloseTo(seg(1.0, 1, 1.0027, 1) + seg(2.35, 1, 2.3518, 1), 6)
    expect(y!.flightKm).toBeCloseTo(seg(1.0027, 1, 2.35, 1), 3)

    const d = dailySummary({ trips: [tr], visits: [], tzChanges: [[0, 540]] }).get('2025-06-01')!
    // 前後とも飛行区間の 2 点は補間点なので数えない
    expect(d.points).toBe(4)
    // 飛行の補間区間は記録時間に入れない
    expect(d.recordedSec).toBe(180 + 180)
    expect(d.km).toBeCloseTo(y!.groundKm + y!.flightKm, 6)
    expect(d.flightKm).toBeCloseTo(y!.flightKm, 6)

    // 時間帯のプロファイルにも飛行の補間区間は入らない
    const p = activityProfile([tr], ALL, JST)
    const total = [...p.hourMovingSec, ...p.hourStillSec].reduce((a, b) => a + b, 0)
    expect(total).toBe(360)
  })

  it('期間の端をまたぐ点対は時間の割合で按分する', () => {
    const t0 = utc(2025, 7, 1, 3)
    const tr = trip([
      [t0, 1.0, 1.0],
      [t0 + 600, 1.02, 1.0],
    ])
    const [y] = distanceByYear([tr], { start: t0 + 300, end: t0 + 900 }, JST)
    expect(y!.groundKm).toBeCloseTo(seg(1.0, 1, 1.02, 1) / 2, 6)

    const p = activityProfile([tr], { start: t0 + 300, end: t0 + 900 }, JST)
    expect(p.hourMovingSec.reduce((a, b) => a + b, 0)).toBe(300)

    // 期間の外なら何も数えない
    expect(distanceByYear([tr], { start: t0 + 600, end: t0 + 900 }, JST)).toEqual([])
  })

  it('年は記録側の暦年で分け、間の年も 0 で埋める', () => {
    // UTC では 2023 年の大晦日だが +540 では 2024 年の元日
    const a = utc(2023, 12, 31, 16)
    const b = utc(2026, 3, 1, 1)
    const years = distanceByYear(
      [
        trip([
          [a, 1.0, 1.0],
          [a + 300, 1.01, 1.0],
        ]),
        trip([
          [b, 1.0, 1.0],
          [b + 300, 1.01, 1.0],
        ]),
      ],
      ALL,
      JST,
    )
    expect(years.map((y) => y.year)).toEqual([2024, 2025, 2026])
    expect(years[1]!.groundKm).toBe(0)
  })
})

describe('交通手段別', () => {
  it('手段ごとに距離・時間を合計し、期間の端は按分し、距離の大きい順に並べる', () => {
    const T = utc(2025, 1, 10, 0)
    const move = (start: number, end: number, meters: number, mode: Move['mode']): Move => ({
      start,
      end,
      tzOffsetMin: 540,
      from: [1, 1],
      to: [1.01, 1],
      distanceMeters: meters,
      mode,
      probability: 0.9,
    })
    const moves = [
      move(T, T + 1000, 1000, 'WALKING'),
      move(T + 2000, T + 3000, 10000, 'IN_PASSENGER_VEHICLE'),
      move(T + 5000, T + 5500, 500, 'WALKING'),
      move(T + 9000, T + 9500, 800, 'CYCLING'), // 期間外
    ]
    const r = modeBreakdown(moves, { start: T, end: T + 5250 })
    expect(r.map((m) => m.mode)).toEqual(['IN_PASSENGER_VEHICLE', 'WALKING'])
    expect(r[0]).toEqual({ mode: 'IN_PASSENGER_VEHICLE', meters: 10000, seconds: 1000, count: 1 })
    expect(r[1]).toEqual({ mode: 'WALKING', meters: 1250, seconds: 1250, count: 2 })
  })
})

describe('日ごとの集計', () => {
  it('日付をまたぐ点対は両日に按分し、30 分を超える間隔は 30 分で打ち切る', () => {
    // +540 で 23:50 → 00:10
    const t0 = utc(2025, 8, 1, 14, 50)
    const days = dailySummary({
      trips: [
        trip([
          [t0, 1.0, 1.0],
          [t0 + 1200, 1.09, 1.0],
        ]),
        // 1 時間の間隔（トリップ内では本来起きないが、入力を信用しない）
        trip([
          [t0 + 7200, 1.09, 1.0],
          [t0 + 10800, 1.0901, 1.0],
        ]),
      ],
      visits: [],
      tzChanges: [[0, 540]],
    })
    const a = days.get('2025-08-01')!
    const b = days.get('2025-08-02')!
    const whole = seg(1.0, 1, 1.09, 1)
    expect(a.km).toBeCloseTo(whole / 2, 6)
    expect(b.km).toBeCloseTo(whole / 2 + seg(1.09, 1, 1.0901, 1), 6)
    expect(a.recordedSec).toBe(600)
    expect(b.recordedSec).toBeCloseTo(600 + 1800, 6)
    expect(a.points).toBe(1)
    expect(b.points).toBe(3)
  })

  it('level 0 の訪問を開始日で数える。derived は時刻から TZ を引き直し、level 1 は数えない', () => {
    // derived は tzOffsetMin 0 で作られる。UTC では 6/1 だが記録側（+540）では 6/2
    const derivedStart = utc(2019, 6, 1, 20)
    const days = dailySummary({
      trips: [],
      visits: [
        visit(derivedStart, { source: 'derived', tzOffsetMin: 0, durationReliable: false }),
        // Google の訪問は自分の tzOffsetMin を使う（+60 なので UTC 23:30 → 翌 0:30）
        visit(utc(2025, 6, 1, 23, 30), { tzOffsetMin: 60 }),
        visit(utc(2025, 6, 1, 23, 30), { tzOffsetMin: 60, hierarchyLevel: 1 }),
      ],
      tzChanges: [[0, 540]],
    })
    expect([...days.keys()]).toEqual(['2019-06-02', '2025-06-02'])
    expect(days.get('2019-06-02')!.visits).toBe(1)
    expect(days.get('2025-06-02')!.visits).toBe(1)
    expect(days.get('2025-06-02')!.tz).toBe(60)
    expect(days.get('2025-06-02')!.points).toBe(0)
  })

  it('キーは日付順に並ぶ', () => {
    const t1 = utc(2025, 9, 3, 1)
    const t2 = utc(2025, 9, 1, 1)
    const days = dailySummary({
      trips: [
        trip([
          [t1, 1, 1],
          [t1 + 60, 1, 1],
        ]),
        trip([
          [t2, 1, 1],
          [t2 + 60, 1, 1],
        ]),
      ],
      visits: [],
      tzChanges: [],
    })
    expect([...days.keys()]).toEqual(['2025-09-01', '2025-09-03'])
  })
})

describe('新しい場所', () => {
  it('期間内の firstSeen を記録側の暦年で数え、Google と復元だけの場所を分ける', () => {
    const place = (id: string, firstSeen: number, sources: Place['sources']): Place => ({
      id,
      lat: 1,
      lon: 1,
      semanticType: 'UNKNOWN',
      visitCount: 1,
      visitDays: 1,
      reliableSeconds: 0,
      observedSeconds: 0,
      firstSeen,
      lastSeen: firstSeen + 60,
      byYear: {},
      byHour: new Int32Array(24),
      byWeekday: new Int32Array(7),
      sources,
    })
    const places = [
      // UTC では 2019 年の大晦日だが +540 では 2020 年
      place('a', utc(2019, 12, 31, 20), ['derived']),
      place('b', utc(2020, 5, 1), ['derived', 'google']),
      place('c', utc(2022, 11, 1), ['google']),
      place('d', utc(2018, 1, 1), ['derived']), // 期間外
    ]
    const r = newPlacesByYear(places, { start: utc(2019, 1, 1), end: utc(2023, 1, 1) }, JST)
    expect(r).toEqual([
      { year: 2020, google: 1, derived: 1 },
      { year: 2021, google: 0, derived: 0 },
      { year: 2022, google: 1, derived: 0 },
    ])
  })
})

describe('色の段階', () => {
  it('正の値の四分位で分け、極端な日は最上段に、0 は段階の外に置く', () => {
    const breaks = quantileBreaks([0, 1, 2, 3, 4, 100])
    expect(breaks).toEqual([2, 3, 4])
    expect([0, 1, 2, 3, 4, 100].map((v) => levelOf(v, breaks))).toEqual([0, 1, 1, 2, 3, 4])
  })

  it('正の値が無ければ段階は空で、正の値は 1 段目', () => {
    expect(quantileBreaks([0, 0])).toEqual([])
    expect(levelOf(5, [])).toBe(1)
    expect(levelOf(0, [])).toBe(0)
  })
})

describe('暦日 → 期間', () => {
  it('オフセットが変わらない日は localDayRange と同じ', () => {
    const w = localDayWindow('2025-03-14', [[0, 540]])
    expect([w.start, w.end]).toEqual(localDayRange('2025-03-14', 540))
    // 切り替わり点が無ければ既定（JST）
    expect(localDayWindow('2025-03-14', [])).toEqual(w)
  })

  it('その日のうちに +540 → +60 に変わったら、両方のオフセットでその日に当たる時刻を覆う', () => {
    const change = utc(2023, 7, 1, 6, 51)
    const tzChanges: Array<[number, number]> = [
      [0, 540],
      [change, 60],
    ]
    const w = localDayWindow('2023-07-01', tzChanges)
    expect(w.start).toBe(utc(2023, 6, 30, 15)) // +540 の 0 時
    expect(w.end).toBe(utc(2023, 7, 1, 23)) // +60 の 24 時
    // カレンダーが 7/1 に数えた記録（到着後の +60 の夜）が期間に入る
    const late = utc(2023, 7, 1, 21, 34)
    const tz = createTzLookup(tzChanges)
    expect(localDayKey(late, tz(late))).toBe('2023-07-01')
    expect(late >= w.start && late < w.end).toBe(true)
    // 前後の日と重ならない
    expect(localDayWindow('2023-06-30', tzChanges).end).toBe(w.start)
    expect(localDayWindow('2023-07-02', tzChanges).start).toBe(w.end)
  })
})

describe('カレンダーの升目', () => {
  it('列＝週・行＝曜日（日曜が上）に並べる', () => {
    const g = yearGrid(2025)
    expect(g.cells).toHaveLength(365)
    // 2025-01-01 は水曜
    expect(g.cells[0]).toEqual({ key: '2025-01-01', col: 0, row: 3 })
    expect(g.cells[364]).toEqual({ key: '2025-12-31', col: 52, row: 3 })
    expect(g.cols).toBe(53)
    expect(g.monthCols).toHaveLength(12)
    expect(g.monthCols[0]).toBe(0)
    for (const c of g.cells) expect(c.row).toBe(weekdayOfKey(c.key))
  })

  it('年初が土曜の閏年は 54 列になる', () => {
    const g = yearGrid(2028)
    expect(g.cells).toHaveLength(366)
    expect(g.cols).toBe(54)
  })

  it('暦日のキーは localDayKey と同じ書式', () => {
    expect(yearGrid(2024).cells[59]!.key).toBe(localDayKey(utc(2024, 2, 29, 12), 0))
  })
})
