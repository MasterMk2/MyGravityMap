import type { PlaybackSettings, TravelMode, Trip } from '../core/types'
import { haversineMeters } from '../core/geo'

export type RGB = [number, number, number]

/** HSL → RGB（0-255）。色相環で年や時間帯を回すのに使う */
export function hsl(h: number, s: number, l: number): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x]
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

const MODE_COLORS: Record<TravelMode, RGB> = {
  IN_PASSENGER_VEHICLE: [96, 165, 250],
  WALKING: [94, 234, 212],
  RUNNING: [45, 212, 191],
  CYCLING: [163, 230, 53],
  IN_TRAIN: [251, 191, 36],
  IN_SUBWAY: [249, 115, 22],
  IN_TRAM: [244, 114, 182],
  IN_BUS: [167, 139, 250],
  MOTORCYCLING: [248, 113, 113],
  FLYING: [255, 255, 255],
  UNKNOWN: [148, 163, 184],
}

const SINGLE: RGB = [94, 234, 212]

/** トリップの平均速度（km/h）。色分け「速度別」で使う */
function averageSpeedKmh(t: Trip): number {
  const n = t.times.length
  if (n < 2) return 0
  let meters = 0
  for (let i = 1; i < n; i++) {
    meters += haversineMeters(
      t.coords[(i - 1) * 2 + 1]!,
      t.coords[(i - 1) * 2]!,
      t.coords[i * 2 + 1]!,
      t.coords[i * 2]!,
    )
  }
  const sec = t.times[n - 1]! - t.times[0]!
  return sec > 0 ? (meters / sec) * 3.6 : 0
}

/**
 * トリップごとの色を先に計算しておく。
 * 毎フレーム getColor の中で計算すると再生が重くなるため、
 * colorBy が変わったときだけ作り直す。
 */
export function computeTripColors(
  trips: Trip[],
  colorBy: PlaybackSettings['colorBy'],
  minYear: number,
  maxYear: number,
): Uint8Array {
  const out = new Uint8Array(trips.length * 3)
  const span = Math.max(1, maxYear - minYear)

  for (let i = 0; i < trips.length; i++) {
    const t = trips[i]!
    let c: RGB
    switch (colorBy) {
      case 'mode':
        c = MODE_COLORS[t.mode] ?? MODE_COLORS.UNKNOWN
        break
      case 'year': {
        const year = new Date(t.tStart * 1000).getUTCFullYear()
        c = hsl(((year - minYear) / span) * 280, 0.75, 0.58)
        break
      }
      case 'speed': {
        const v = averageSpeedKmh(t)
        // 0 km/h = 青緑、120 km/h 以上 = 赤。飛行機はさらに上なので白に寄せる
        const clamped = Math.min(1, v / 120)
        c = v > 300 ? [255, 255, 255] : hsl(180 - clamped * 180, 0.8, 0.6)
        break
      }
      case 'hour': {
        // 記録側のタイムゾーンではなく UTC 基準の粗い色分け（P2 で TZ 対応する）
        const h = new Date(t.tStart * 1000).getUTCHours()
        c = hsl((h / 24) * 360, 0.7, 0.6)
        break
      }
      default:
        c = SINGLE
    }
    out[i * 3] = c[0]
    out[i * 3 + 1] = c[1]
    out[i * 3 + 2] = c[2]
  }
  return out
}
