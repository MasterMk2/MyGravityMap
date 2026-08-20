/**
 * IndexedDB 永続化層。`idb` の薄いラッパー。
 *
 * 重要: Dataset の trips / places には Float64Array・Int32Array が入っている。
 * IndexedDB の構造化複製（structured clone）は TypedArray をそのまま保存できる。
 * JSON.stringify は絶対にしないこと（TypedArray が壊れて普通の配列や `{}` になる）。
 * 将来この関数を「デバッグしやすいように」と JSON 経由に書き換えたくなるかもしれないが、
 * それをやると Trip.coords / Trip.times / Place.byHour / Place.byWeekday が全部死ぬ。
 */

import { openDB } from 'idb'
import type { DBSchema, IDBPDatabase } from 'idb'
import type { Dataset } from '../core/types'

const DB_NAME = 'mygravitymap'
const DB_VERSION = 1

interface LabelRecord {
  placeId: string
  label: string
  updatedAt: number
}

interface MyGravityDB extends DBSchema {
  datasets: {
    key: string
    value: Dataset
    indexes: { parsedAt: number }
  }
  labels: {
    key: string
    value: LabelRecord
  }
  settings: {
    key: string
    value: unknown
  }
}

let dbPromise: Promise<IDBPDatabase<MyGravityDB>> | undefined

/** メモ化されたシングルトン。何度呼んでも同じ接続を返す。 */
export function getDb(): Promise<IDBPDatabase<MyGravityDB>> {
  if (!dbPromise) {
    dbPromise = openDB<MyGravityDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const datasets = db.createObjectStore('datasets', { keyPath: 'fileHash' })
        datasets.createIndex('parsedAt', 'parsedAt')

        db.createObjectStore('labels', { keyPath: 'placeId' })

        // out-of-line keys: 値そのものにキーを持たせない
        db.createObjectStore('settings')
      },
    })
  }
  return dbPromise
}

export async function saveDataset(d: Dataset): Promise<void> {
  const db = await getDb()
  await db.put('datasets', d)
}

export async function loadDataset(fileHash: string): Promise<Dataset | undefined> {
  const db = await getDb()
  return db.get('datasets', fileHash)
}

/**
 * newest first. カーソルで parsedAt インデックスを逆順に舐める。
 * db.getAll だと trips/places の TypedArray まで含めて全件を一気に
 * structured-clone してしまい、74MB 級のデータセットではメモリを食い過ぎる。
 * カーソルなら射影した後の各レコードを都度 GC できる。
 */
export async function listDatasets(): Promise<
  Array<Pick<Dataset, 'fileHash' | 'fileName' | 'parsedAt' | 'tMin' | 'tMax'>>
> {
  const db = await getDb()
  const tx = db.transaction('datasets', 'readonly')
  const out: Array<Pick<Dataset, 'fileHash' | 'fileName' | 'parsedAt' | 'tMin' | 'tMax'>> = []
  let cursor = await tx.store.index('parsedAt').openCursor(null, 'prev')
  while (cursor) {
    const d = cursor.value
    out.push({
      fileHash: d.fileHash,
      fileName: d.fileName,
      parsedAt: d.parsedAt,
      tMin: d.tMin,
      tMax: d.tMax,
    })
    cursor = await cursor.continue()
  }
  await tx.done
  return out
}

export async function deleteDataset(fileHash: string): Promise<void> {
  const db = await getDb()
  await db.delete('datasets', fileHash)
}

export async function getLabel(placeId: string): Promise<string | undefined> {
  const db = await getDb()
  const record = await db.get('labels', placeId)
  return record?.label
}

export async function setLabel(placeId: string, label: string): Promise<void> {
  const db = await getDb()
  const record: LabelRecord = { placeId, label, updatedAt: Date.now() }
  await db.put('labels', record)
}

export async function getAllLabels(): Promise<Record<string, string>> {
  const db = await getDb()
  const all = await db.getAll('labels')
  const result: Record<string, string> = {}
  for (const record of all) {
    result[record.placeId] = record.label
  }
  return result
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const db = await getDb()
  const value = await db.get('settings', key)
  return value === undefined ? fallback : (value as T)
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  const db = await getDb()
  await db.put('settings', value, key)
}

/** "全データを消す" ボタン用。3 ストアすべてを空にする。 */
export async function clearAll(): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(['datasets', 'labels', 'settings'], 'readwrite')
  await Promise.all([
    tx.objectStore('datasets').clear(),
    tx.objectStore('labels').clear(),
    tx.objectStore('settings').clear(),
    tx.done,
  ])
}

export async function estimateUsage(): Promise<{ usageBytes: number; quotaBytes: number } | null> {
  if (typeof globalThis.navigator?.storage?.estimate !== 'function') {
    return null
  }
  const { usage, quota } = await navigator.storage.estimate()
  if (usage === undefined || quota === undefined) return null
  return { usageBytes: usage, quotaBytes: quota }
}

const FINGERPRINT_CHUNK_BYTES = 256 * 1024
const FINGERPRINT_SMALL_FILE_THRESHOLD = 512 * 1024

/**
 * SHA-256 over: name, size, lastModified, the first 256KB and the last 256KB of the file.
 * 74MB のファイル全体は絶対にハッシュしない（読み込み時間が倍になる）。
 * 512KB 未満のファイルはファイル全体を一度だけ使う（先頭・末尾の二重カウントを避ける）。
 * 返り値は小文字16進文字列。
 */
export async function fileFingerprint(file: File): Promise<string> {
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') {
    throw new Error('crypto.subtle is not available in this environment')
  }

  const header = `${file.name}|${file.size}|${file.lastModified}|`
  const headerBytes = new TextEncoder().encode(header)

  let bodyBytes: ArrayBuffer[]
  if (file.size < FINGERPRINT_SMALL_FILE_THRESHOLD) {
    bodyBytes = [await file.arrayBuffer()]
  } else {
    const head = file.slice(0, FINGERPRINT_CHUNK_BYTES)
    const tail = file.slice(file.size - FINGERPRINT_CHUNK_BYTES, file.size)
    bodyBytes = [await head.arrayBuffer(), await tail.arrayBuffer()]
  }

  const totalLength = headerBytes.length + bodyBytes.reduce((sum, b) => sum + b.byteLength, 0)
  const combined = new Uint8Array(totalLength)
  combined.set(headerBytes, 0)
  let offset = headerBytes.length
  for (const chunk of bodyBytes) {
    combined.set(new Uint8Array(chunk), offset)
    offset += chunk.byteLength
  }

  const digest = await crypto.subtle.digest('SHA-256', combined)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
