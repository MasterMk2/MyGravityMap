/**
 * 場所ランキング（DESIGN.md §5 ビュー #3）の純関数。
 *
 * Dataset.places は全期間の集計なので、期間スライダーを動かしても順位が変わらない。
 * ランキングは「選んだ期間の自分」を見るためのものなので、訪問を期間で切ってから
 * 集計し直す。集計の中身は aggregatePlaces と同じものを通す（ランキングと重力マップで
 * 「日数」の数え方が食い違うと、同じ場所の重さが画面ごとに違って見えるため）。
 */
import type { Dataset, Place, TimeWindow, Visit } from './types'
import { aggregatePlaces } from './aggregate'

export type PlaceSort = 'days' | 'time' | 'count'

type Anchors = Dataset['anchors']

/**
 * 期間に重なる level 0 の訪問を、期間の端で切り詰めて返す。
 *
 * - level 1 は level 0 と時間が重複する（DESIGN.md §1.3）ので、ここで落とす。
 * - 期間をまたぐ滞在は、はみ出した分を数えない。開始時刻も期間の頭に寄せるので、
 *   「前の年の大晦日から泊まっていた」滞在は期間の初日の訪問として 1 日に数えられる。
 * - 重なりの判定は重力マップ（gravity/weights.ts）と同じ半開区間。境界ちょうどで
 *   終わった滞在は期間内に入れない（長さ 0 の訪問が 1 日として数えられてしまうため）。
 */
export function clipVisitsToWindow(visits: Visit[], w: TimeWindow): Visit[] {
  const out: Visit[] = []
  for (const v of visits) {
    if (v.hierarchyLevel !== 0) continue
    if (!(v.start < w.end && v.end > w.start)) continue
    if (v.start >= w.start && v.end <= w.end) {
      // 切る必要が無いものはそのまま使う（6 千件のコピーを避ける）
      out.push(v)
      continue
    }
    out.push({ ...v, start: Math.max(v.start, w.start), end: Math.min(v.end, w.end) })
  }
  return out
}

/** 期間内の場所（並べる前）。UI では並べ替えだけを別にメモ化したいので分けてある */
export function placesInWindow(visits: Visit[], w: TimeWindow): Place[] {
  return aggregatePlaces(clipVisitsToWindow(visits, w)).places
}

function byId(a: Place, b: Place): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * 並べ替え。入力は変更しない。同点は id の昇順で決め打ちにする
 * （Map の挿入順＝訪問の順に依存すると、期間を少し動かしただけで同点の行が入れ替わって見える）。
 *
 * 'time' は reliableSeconds（Google の訪問データの滞在時間）だけで並べる。
 * 軌跡から推定した滞在は時間を信用できない（DESIGN.md §1.2.1）ので 0 のままで、
 * 自然に末尾へ回る。末尾の中身が id 順だと利用者には無意味な並びになるので、
 * そこだけは日数で並べてから id で決める。
 */
export function sortPlaces(places: Place[], sortBy: PlaceSort): Place[] {
  const out = places.slice()
  switch (sortBy) {
    case 'days':
      out.sort((a, b) => b.visitDays - a.visitDays || byId(a, b))
      break
    case 'count':
      out.sort((a, b) => b.visitCount - a.visitCount || byId(a, b))
      break
    case 'time':
      out.sort(
        (a, b) =>
          b.reliableSeconds - a.reliableSeconds || b.visitDays - a.visitDays || byId(a, b),
      )
      break
  }
  return out
}

/** 期間連動の場所ランキング */
export function rankPlaces(visits: Visit[], window: TimeWindow, sortBy: PlaceSort): Place[] {
  return sortPlaces(placesInWindow(visits, window), sortBy)
}

/** 「時間」で並べる意味があるか（＝信頼できる滞在時間を持つ場所が 1 つでもあるか） */
export function hasReliableTime(places: Place[]): boolean {
  return places.some((p) => p.reliableSeconds > 0)
}

/** 軌跡から推定した滞在だけでできている場所か。UI の「推定」バッジに使う */
export function isDerivedOnly(place: Place): boolean {
  return place.sources.length > 0 && place.sources.every((s) => s === 'derived')
}

const SEMANTIC_LABEL: Partial<Record<Place['semanticType'], string>> = {
  HOME: '自宅',
  WORK: '職場',
  INFERRED_HOME: '自宅（推定）',
  INFERRED_WORK: '職場（推定）',
  SEARCHED_ADDRESS: '検索した場所',
}

const ANCHOR_LABEL: Record<string, string> = {
  HOME: '自宅',
  WORK: '職場',
}

/**
 * 地名解決なしで付けられる自動ラベル（DESIGN.md §8 A）。
 *
 * userLocationProfile の HOME / WORK は Google が利用者の設定から持っている値なので、
 * 訪問ごとに揺れる semanticType（INFERRED_* を含む）より優先する。
 */
export function autoLabel(place: Place, anchors: Anchors): string | undefined {
  for (const a of anchors) {
    if (a.placeId !== place.id || !a.label) continue
    const label = ANCHOR_LABEL[a.label.toUpperCase()]
    if (label) return label
  }
  return SEMANTIC_LABEL[place.semanticType]
}

/** 座標の目安（小数 2 桁 ≒ 1km）。名前の無い場所どうしを見分けるためだけに出す */
export function coordHint(place: Pick<Place, 'lat' | 'lon'>): string {
  return `${place.lat.toFixed(2)}, ${place.lon.toFixed(2)}`
}

export interface PlaceName {
  text: string
  /** 名前の出どころ。UI で「名前なし」の行にだけ座標の目安を添えるために使う */
  kind: 'user' | 'auto' | 'fallback'
}

/**
 * 表示名。利用者のラベル > 自動ラベル > 「場所 #順位」。
 * placeId は Google 内部の識別子で、見ても何の場所か分からないので表示に使わない。
 */
export function placeName(
  place: Place,
  rank: number,
  labels: Record<string, string>,
  anchors: Anchors,
): PlaceName {
  const user = labels[place.id]?.trim()
  if (user) return { text: user, kind: 'user' }
  const auto = autoLabel(place, anchors)
  if (auto) return { text: auto, kind: 'auto' }
  return { text: `場所 #${rank}`, kind: 'fallback' }
}
