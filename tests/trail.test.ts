import { describe, expect, it } from 'vitest'
import { defaultTrailFor } from '../src/playback/usePlayback'

const HOUR = 3600
const DAY = 86400
const WEEK = 604800
const MONTH = 2592000
const QUARTER = 7776000

describe('defaultTrailFor', () => {
  it('1 日を見るときは 1 時間の尾', () => {
    expect(defaultTrailFor(DAY)).toBe(HOUR)
  })

  it('1 か月を見るときは 1 日の尾', () => {
    expect(defaultTrailFor(30 * DAY)).toBe(DAY)
  })

  it('1 年を見るときは 1 週間の尾', () => {
    expect(defaultTrailFor(365 * DAY)).toBe(WEEK)
  })

  it('8 年を見るときは 3 か月の尾（1 週間では一瞬で消える）', () => {
    expect(defaultTrailFor(8 * 365 * DAY)).toBe(QUARTER)
  })

  it('期間が短すぎても最小プリセットを下回らない', () => {
    expect(defaultTrailFor(60)).toBe(HOUR)
  })

  it('期間が伸びるほど尾は単調に長くなる', () => {
    const spans = [DAY, WEEK, MONTH, 365 * DAY, 8 * 365 * DAY]
    const trails = spans.map(defaultTrailFor)
    for (let i = 1; i < trails.length; i++) {
      expect(trails[i]!).toBeGreaterThanOrEqual(trails[i - 1]!)
    }
  })
})
