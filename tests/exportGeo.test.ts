import { describe, it, expect } from 'vitest'
import type { Dataset, Place, Trip } from '../src/core/types'
import { isoUtc, placesToGeoJSON, round6, tripsToGeoJSON } from '../src/core/exportGeo'

/**
 * GeoJSON 書き出し（core/exportGeo.ts）。
 * 座標・placeId はすべて架空の値（実データは使わない）。
 */

/** 2025-01-02T03:04:05Z */
const T0 = Math.floor(Date.UTC(2025, 0, 2, 3, 4, 5) / 1000)
const H = 3600

function place(p: Partial<Place>): Place {
  return {
    id: 'fake-place',
    lat: 12.3456,
    lon: 56.7891,
    semanticType: 'UNKNOWN',
    visitCount: 4,
    visitDays: 3,
    reliableSeconds: 5400,
    observedSeconds: 5400,
    firstSeen: T0,
    lastSeen: T0 + 10 * H,
    byYear: {},
    byHour: new Int32Array(24),
    byWeekday: new Int32Array(7),
    sources: ['google'],
    ...p,
  }
}

function trip(points: Array<[number, number, number]>, extra: Partial<Trip> = {}): Trip {
  const coords = new Float64Array(points.length * 2)
  points.forEach(([lon, lat], i) => {
    coords[i * 2] = lon
    coords[i * 2 + 1] = lat
  })
  const times = Int32Array.from(points.map((p) => p[2]))
  return {
    coords,
    times,
    tStart: times[0]!,
    tEnd: times[times.length - 1]!,
    mode: 'WALKING',
    isFlight: false,
    ...extra,
  }
}

describe('placesToGeoJSON', () => {
  const anchors: Dataset['anchors'] = [{ placeId: 'fake-home', lat: 0, lon: 0, label: 'HOME' }]

  it('Point の FeatureCollection で、座標は [経度, 緯度]', () => {
    const fc = placesToGeoJSON([place({})], {}, [])
    expect(fc.type).toBe('FeatureCollection')
    expect(fc.features).toHaveLength(1)
    const f = fc.features[0]!
    expect(f.type).toBe('Feature')
    expect(f.geometry).toEqual({ type: 'Point', coordinates: [56.7891, 12.3456] })
  })

  it('属性: 件数・時間・期間・種別・出どころ', () => {
    const f = placesToGeoJSON([place({ semanticType: 'WORK', sources: ['google', 'derived'] })], {}, [])
      .features[0]!
    expect(f.properties).toEqual({
      name: '職場',
      visitDays: 3,
      visitCount: 4,
      reliableHours: 1.5,
      firstSeen: '2025-01-02T03:04:05Z',
      lastSeen: '2025-01-02T13:04:05Z',
      semanticType: 'WORK',
      sources: ['google', 'derived'],
    })
  })

  it('時間の測れない場所の reliableHours は 0 ではなく null', () => {
    const f = placesToGeoJSON(
      [place({ reliableSeconds: 0, observedSeconds: 72000, sources: ['derived'] })],
      {},
      [],
    ).features[0]!
    expect(f.properties.reliableHours).toBeNull()
  })

  it('名前は 利用者のラベル > 自動ラベル > 並び順の番号', () => {
    const fc = placesToGeoJSON(
      [
        place({ id: 'fake-home' }),
        place({ id: 'grid:1:2' }),
        place({ id: 'fake-home-2', semanticType: 'HOME' }),
        place({ id: 'fake-labeled', semanticType: 'HOME' }),
      ],
      { 'fake-labeled': '祖母の家', 'unrelated': 'x' },
      anchors,
    )
    expect(fc.features.map((f) => f.properties.name)).toEqual(['自宅', '場所 #2', '自宅', '祖母の家'])
  })

  it('placeId や格子キーは書き出さない', () => {
    const json = JSON.stringify(placesToGeoJSON([place({ id: 'ChIJ-fake-id' }), place({ id: 'grid:9:9' })], {}, []))
    expect(json).not.toContain('ChIJ-fake-id')
    expect(json).not.toContain('grid:9:9')
  })

  it('座標は小数 6 桁に丸める', () => {
    const f = placesToGeoJSON([place({ lat: 12.98765432, lon: 56.12345678 })], {}, []).features[0]!
    expect(f.geometry.coordinates).toEqual([56.123457, 12.987654])
  })

  it('JSON にして読み戻しても同じ（TypedArray などが紛れ込んでいない）', () => {
    const fc = placesToGeoJSON([place({}), place({ id: 'b', lat: -33.5, lon: -70.25 })], {}, [])
    expect(JSON.parse(JSON.stringify(fc))).toEqual(fc)
  })

  it('入力の sources 配列を共有しない', () => {
    const p = place({ sources: ['google'] })
    const f = placesToGeoJSON([p], {}, []).features[0]!
    expect(f.properties.sources).not.toBe(p.sources)
  })

  it('空の入力は空の FeatureCollection', () => {
    expect(placesToGeoJSON([], {}, [])).toEqual({ type: 'FeatureCollection', features: [] })
  })
})

