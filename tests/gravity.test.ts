import { describe, expect, it } from 'vitest'
import { trackWeights, visitWeights } from '../src/gravity/weights'
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
  it('各点に「次の点までの秒数」を与える', () => {
    const t = trip([139.7, 35.1, 139.8, 35.2, 139.9, 35.3], [0, 300, 900])
    const w = trackWeights([t], WINDOW)
    expect(w.count).toBe(3)
    expect([...w.weights]).toEqual([300, 600, 60]) // 最後の点は間隔が分からないので 60 秒
    // 座標は [lon, lat] の順
    expect(w.positions[0]).toBeCloseTo(139.7, 4)
    expect(w.positions[1]).toBeCloseTo(35.1, 4)
  })

  it('間隔が長すぎる点は 30 分で頭打ちにする', () => {
    // 上限が無いと、記録が飛んだ区間の直前の 1 点が何時間分もの重みを持ち、
    // 実際には居なかった場所に山ができてしまう
    const t = trip([139.7, 35.1, 139.8, 35.2], [0, 50000])
    const w = trackWeights([t], WINDOW)
    expect(w.weights[0]).toBe(1800)
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
    expect(w.totalSeconds).toBe([...w.weights].reduce((a, b) => a + b, 0))
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
