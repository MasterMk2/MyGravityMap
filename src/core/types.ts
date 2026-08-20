/**
 * アプリ全体で共有する型の定義。ここが各モジュール間の契約。
 * 設計は docs/DESIGN.md を参照。
 */

/** 交通手段。Google の activity.topCandidate.type をそのまま使う */
export type TravelMode =
  | 'IN_PASSENGER_VEHICLE'
  | 'WALKING'
  | 'IN_TRAIN'
  | 'IN_BUS'
  | 'IN_TRAM'
  | 'IN_SUBWAY'
  | 'CYCLING'
  | 'MOTORCYCLING'
  | 'RUNNING'
  | 'FLYING'
  | 'UNKNOWN'

export type SemanticType =
  | 'HOME'
  | 'WORK'
  | 'INFERRED_HOME'
  | 'INFERRED_WORK'
  | 'SEARCHED_ADDRESS'
  | 'UNKNOWN'

/** 時刻はすべて Unix 秒（Int32 に収まる: 2038 年まで）。座標は度。 */
export type Seconds = number

/** 正規化済みの生の点。時刻昇順・単調増加が保証される */
export interface TrackPoint {
  t: Seconds
  lat: number
  lon: number
}

/** 滞在 */
export interface Visit {
  start: Seconds
  end: Seconds
  /** 記録側の UTC オフセット（分）。曜日・時間帯の集計は必ずこれを使う */
  tzOffsetMin: number
  lat: number
  lon: number
  placeId?: string
  semanticType: SemanticType
  hierarchyLevel: 0 | 1
  probability: number
  source: 'google' | 'derived'
  /** 滞在時間を数値として信用してよいか。derived は false */
  durationReliable: boolean
}

/** 移動区間（Google の activity セグメント） */
export interface Move {
  start: Seconds
  end: Seconds
  tzOffsetMin: number
  from: [number, number] // [lon, lat]
  to: [number, number]
  distanceMeters: number
  mode: TravelMode
  probability: number
  parking?: { lon: number; lat: number; t: Seconds }
}

/**
 * 再生の単位。取り込み時に一度だけ切って保存する。
 * 保存時は絶対時刻（Unix 秒）。GPU へ渡す直前に選択期間の開始からの
 * 相対秒へ変換する（float32 精度の理由。DESIGN.md §6.4）。
 */
export interface Trip {
  /** [lon, lat, lon, lat, ...] 度のまま保存する */
  coords: Float64Array
  /** 絶対 Unix 秒。coords と同じ点数。厳密に単調増加 */
  times: Int32Array
  tStart: Seconds
  tEnd: Seconds
  mode: TravelMode
  /** 大圏補間を入れた飛行区間を含む */
  isFlight: boolean
}

/** 集約後の「場所」 */
export interface Place {
  id: string
  lat: number
  lon: number
  label?: string
  semanticType: SemanticType
  visitCount: number
  /** 訪問した日数（記録側 TZ の暦日）＝頻度モードの質量 */
  visitDays: number
  /** durationReliable な滞在のみの合計秒 */
  reliableSeconds: number
  /** derived も含む合計秒。年をまたいで比較してはいけない参考値 */
  observedSeconds: number
  firstSeen: Seconds
  lastSeen: Seconds
  byYear: Record<number, YearStat>
  /** 24 要素。滞在の時間帯プロファイル */
  byHour: Int32Array
  /** 7 要素（0=日曜） */
  byWeekday: Int32Array
  sources: ('google' | 'derived')[]
}

export interface YearStat {
  days: number
  count: number
  reliableSeconds: number
  observedSeconds: number
}

/** 年ごとの記録の濃さ。正規化と UI の警告表示に使う */
export interface YearCoverage {
  year: number
  recordedDays: number
  /** timelinePath のバケット数 × 2h / 記録日数 */
  coverageHoursPerDay: number
  /** false の年は「時間モード」を禁止する */
  hasGoogleVisits: boolean
}

/** 解析結果ひとまとめ。これを IndexedDB に保存する */
export interface Dataset {
  /** ファイル内容のハッシュ。同じファイルなら再解析しない */
  fileHash: string
  fileName: string
  parsedAt: Seconds
  tMin: Seconds
  tMax: Seconds
  trips: Trip[]
  visits: Visit[]
  moves: Move[]
  places: Place[]
  coverage: YearCoverage[]
  /** userLocationProfile.frequentPlaces の HOME / WORK */
  anchors: { placeId: string; lat: number; lon: number; label?: string }[]
  stats: ParseStats
}

export interface ParseStats {
  segments: number
  timelinePathPoints: number
  visitSegments: number
  activitySegments: number
  memorySegments: number
  /** 破棄した rawSignals の件数（保持はしない） */
  rawSignalsDiscarded: number
  /** 同時刻・別座標で丸めた点の数 */
  duplicateTimeFixed: number
  /** 大圏補間で挿入した点の数 */
  flightPointsInserted: number
}

/** Worker → メインスレッドのメッセージ */
export type ParseMessage =
  | { type: 'progress'; phase: string; bytesRead: number; bytesTotal: number }
  | { type: 'done'; dataset: Dataset }
  | { type: 'error'; message: string }

/** 再生対象の期間（絶対 Unix 秒） */
export interface TimeWindow {
  start: Seconds
  end: Seconds
}

/** 記録が無い区間 */
export interface Gap {
  start: Seconds
  end: Seconds
}

/**
 * 「再生上の時間」と「実際の時刻」の対応。
 * 空白スキップが ON のとき、記録の無い区間を詰めた圧縮時間軸を作る。
 * OFF のときは恒等写像（totalSec = 期間の長さ）。
 */
export interface TimeMap {
  /** 圧縮後の総再生秒数（実時間） */
  totalSec: number
  /** 圧縮時間 → 実時刻 */
  toReal(compressed: number): Seconds
  /** 実時刻 → 圧縮時間 */
  toCompressed(real: Seconds): number
}

/** 再生の設定 */
export interface PlaybackSettings {
  /** 実時間倍率 */
  speed: number
  /** 移動痕の表現 */
  trail: 'gradient' | 'solid' | 'both'
  /** グラデーションの尾の長さ（秒） */
  trailLengthSec: number
  /** 記録の無い期間を飛ばす */
  skipGaps: boolean
  colorBy: 'single' | 'mode' | 'year' | 'speed' | 'hour'
  lineWidth: number
  opacity: number
  additiveBlending: boolean
  camera: 'follow' | 'fixed' | 'fitDay'
}