describe('tripsToGeoJSON', () => {
  const pts: Array<[number, number, number]> = [
    [56.1, 12.1, T0],
    [56.2, 12.2, T0 + 600],
    [56.3, 12.3, T0 + 1200],
    [56.4, 12.4, T0 + 1800],
    [56.5, 12.5, T0 + 2400],
  ]

  it('LineString の FeatureCollection で、属性は時刻・手段・飛行', () => {
    const fc = tripsToGeoJSON([trip(pts, { mode: 'IN_TRAIN' })], { start: T0 - H, end: T0 + H })
    expect(fc.type).toBe('FeatureCollection')
    expect(fc.features).toHaveLength(1)
    const f = fc.features[0]!
    expect(f.type).toBe('Feature')
    expect(f.geometry.type).toBe('LineString')
    expect(f.geometry.coordinates).toEqual(pts.map(([lon, lat]) => [lon, lat]))
    expect(f.properties.start).toBe('2025-01-02T03:04:05Z')
    expect(f.properties.end).toBe('2025-01-02T03:44:05Z')
    expect(f.properties.mode).toBe('IN_TRAIN')
    expect(f.properties.isFlight).toBe(false)
    expect(f.properties.coordTimes).toEqual(pts.map((p) => isoUtc(p[2])))
  })

  it('期間の外の点を落とす（境界ちょうどの点は残す）', () => {
    const w = { start: T0 + 600, end: T0 + 1800 }
    const f = tripsToGeoJSON([trip(pts)], w).features[0]!
    expect(f.geometry.coordinates).toEqual([
      [56.2, 12.2],
      [56.3, 12.3],
      [56.4, 12.4],
    ])
    expect(f.properties.coordTimes).toEqual([isoUtc(T0 + 600), isoUtc(T0 + 1200), isoUtc(T0 + 1800)])
    expect(f.properties.start).toBe(isoUtc(w.start))
    expect(f.properties.end).toBe(isoUtc(w.end))
  })

  it('期間内に 2 点未満しか残らないトリップと、期間外のトリップは出さない', () => {
    const fc = tripsToGeoJSON(
      [
        trip(pts), // 期間内に 1 点だけ
        trip([
          [60, 20, T0 + 5 * H],
          [61, 21, T0 + 6 * H],
        ]), // 期間外
      ],
      { start: T0 + 2000, end: T0 + 3000 },
    )
    expect(fc.features).toEqual([])
  })

  it('座標は小数 6 桁に丸め、coordTimes と点数がそろう', () => {
    const f = tripsToGeoJSON(
      [
        trip(
          [
            [139.76543219, 35.12345678, T0],
            [-0.00000012, -12.98765432, T0 + 60],
          ],
          { isFlight: true, mode: 'FLYING' },
        ),
      ],
      { start: T0, end: T0 + 60 },
    ).features[0]!
    expect(f.geometry.coordinates).toEqual([
      [139.765432, 35.123457],
      [-0, -12.987654],
    ])
    expect(f.properties.coordTimes).toHaveLength(f.geometry.coordinates.length)
    expect(f.properties.isFlight).toBe(true)
    // -0 は JSON では 0 になる
    expect(JSON.stringify(f.geometry.coordinates[1])).toBe('[0,-12.987654]')
  })

  it('空の入力は空の FeatureCollection', () => {
    expect(tripsToGeoJSON([], { start: T0, end: T0 + H })).toEqual({
      type: 'FeatureCollection',
      features: [],
    })
  })

  it('JSON にして読み戻しても同じ', () => {
    const fc = tripsToGeoJSON([trip(pts)], { start: T0, end: T0 + H })
    expect(JSON.parse(JSON.stringify(fc))).toEqual(fc)
  })
})

describe('補助関数', () => {
  it('round6', () => {
    expect(round6(1.23456789)).toBe(1.234568)
    expect(round6(-1.23456749)).toBe(-1.234567)
  })

  it('isoUtc はミリ秒を付けない', () => {
    expect(isoUtc(0)).toBe('1970-01-01T00:00:00Z')
    expect(isoUtc(T0)).toBe('2025-01-02T03:04:05Z')
  })
})
