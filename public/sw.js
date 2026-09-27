/*
 * オフラインでも開けるようにするための Service Worker（DESIGN.md §7 P3 の PWA）。
 *
 * 扱うのは同じオリジンの静的ファイル（HTML / JS / CSS / アイコン）だけ。
 * - 位置データは fetch を通らない（ファイル選択で読み、IndexedDB に置く）ので、ここには来ない。
 * - 地図タイルは別オリジンなので触らない。オフラインでは基図「なし」で見ることになる。
 *
 * 版は登録時のクエリ（sw.js?v=<ビルド ID>）で受け取る。デプロイごとにスクリプトの URL が
 * 変わるのでブラウザが更新として扱い、古い版のキャッシュは activate で消す。
 */
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev'
const CACHE = `mygravitymap-${VERSION}`

self.addEventListener('install', (event) => {
  // 入口の HTML と、そこから読まれるファイルを先に取っておく。
  // 解析用の Worker は JS の中から URL で読まれるので、JS の本文からも拾う
  // （拾っておかないと、一度もファイルを読まずにオフラインになったとき解析できない）。
  //
  // skipWaiting はしない。新しい版をすぐ有効にすると古い版のキャッシュが消え、
  // デプロイ前から開いていたタブが古い Worker を読めなくなる。
  // 新しい版は、古い版のタブがすべて閉じてから有効になる。
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      const res = await fetch('./', { cache: 'no-store' })
      if (!res.ok) return
      const html = await res.clone().text()
      await cache.put('./', res)
      const urls = new Set(
        [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
          .map((m) => m[1])
          .filter((u) => !/^(?:[a-z]+:)?\/\//i.test(u)),
      )
      for (const u of [...urls]) {
        if (!u.endsWith('.js')) continue
        const js = await fetch(u).then((r) => (r.ok ? r.text() : ''), () => '')
        for (const m of js.matchAll(/assets\/[\w.-]+\.js/g)) urls.add(new URL(m[0], self.registration.scope).href)
      }
      await Promise.all([...urls].map((u) => cache.add(u).catch(() => undefined)))
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('mygravitymap-') && key !== CACHE) await caches.delete(key)
      }
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // ページ本体は常にネットワークを先に見る。キャッシュ優先にすると、
  // デプロイしても古い画面が出続ける（利用者には直し方が分からない）。
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put('./', copy))
          return res
        })
        .catch(async () => (await caches.match('./')) || Response.error()),
    )
    return
  }

  // assets/ 以下はファイル名にハッシュが入っていて中身が変わらないので、キャッシュ優先でよい
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(req, copy))
          }
          return res
        }),
    ),
  )
})
