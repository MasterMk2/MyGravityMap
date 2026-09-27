/**
 * 重心の変遷（DESIGN.md §5 ビュー #6）を地図に描く deck.gl レイヤ。
 *
 * 年ごとに「行動半径の円」「重心の点」「年のラベル」を置き、重心を年の順に線で結ぶ。
 * 色は再生の「年別」と同じ色相環（playback/colors.ts）にして、
 * 軌跡の色と重心の色が同じ年を指すようにしてある。
 */
import type { Layer } from '@deck.gl/core'
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import type { Dataset } from '../core/types'
import type { YearBarycenter } from '../core/barycenter'
import { hsl, type RGB } from '../playback/colors'

export interface BarycenterLayerOptions {
  /** 強調する年。それ以外の年は薄くする */
  selectedYear?: number | null | undefined
  /** 色相環の両端。再生と同じ値（dataset.coverage の年の最小・最大）を渡すこと */
  minYear: number
  maxYear: number
}

/**
 * 年の色。playback/colors.ts の computeTripColors（colorBy: 'year'）と同じ式。
 * 範囲外の年は端に寄せる（色相が負になると hsl が崩れた色を返すため）。
 */
export function yearColor(year: number, minYear: number, maxYear: number): RGB {
  const span = Math.max(1, maxYear - minYear)
  const y = Math.min(maxYear, Math.max(minYear, year))
  return hsl(((y - minYear) / span) * 280, 0.75, 0.58)
}

/** 再生（usePlayback）と同じ決め方の年の範囲。色を揃えるために同じ規則を使う */
export function coverageYearRange(dataset: Pick<Dataset, 'coverage'>): {
  minYear: number
  maxYear: number
} {
  const ys = dataset.coverage.map((c) => c.year)
  return ys.length
    ? { minYear: Math.min(...ys), maxYear: Math.max(...ys) }
    : { minYear: 2018, maxYear: 2026 }
}

interface Segment {
  path: [[number, number], [number, number]]
  year: number
}

export function buildBarycenterLayers(
  stats: YearBarycenter[],
  opts: BarycenterLayerOptions,
): Layer[] {
  if (stats.length === 0) return []
  const { minYear, maxYear } = opts
  const selected =
    opts.selectedYear != null && stats.some((s) => s.year === opts.selectedYear)
      ? opts.selectedYear
      : null
  const rgba = (y: number, a: number): [number, number, number, number] => {
    const c = yearColor(y, minYear, maxYear)
    return [c[0], c[1], c[2], a]
  }
  const isDim = (y: number) => selected !== null && y !== selected

  // 強調する年を最後に描いて、重なったときに上に来るようにする
  const ordered =
    selected === null
      ? stats
      : [...stats.filter((s) => s.year !== selected), ...stats.filter((s) => s.year === selected)]

  // 重心を年の順に結ぶ。1 本の線にせず区間ごとに分け、区間を後の年の色で塗る
  const segments: Segment[] = []
  for (let i = 1; i < stats.length; i++) {
    const a = stats[i - 1]!
    const b = stats[i]!
    segments.push({
      path: [
        [a.lon, a.lat],
        [b.lon, b.lat],
      ],
      year: b.year,
    })
  }

  const triggers = [selected, minYear, maxYear]
  const layers: Layer[] = [
    new ScatterplotLayer<YearBarycenter>({
      id: 'barycenter-range',
      data: ordered,
      getPosition: (s) => [s.lon, s.lat],
      getRadius: (s) => s.radiusKm * 1000,
      radiusUnits: 'meters',
      // 行動半径がごく小さい年でも円が消えないように
      radiusMinPixels: 4,
      filled: true,
      stroked: true,
      getFillColor: (s) => rgba(s.year, s.year === selected ? 48 : isDim(s.year) ? 8 : 20),
      getLineColor: (s) => rgba(s.year, s.year === selected ? 255 : isDim(s.year) ? 60 : 190),
      lineWidthUnits: 'pixels',
      getLineWidth: (s) => (s.year === selected ? 2.5 : 1.25),
      updateTriggers: { getFillColor: triggers, getLineColor: triggers, getLineWidth: triggers },
    }),
  ]

  if (segments.length > 0) {
    layers.push(
      new PathLayer<Segment>({
        id: 'barycenter-path',
        data: segments,
        getPath: (d) => d.path,
        getColor: (d) => rgba(d.year, selected === null ? 210 : 110),
        getWidth: 2,
        widthUnits: 'pixels',
        capRounded: true,
        jointRounded: true,
        updateTriggers: { getColor: triggers },
      }),
    )
  }

  layers.push(
    new ScatterplotLayer<YearBarycenter>({
      id: 'barycenter-center',
      data: ordered,
      getPosition: (s) => [s.lon, s.lat],
      getRadius: (s) => (s.year === selected ? 7 : 5),
      radiusUnits: 'pixels',
      filled: true,
      stroked: true,
      getFillColor: (s) => rgba(s.year, isDim(s.year) ? 120 : 255),
      getLineColor: [10, 12, 18, 230],
      lineWidthUnits: 'pixels',
      getLineWidth: 1.5,
      updateTriggers: { getRadius: triggers, getFillColor: triggers },
    }),
    // 年は数字だけなので TextLayer 既定の ASCII 文字集合で足りる
    new TextLayer<YearBarycenter>({
      id: 'barycenter-label',
      data: ordered,
      getPosition: (s) => [s.lon, s.lat],
      getText: (s) => String(s.year),
      getSize: (s) => (s.year === selected ? 14 : 12),
      sizeUnits: 'pixels',
      getColor: (s) => rgba(s.year, isDim(s.year) ? 110 : 255),
      getPixelOffset: [0, -16],
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'bottom',
      fontFamily: 'system-ui, sans-serif',
      fontWeight: 600,
      background: true,
      getBackgroundColor: (s) => [10, 12, 18, isDim(s.year) ? 110 : 200],
      backgroundPadding: [4, 1],
      updateTriggers: { getSize: triggers, getColor: triggers, getBackgroundColor: triggers },
    }),
  )

  return layers
}
