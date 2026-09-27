// @vitest-environment node
/**
 * db.ts の中で環境非依存なのは fileFingerprint だけ（IndexedDB は Node に無い）。
 * Node 22 にはグローバルの File と crypto.subtle があるので、それを使って
 * fake-indexeddb 等の追加依存なしにテストする。
 *
 * getDb / saveDataset / loadDataset / listDatasets / deleteDataset /
 * getSetting / setSetting / clearAll / estimateUsage は IndexedDB (openDB) と
 * navigator.storage に依存するため、Node 環境では未テスト。ブラウザ環境
 * （例: vitest browser mode や e2e）が用意されたらそちらでカバーする。
 *
 * ラベル（getLabel / setLabel / deleteLabel / getAllLabels）と、それを使う
 * store/labels.ts だけは、idb の openDB を Map で置き換えた最小の偽物で確かめる
 * （依存は増やさない）。確かめているのは「どのストアに何を書き、何を消すか」という
 * db.ts 側の約束までで、IndexedDB 自体の挙動ではない。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deleteLabel,
  fileFingerprint,
  getAllLabels,
  getLabel,
  loadDataset,
  pruneStaleDatasets,
  saveDataset,
  setLabel,
} from '../src/store/db'
import type { Dataset } from '../src/core/types'
import { useLabels } from '../src/store/labels'

/** 偽物への指示。書き込みを失敗させて、ラベルの楽観的更新の巻き戻しを確かめる */
const fakeIdb = vi.hoisted(() => ({ failWrites: false }))

vi.mock('idb', () => {
  // db.ts が使う idb の API のうち、ラベルの読み書きで通る部分だけを真似る
  class FakeDb {
    private stores = new Map<string, { keyPath?: string; rows: Map<string, unknown> }>()

    createObjectStore(name: string, opts?: { keyPath?: string }) {
      this.stores.set(name, { keyPath: opts?.keyPath, rows: new Map() })
      return { createIndex: () => undefined }
    }

    private store(name: string) {
      const s = this.stores.get(name)
      if (!s) throw new Error(`object store が無い: ${name}`)
      return s
    }

    async get(name: string, key: string) {
      return structuredClone(this.store(name).rows.get(key))
    }

    async getAll(name: string) {
      return [...this.store(name).rows.values()].map((v) => structuredClone(v))
    }

    async getAllKeys(name: string) {
      return [...this.store(name).rows.keys()]
    }

    async put(name: string, value: Record<string, unknown>, key?: string) {
      if (fakeIdb.failWrites) throw new Error('書き込みに失敗（テスト用）')
      const s = this.store(name)
      const k = s.keyPath ? String(value[s.keyPath]) : key!
      s.rows.set(k, structuredClone(value))
      return k
    }

    async delete(name: string, key: string) {
      if (fakeIdb.failWrites) throw new Error('書き込みに失敗（テスト用）')
      this.store(name).rows.delete(key)
    }
  }

  return {
    openDB: async (_name: string, _version: number, opts?: { upgrade?: (db: FakeDb) => void }) => {
      const db = new FakeDb()
      opts?.upgrade?.(db)
      return db
    },
  }
})

function makeFile(content: string, name = 'test.json', lastModified = 1700000000000): File {
  return new File([content], name, { type: 'application/json', lastModified })
}

