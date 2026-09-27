/**
 * GeoJSON 書き出し（DESIGN.md §7 P3）の純関数。
 *
 * 書き出しは利用者がボタンを押したときだけ、端末内のファイルとして保存する。
 * どこにも送信しない（DESIGN.md §9 の 1）。ここでは文字列化の手前までを作り、
 * 保存は ui/download.ts が受け持つ。
 *
 * GeoJSON の型は依存を増やさないために最小限だけ自前で持つ（RFC 7946 の部分集合）。
 */
import type { Dataset, Place, Seconds, TimeWindow, TravelMode, Trip } from './types'
import { placeName } from './ranking'

/** [経度, 緯度]。GeoJSON は経度が先（RFC 7946 §3.1.1） */
export type Position = [number, number]

export interface PointGeometry {
  type: 'Point'
  coordinates: Position
}

export interface LineStringGeometry {
  type: 'LineString'
  coordinates: Position[]
}

export interface Feature<G, P> {
  type: 'Feature'
  geometry: G
  properties: P
}

export interface FeatureCollection<G, P> {
  type: 'FeatureCollection'
  features: Feature<G, P>[]
}

export interface PlaceProperties {
  name: string
  visitDays: number
  visitCount: number
  /** 信頼できる滞在時間（時間、小数 2 桁）。推定だけの場所は時間を測れないので null */
  reliableHours: number | null
  firstSeen: string
  lastSeen: string
  semanticType: Place['semanticType']
  sources: Place['sources']
}

export interface TripProperties {
  /** 期間で切ったあとの最初の点の時刻（UTC の ISO 8601） */
  start: string
  end: string
  mode: TravelMode
  isFlight: boolean
  /** coordinates と同じ並び・同じ個数の時刻（UTC の ISO 8601） */
  coordTimes: string[]
}

/**
 * 小数 6 桁（≒ 0.1m）に丸める。GPS の精度はこれより粗いので情報は失われず、
 * 倍精度の末尾の桁（139.76543210000001 など）でファイルが膨らむのを防ぐ。
 */
export function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6
}

/** Unix 秒 → UTC の ISO 8601。秒単位のデータなのでミリ秒の「.000」は付けない */
export function isoUtc(t: Seconds): string {
  return new Date(t * 1000).toISOString().replace('.000Z', 'Z')
}

/**
 * 場所を Point の FeatureCollection にする。
 * places の並び順をそのまま使い、名前の無い場所は並び順の番号（場所 #n）で呼ぶ。
 */
export function placesToGeoJSON(
  places: Place[],
  labels: Record<string, string>,
  anchors: Dataset['anchors'],
): FeatureCollection<PointGeometry, PlaceProperties> {
  return {
    type: 'FeatureCollection',
    features: places.map((p, i) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [round6(p.lon), round6(p.lat)] },
      properties: {
        name: placeName(p, i + 1, labels, anchors).text,
        visitDays: p.visitDays,
        visitCount: p.visitCount,
        reliableHours: p.reliableSeconds > 0 ? Math.round(p.reliableSeconds / 36) / 100 : null,
        firstSeen: isoUtc(p.firstSeen),
        lastSeen: isoUtc(p.lastSeen),
        semanticType: p.semanticType,
        sources: p.sources.slice(),
      },
    })),
  }
}

/**
 * 軌跡を LineString の FeatureCollection にする。
 *
 * 期間の外の点は落とす（期間を選んで書き出したのに、その前後の移動まで入ると
 * 意図しない場所の座標を渡してしまうため）。境界は再生・重力マップと同じく両端を含む。
 * 期間内に 2 点未満しか残らないトリップは線にならないので出さない。Point を混ぜると
 * 1 つのファイルに幾何の種類が混ざり、GIS ソフトで 1 レイヤーとして読めなくなる。
 */
export function tripsToGeoJSON(
  trips: Trip[],
  window: TimeWindow,
): FeatureCollection<LineStringGeometry, TripProperties> {
  const features: Feature<LineStringGeometry, TripProperties>[] = []

  for (const trip of trips) {
    if (trip.tEnd < window.start || trip.tStart > window.end) continue

    const coordinates: Position[] = []
    const coordTimes: string[] = []
    let first = 0
    let last = 0
    for (let i = 0; i < trip.times.length; i++) {
      const t = trip.times[i]!
      if (t < window.start || t > window.end) continue
      if (coordinates.length === 0) first = t
      last = t
      coordinates.push([round6(trip.coords[i * 2]!), round6(trip.coords[i * 2 + 1]!)])
      coordTimes.push(isoUtc(t))
    }
    if (coordinates.length < 2) continue

    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates },
      properties: {
        start: isoUtc(first),
        end: isoUtc(last),
        mode: trip.mode,
        isFlight: trip.isFlight,
        coordTimes,
      },
    })
  }

  return { type: 'FeatureCollection', features }
}
