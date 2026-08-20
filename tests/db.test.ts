// @vitest-environment node
/**
 * db.ts の中で環境非依存なのは fileFingerprint だけ（IndexedDB は Node に無い）。
 * Node 22 にはグローバルの File と crypto.subtle があるので、それを使って
 * fake-indexeddb 等の追加依存なしにテストする。
 *
 * getDb / saveDataset / loadDataset / listDatasets / deleteDataset /
 * getLabel / setLabel / getAllLabels / getSetting / setSetting / clearAll /
 * estimateUsage は IndexedDB (openDB) と navigator.storage に依存するため、
 * Node 環境では未テスト。ブラウザ環境（例: vitest browser mode や e2e）が
 * 用意されたらそちらでカバーする。
 */
import { describe, expect, it } from 'vitest'
import { fileFingerprint } from '../src/store/db'

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