describe('fileFingerprint', () => {
  it('returns a 64-char lowercase hex string', async () => {
    const file = makeFile('hello world')
    const hash = await fileFingerprint(file)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic: same content, name, size, lastModified => same hash', async () => {
    const a = makeFile('same content here')
    const b = makeFile('same content here')
    const [hashA, hashB] = await Promise.all([fileFingerprint(a), fileFingerprint(b)])
    expect(hashA).toBe(hashB)
  })

  it('differs when content differs', async () => {
    const a = makeFile('content A')
    const b = makeFile('content B')
    const [hashA, hashB] = await Promise.all([fileFingerprint(a), fileFingerprint(b)])
    expect(hashA).not.toBe(hashB)
  })

  it('differs when file name differs (same content)', async () => {
    const a = makeFile('identical bytes', 'a.json')
    const b = makeFile('identical bytes', 'b.json')
    const [hashA, hashB] = await Promise.all([fileFingerprint(a), fileFingerprint(b)])
    expect(hashA).not.toBe(hashB)
  })

  it('differs when lastModified differs (same content and name)', async () => {
    const a = makeFile('identical bytes', 'same.json', 1700000000000)
    const b = makeFile('identical bytes', 'same.json', 1800000000000)
    const [hashA, hashB] = await Promise.all([fileFingerprint(a), fileFingerprint(b)])
    expect(hashA).not.toBe(hashB)
  })

  it('handles a small file (<512KB) using the whole content without double-counting', async () => {
    // 512KB 未満なので head/tail の二重読みではなく、ファイル全体を一度だけ使う。
    // ここでは「512KB 境界の内側で安定した値を返す」ことだけを確認する。
    const small = 'x'.repeat(1000)
    const file = makeFile(small, 'small.json')
    const hash1 = await fileFingerprint(file)
    const hash2 = await fileFingerprint(makeFile(small, 'small.json'))
    expect(hash1).toBe(hash2)
    expect(hash1).toMatch(/^[0-9a-f]{64}$/)
  })

  it('handles an empty file', async () => {
    const file = makeFile('', 'empty.json')
    const hash = await fileFingerprint(file)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('handles a file at exactly the 512KB threshold boundary', async () => {
    // size === threshold は "smaller than 512KB" ではないので head/tail 経路を通る。
    const exact = 'y'.repeat(512 * 1024)
    const file = makeFile(exact, 'boundary.json')
    const hash = await fileFingerprint(file)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('ignores the middle of a large file (only head+tail 256KB are hashed)', async () => {
    // 設計の核心: 74MB のファイル全体を読まずに済むのは、先頭・末尾だけを見て
    // 中間を無視するから。同じ head/tail・同じ size なら中身が違っても同じハッシュに
    // なることを確認する。将来「全体をハッシュすべきでは」と書き換えられたら壊れるテスト。
    const head = 'a'.repeat(256 * 1024)
    const tail = 'b'.repeat(256 * 1024)
    const fileOne = makeFile(head + 'MIDDLE-ONE-XXXXX' + tail, 'large.json')
    const fileTwo = makeFile(head + 'MIDDLE-TWO-YYYYY' + tail, 'large.json')
    expect(fileOne.size).toBe(fileTwo.size)
    const [hashOne, hashTwo] = await Promise.all([fileFingerprint(fileOne), fileFingerprint(fileTwo)])
    expect(hashOne).toBe(hashTwo)
  })

  it('detects a changed first byte of a large file (head is actually read)', async () => {
    const head = 'a'.repeat(256 * 1024)
    const tail = 'b'.repeat(256 * 1024)
    const middle = 'MIDDLE-XXXXXXXXX'
    const fileOne = makeFile(head + middle + tail, 'large.json')
    const changedHead = 'c' + head.slice(1)
    const fileTwo = makeFile(changedHead + middle + tail, 'large.json')
    expect(fileOne.size).toBe(fileTwo.size)
    const [hashOne, hashTwo] = await Promise.all([fileFingerprint(fileOne), fileFingerprint(fileTwo)])
    expect(hashOne).not.toBe(hashTwo)
  })

  it('detects a changed last byte of a large file (tail is actually read)', async () => {
    const head = 'a'.repeat(256 * 1024)
    const tail = 'b'.repeat(256 * 1024)
    const middle = 'MIDDLE-XXXXXXXXX'
    const fileOne = makeFile(head + middle + tail, 'large.json')
    const changedTail = tail.slice(0, -1) + 'd'
    const fileTwo = makeFile(head + middle + changedTail, 'large.json')
    expect(fileOne.size).toBe(fileTwo.size)
    const [hashOne, hashTwo] = await Promise.all([fileFingerprint(fileOne), fileFingerprint(fileTwo)])
    expect(hashOne).not.toBe(hashTwo)
  })
})

describe('deleteLabel', () => {
  beforeEach(() => {
    fakeIdb.failWrites = false
  })

  it('消したラベルは getLabel / getAllLabels から消え、ほかのラベルは残る', async () => {
    await setLabel('fake-del-a', '図書館')
    await setLabel('fake-del-b', '公園')
    await deleteLabel('fake-del-a')
    expect(await getLabel('fake-del-a')).toBeUndefined()
    const all = await getAllLabels()
    expect(all).not.toHaveProperty('fake-del-a')
    expect(all['fake-del-b']).toBe('公園')
  })

  it('無いキーを消してもエラーにならない', async () => {
    await expect(deleteLabel('fake-never-saved')).resolves.toBeUndefined()
  })

  it('格子キー（grid:...）もそのままキーとして扱う', async () => {
    await setLabel('grid:111:222', '駅前')
    expect(await getLabel('grid:111:222')).toBe('駅前')
    await deleteLabel('grid:111:222')
    expect(await getLabel('grid:111:222')).toBeUndefined()
  })
})

describe('useLabels（store/labels.ts）', () => {
  beforeEach(() => {
    fakeIdb.failWrites = false
  })

  it('load() で保存済みのラベルを読み込む（何度呼んでも 1 回）', async () => {
    await setLabel('fake-store-home', '実家')
    const first = useLabels.getState().load()
    expect(useLabels.getState().load()).toBe(first)
    await first
    expect(useLabels.getState().loaded).toBe(true)
    expect(useLabels.getState().labels['fake-store-home']).toBe('実家')
  })

  it('setLabel は前後の空白を落とし、保存を待たずに画面の状態へ反映する', async () => {
    const pending = useLabels.getState().setLabel('grid:1:2', '  図書館 ')
    expect(useLabels.getState().labels['grid:1:2']).toBe('図書館')
    await pending
    expect(await getLabel('grid:1:2')).toBe('図書館')
  })

  it('空白だけのラベルは削除として扱う（自動ラベルの表示に戻す）', async () => {
    await useLabels.getState().setLabel('grid:3:4', '駐車場')
    await useLabels.getState().setLabel('grid:3:4', '   ')
    expect(useLabels.getState().labels).not.toHaveProperty('grid:3:4')
    expect(await getLabel('grid:3:4')).toBeUndefined()
    expect(await getAllLabels()).not.toHaveProperty('grid:3:4')
  })

  it('保存に失敗したら画面の状態を元に戻し、理由を残す', async () => {
    await useLabels.getState().setLabel('fake-fail', '元の名前')
    fakeIdb.failWrites = true
    await useLabels.getState().setLabel('fake-fail', '新しい名前')
    expect(useLabels.getState().labels['fake-fail']).toBe('元の名前')
    expect(useLabels.getState().error).toMatch(/失敗/)
    // 消すのに失敗した場合も戻る
    await useLabels.getState().setLabel('fake-fail', '')
    expect(useLabels.getState().labels['fake-fail']).toBe('元の名前')
    fakeIdb.failWrites = false
    expect(await getLabel('fake-fail')).toBe('元の名前')
  })
})

describe('pruneStaleDatasets', () => {
  it('取り込みの版が今と違う解析結果だけを消す', async () => {
    const d = (fileHash: string) => ({ fileHash, parsedAt: 0 }) as unknown as Dataset
    await saveDataset(d('aaa:p2'))
    await saveDataset(d('bbb:p3'))
    await saveDataset(d('demo:1:v1:p2'))
    await saveDataset(d('demo:1:v1:p3'))
    expect(await pruneStaleDatasets(':p3')).toBe(2)
    expect(await loadDataset('aaa:p2')).toBeUndefined()
    expect(await loadDataset('demo:1:v1:p2')).toBeUndefined()
    expect((await loadDataset('bbb:p3'))?.fileHash).toBe('bbb:p3')
    expect((await loadDataset('demo:1:v1:p3'))?.fileHash).toBe('demo:1:v1:p3')
  })
})
