import { describe, expect, it } from 'vitest'
import {
  aggregateToCells,
  hasVisitWeights,
  trackWeights,
  visitWeights,
} from '../src/gravity/weights'
import { heatCellMeters } from '../src/gravity/layers'
import type { Trip, Visit } from '../src/core/types'

function trip(coords: number[], times: number[]): Trip {
  return {
    coords: new Float64Array(coords),
    times: new Int32Array(times),
    tStart: times[0]!,
    tEnd: times[times.length - 1]!,
    mode: 'UNKNOWN',
    isFlight: false,
  }
}

function visit(start: number, end: number, level: 0 | 1, lat = 35.1, lon = 139.7): Visit {
  return {
    start,
    end,
    tzOffsetMin: 540,
    lat,
    lon,
    semanticType: 'UNKNOWN',
    hierarchyLevel: level,
    probability: 1,
    source: 'google',
    durationReliable: true,
  }
}

const WINDOW = { start: 0, end: 100000 }

describe('trackWeights', () => {
  it('近接した点には「次の点までの秒数」をそのまま与える', () => {
    // 250m 未満なので補間は起きない（約 20m と 30m の移動）
    const t = trip([139.7, 35.1, 139.7002, 35.1001, 139.7004, 35.1003], [0, 300, 900])
    const w = trackWeights([t], WINDOW)
    expect(w.count).toBe(3)
    expect([...w.weights]).toEqual([300, 600, 60]) // 最後の点は間隔が分からないので 60 秒
    // 座標は [lon, lat] の順
    expect(w.positions[0]).toBeCloseTo(139.7, 4)
    expect(w.positions[1]).toBeCloseTo(35.1, 4)
  })

  it('離れた点の間を埋める（等速移動が点々にならないように）', () => {
    // 約 9km を 5 分で移動（時速 108km）。250m 刻みなので数十点に割れる
    const t = trip([139.7, 35.1, 139.8, 35.1], [0, 300])
    const w = trackWeights([t], WINDOW)
    expect(w.count).toBeGreaterThan(20)
    // 補間しても合計滞在時間は変わらない（区間の秒数を等分するだけ）
    const sum = [...w.weights].reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(300 + 60, 1)
    // 始点と終点のあいだに点が並ぶ
    const lons = [...w.weights].map((_, i) => w.positions[i * 2]!)
    expect(Math.min(...lons)).toBeCloseTo(139.7, 3)
    expect(Math.max(...lons)).toBeCloseTo(139.8, 3)
  })

  it('速すぎる区間は載せない（上空を通っただけなので）', () => {
    // 約 900km を 1 時間（時速 900km）。始点は落ち、終点だけが 60 秒で残る
    const t = trip([139.7, 35.1, 149.7, 35.1], [0, 3600])
    const w = trackWeights([t], WINDOW)
    expect(w.count).toBe(1)
    expect(w.positions[0]).toBeCloseTo(149.7, 3)
  })

  it('飛行トリップの長い区間は載せない（大圏補間が点線として出るため）', () => {
    // 補間済みの飛行トリップを模す。1 区間 100km を 600 秒（時速 600km）
    const t: Trip = {
      coords: new Float64Array([139.7, 35.1, 140.8, 35.1, 141.9, 35.1]),
      times: new Int32Array([0, 600, 1200]),
      tStart: 0,
      tEnd: 1200,
      mode: 'FLYING',
      isFlight: true,
    }
    const w = trackWeights([t], WINDOW)
    // 最後の点だけが残る
    expect(w.count).toBe(1)
  })

  it('間隔が長すぎる区間は 30 分で頭打ちにする', () => {
    // 上限が無いと、記録が飛んだ区間が何時間分もの重みを持ち、
    // 実際には居なかった場所に山ができてしまう。
    // 補間で複数点に割れるので、合計が 1800 秒に収まっていることを見る。
    const t = trip([139.7, 35.1, 139.8, 35.2], [0, 50000])
    const w = trackWeights([t], WINDOW)
    const sum = [...w.weights].reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1800 + 60, 1)
  })

  it('期間の外の点は数えない', () => {
    const t = trip([139.7, 35.1, 139.8, 35.2], [0, 300])
    const w = trackWeights([t], { start: 200, end: 100000 })
    expect(w.count).toBe(1)
    expect(w.positions[0]).toBeCloseTo(139.8, 4)
  })

  it('合計秒数は重みの合計と一致する', () => {
    const t = trip([139.7, 35.1, 139.8, 35.2, 139.9, 35.3], [0, 300, 900])
    const w = trackWeights([t], WINDOW)
    expect(w.totalSeconds).toBeCloseTo(
      [...w.weights].reduce((a, b) => a + b, 0),
      1,
    )
  })
})

