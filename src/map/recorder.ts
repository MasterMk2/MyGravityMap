/**
 * 再生の様子を動画（WebM / MP4）に録る（DESIGN.md §7 P3）。
 *
 * 地図（MapLibre）と軌跡（deck.gl）は別々の WebGL キャンバスに描かれていて、
 * どちらも preserveDrawingBuffer を切ってある。描画が画面に出た後はバッファを読めないので、
 * それぞれが描き終わった直後（MapLibre の render イベント / deck.gl の onAfterRender）に
 * 2D キャンバスへ写し取り、録画用のキャンバスで重ねる。
 * 常に preserveDrawingBuffer を有効にしておく方法もあるが、録画しないときまで
 * 再生が重くなるので採らない。
 *
 * 録ったものはこの端末に保存するだけで、どこにも送らない。
 */
import type { Map as MapLibreMap } from 'maplibre-gl'
import type { MapboxOverlay } from '@deck.gl/mapbox'
import type { Deck } from '@deck.gl/core'

export interface Recording {
  /** 録画を止めて、録れた動画を返す。何も録れなかったら null */
  stop(): Promise<Blob | null>
  /** 保存するときの拡張子（ブラウザが対応する形式で決まる） */
  extension: 'webm' | 'mp4'
}

export interface RecordingOptions {
  /** 地図にだけ掛けている CSS フィルタ（「地図を沈める」）。画面と同じ見た目にする */
  mapFilter?: string | undefined
  /** 右下に焼き込む帰属表示（ODbL / タイル配信元）。動画だけが共有されても残るように */
  attribution: string
  /** 左上に出す時刻。毎フレーム呼ぶ（地図のキャンバスには時計が描かれていないため） */
  label: () => string
  fps?: number
}

/** 候補を順に試す。Chrome / Firefox は WebM、Safari は MP4 しか録れない */
const MIME_CANDIDATES: Array<[string, Recording['extension']]> = [
  ['video/webm;codecs=vp9', 'webm'],
  ['video/webm;codecs=vp8', 'webm'],
  ['video/webm', 'webm'],
  ['video/mp4', 'mp4'],
]

/** 録画の横幅の上限。高解像度の画面をそのまま録ると、エンコードが追いつかずコマが落ちる */
const MAX_WIDTH = 1920

export function canRecord(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function' &&
    MIME_CANDIDATES.some(([m]) => MediaRecorder.isTypeSupported(m))
  )
}

export function startRecording(
  map: MapLibreMap,
  overlay: MapboxOverlay | null,
  opts: RecordingOptions,
): Recording | null {
  const picked = MIME_CANDIDATES.find(([m]) => MediaRecorder.isTypeSupported(m))
  if (!picked) return null
  const [mimeType, extension] = picked

  const mapCanvas = map.getCanvas()
  const scale = Math.min(1, MAX_WIDTH / mapCanvas.width)
  // エンコーダによっては奇数の幅・高さを受け付けない
  const w = Math.round((mapCanvas.width * scale) / 2) * 2
  const h = Math.round((mapCanvas.height * scale) / 2) * 2

  const makeCanvas = () => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    return c
  }
  const mapBuf = makeCanvas()
  const deckBuf = makeCanvas()
  const out = makeCanvas()
  const mapCtx = mapBuf.getContext('2d')
  const deckCtx = deckBuf.getContext('2d')
  const ctx = out.getContext('2d')
  if (!mapCtx || !deckCtx || !ctx) return null

  const onMapRender = () => {
    if (opts.mapFilter) mapCtx.filter = opts.mapFilter
    mapCtx.drawImage(mapCanvas, 0, 0, w, h)
    mapCtx.filter = 'none'
  }
  map.on('render', onMapRender)

  // MapboxOverlay は内部の Deck を公開していない。取れなければ地図だけを録る。
  const deck = (overlay as unknown as { _deck?: Deck } | null)?._deck
  const onAfterRender = () => {
    const c = deck?.getCanvas()
    if (!c) return
    deckCtx.clearRect(0, 0, w, h)
    deckCtx.drawImage(c, 0, 0, w, h)
  }
  // MapboxOverlay は自分の持つ props を丸ごと Deck に渡し直すので、Deck ではなく
  // overlay 側に設定する（Deck に直接入れると、次の setProps で消えることがある）
  overlay?.setProps({ onAfterRender })

  const px = w / Math.max(1, mapCanvas.clientWidth * scale)
  let raf = 0
  const compose = () => {
    ctx.fillStyle = '#0b0d12'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(mapBuf, 0, 0)
    ctx.drawImage(deckBuf, 0, 0)

    // 左上の時刻
    const label = opts.label()
    ctx.font = `600 ${Math.round(18 * px)}px system-ui, sans-serif`
    const lw = ctx.measureText(label).width + 20 * px
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'
    ctx.fillRect(12 * px, 12 * px, lw, 32 * px)
    ctx.fillStyle = '#e8eaf0'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, 22 * px, 28 * px)

    // 右下の帰属表示
    const text = opts.attribution ? `${opts.attribution} · MyGravityMap` : 'MyGravityMap'
    ctx.font = `${Math.round(11 * px)}px system-ui, sans-serif`
    const aw = ctx.measureText(text).width + 12 * px
    const ah = 18 * px
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
    ctx.fillRect(w - aw, h - ah, aw, ah)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
    ctx.fillText(text, w - aw + 6 * px, h - ah / 2)

    raf = requestAnimationFrame(compose)
  }

  // 最初のコマが空にならないよう、両方を一度描き直させてから録り始める
  map.triggerRepaint()
  deck?.redraw('recording-start')
  compose()

  const stream = out.captureStream(opts.fps ?? 30)
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 })
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  recorder.start(1000)

  return {
    extension,
    stop: () =>
      new Promise((resolve) => {
        const cleanup = () => {
          cancelAnimationFrame(raf)
          map.off('render', onMapRender)
          overlay?.setProps({ onAfterRender: () => undefined })
          for (const t of stream.getTracks()) t.stop()
        }
        if (recorder.state === 'inactive') {
          cleanup()
          resolve(chunks.length ? new Blob(chunks, { type: mimeType }) : null)
          return
        }
        recorder.onstop = () => {
          cleanup()
          resolve(chunks.length ? new Blob(chunks, { type: mimeType }) : null)
        }
        recorder.stop()
      }),
  }
}
