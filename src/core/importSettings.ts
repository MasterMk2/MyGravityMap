/** Import-time only. Original JSON is never changed; cache identity includes the threshold. */
export const DEFAULT_TRIP_GAP_SEC = 1800
export function isTripGapSec(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 60 && value <= 86400
}
export function validateTripGapSec(value: unknown): number {
  if (!isTripGapSec(value)) throw new RangeError('分割閾値は 1〜1440 分の範囲で指定してください')
  return value
}
export function importCacheKey(base: string, gapSec: number, pipelineVersion: number): string {
  validateTripGapSec(gapSec)
  return `${base}${gapSec === DEFAULT_TRIP_GAP_SEC ? '' : `:gap${gapSec}`}:p${pipelineVersion}`
}