describe('visitWeights', () => {
  it('hierarchyLevel 1 は二重計上になるので除外する', () => {
    // 実データでは level 1 の 623 件中 622 件が level 0 と時間で重なっている
    const visits = [visit(0, 3600, 0), visit(0, 3600, 1)]
    const w = visitWeights(visits, WINDOW)
    expect(w.count).toBe(1)
    expect(w.totalSeconds).toBe(3600)
  })

  it('期間からはみ出した分は数えない', () => {
    const w = visitWeights([visit(0, 3600, 0)], { start: 1800, end: 100000 })
    expect(w.totalSeconds).toBe(1800)
  })

  it('期間に重ならない訪問は落とす', () => {
    const w = visitWeights([visit(0, 3600, 0)], { start: 7200, end: 100000 })
    expect(w.count).toBe(0)
  })

  it('滞在時間を信用できない訪問は使わない', () => {
    const derived = { ...visit(0, 3600, 0), durationReliable: false, source: 'derived' as const }
    expect(visitWeights([derived], WINDOW).count).toBe(0)
  })
})

describe('hasVisitWeights', () => {
  // UI の「滞在」を選ばせるかどうかの判定。visitWeights が空を返す条件で true を
  // 返してしまうと、選べるのに何も出ない状態になる。両者は必ず一致していること。
  const cases: Array<[string, Visit[]]> = [
    ['Google の訪問', [visit(0, 3600, 0)]],
    ['復元した訪問だけ', [{ ...visit(0, 3600, 0), durationReliable: false, source: 'derived' }]],
    ['hierarchyLevel 1 だけ', [visit(0, 3600, 1)]],
    ['期間に重ならない訪問', [visit(200000, 260000, 0)]],
    ['訪問なし', []],
  ]

  for (const [name, visits] of cases) {
    it(`${name}: visitWeights が点を作れるときだけ true`, () => {
      expect(hasVisitWeights(visits, WINDOW)).toBe(visitWeights(visits, WINDOW).count > 0)
    })
  }
})

describe('aggregateToCells', () => {
  const pts = (coords: number[], weights: number[]) => ({
    positions: new Float32Array(coords),
    weights: new Float32Array(weights),
    count: weights.length,
    totalSeconds: weights.reduce((a, b) => a + b, 0),
  })

  it('近い点は 1 マスにまとまり、重みは足される', () => {
    // 同じ 150m マスに入る 2 点（約 20m 差）
    const p = pts([139.7, 35.1, 139.7002, 35.1001], [600, 1200])
    const cells = aggregateToCells(p, 150)
    expect(cells.count).toBe(1)
    expect(cells.weights[0]).toBe(1800)
  })

  it('離れた点は別のマスになる', () => {
    // 約 900m 離れている
    const p = pts([139.7, 35.1, 139.71, 35.1], [600, 600])
    const cells = aggregateToCells(p, 150)
    expect(cells.count).toBe(2)
  })

  it('マスの位置は滞在時間で加重した重心になる', () => {
    const p = pts([139.7, 35.1, 139.7002, 35.1], [100, 300])
    const cells = aggregateToCells(p, 150)
    expect(cells.count).toBe(1)
    // 重みが 1:3 なので、重心は後者寄り（139.70015）
    expect(cells.positions[0]).toBeCloseTo(139.70015, 4)
  })

  it('合計滞在時間は保存される', () => {
    const p = pts([139.7, 35.1, 139.71, 35.1, 139.7001, 35.1], [600, 900, 300])
    const cells = aggregateToCells(p, 150)
    expect(cells.totalSeconds).toBe(1800)
  })

  it('点が無ければ空を返す', () => {
    expect(aggregateToCells(pts([], []), 150).count).toBe(0)
  })
})

describe('heatCellMeters', () => {
  const LAT = 36

  it('寄っているときは利用者が選んだ粒度をそのまま使う', () => {
    // z14 は 1 画素あたり 10m 弱。粒度 250m の方が粗いのでそちらが勝つ
    expect(heatCellMeters(250, 14, LAT)).toBe(250)
    expect(heatCellMeters(100, 14, LAT)).toBe(100)
  })

  it('引くほどマスが大きくなる（1 画素あたりのマス数を一定に保つため）', () => {
    const zooms = [14, 12, 10, 8, 6]
    const cells = zooms.map((z) => heatCellMeters(250, z, LAT))
    for (let i = 1; i < cells.length; i++) {
      expect(cells[i]!).toBeGreaterThanOrEqual(cells[i - 1]!)
    }
    // 全国が見えるくらいまで引くと km 単位になる
    expect(heatCellMeters(250, 6, LAT)).toBeGreaterThan(1000)
  })

  it('引きのときは 1・2・5 × 10^n に丸まる（格子のキャッシュが効くように）', () => {
    for (const z of [5, 6, 7, 8, 9]) {
      const c = heatCellMeters(250, z, LAT)
      const m = c / 10 ** Math.floor(Math.log10(c))
      expect([1, 2, 5]).toContain(Math.round(m))
    }
  })

  it('高緯度ではマスが小さくなる（1 画素あたりの距離が縮むため）', () => {
    expect(heatCellMeters(100, 10, 60)).toBeLessThanOrEqual(heatCellMeters(100, 10, 0))
  })
})
