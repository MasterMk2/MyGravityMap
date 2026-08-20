/**
 * 同梱している第三者ソフトウェアの一覧と、その許諾条項の全文を集めて
 * THIRD-PARTY-NOTICES.md を生成する。
 *
 *   npm run notices
 *
 * MIT や BSD は「著作権表示と許諾条項の全文を添付すること」を条件にしているため、
 * 種類名だけでは足りない。各パッケージが同梱している LICENSE 本文をそのまま埋め込む。
 * 依存を足したり上げたりしたら再生成すること。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const LICENSE_FILE_RE = /^(LICEN[CS]E|COPYING|NOTICE)(\..*)?$/i

function readTree() {
  const json = execFileSync('npm', ['ls', '--prod', '--all', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  })
  return JSON.parse(json)
}

function collect(node, out = new Map()) {
  for (const [name, dep] of Object.entries(node.dependencies ?? {})) {
    const key = `${name}@${dep.version ?? '?'}`
    if (!out.has(key)) {
      out.set(key, { name, version: dep.version ?? '?' })
      collect(dep, out)
    }
  }
  return out
}

function pkgDir(name) {
  return join('node_modules', ...name.split('/'))
}

function licenseText(name) {
  const dir = pkgDir(name)
  let files
  try {
    files = readdirSync(dir)
  } catch {
    return null
  }
  const hits = files.filter((f) => LICENSE_FILE_RE.test(f)).sort()
  if (hits.length === 0) return null
  return hits
    .map((f) => {
      try {
        return `--- ${f} ---\n${readFileSync(join(dir, f), 'utf8').trim()}`
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .join('\n\n')
}

function licenseId(pkg) {
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license?.type) return pkg.license.type
  if (Array.isArray(pkg.licenses) && pkg.licenses[0]?.type) return pkg.licenses[0].type
  return '(同梱の本文を参照)'
}

function authorOf(pkg) {
  const a = pkg.author
  if (!a) return ''
  return typeof a === 'string' ? a : [a.name, a.email && `<${a.email}>`].filter(Boolean).join(' ')
}

const packages = [...collect(readTree()).values()].sort((a, b) => a.name.localeCompare(b.name))

const entries = packages.map((p) => {
  let meta = {}
  try {
    meta = JSON.parse(readFileSync(join(pkgDir(p.name), 'package.json'), 'utf8'))
  } catch {
    /* 読めないものは名前とバージョンだけ載せる */
  }
  return {
    ...p,
    license: licenseId(meta),
    author: authorOf(meta),
    homepage: meta.homepage ?? (typeof meta.repository === 'string' ? meta.repository : meta.repository?.url) ?? '',
    text: licenseText(p.name),
  }
})

const byLicense = new Map()
for (const e of entries) byLicense.set(e.license, (byLicense.get(e.license) ?? 0) + 1)

const lines = []
lines.push('# 第三者ソフトウェアの許諾条項 / Third-Party Notices')
lines.push('')
lines.push('MyGravityMap は以下のソフトウェアを同梱しています。')
lines.push('これらには、それぞれの許諾条項が MyGravityMap のライセンスに優先して適用されます。')
lines.push('')
lines.push('このファイルは `npm run notices` で自動生成しています。手で編集しないでください。')
lines.push('')
lines.push(`対象パッケージ数: ${entries.length}`)
lines.push('')
lines.push('| 許諾条項 | 件数 |')
lines.push('|---|---|')
for (const [lic, n] of [...byLicense].sort((a, b) => b[1] - a[1])) {
  lines.push(`| ${lic} | ${n} |`)
}
lines.push('')
lines.push('## 地図データ')
lines.push('')
lines.push('地図タイルは利用者が選んだ提供元から直接取得されます。')
lines.push('')
lines.push('- 地図データ: © OpenStreetMap contributors（Open Database License）')
lines.push('- タイル配信: CARTO / OpenFreeMap / VersaTiles')
lines.push('')
lines.push('## 各パッケージ')
lines.push('')

for (const e of entries) {
  lines.push(`### ${e.name} ${e.version}`)
  lines.push('')
  lines.push(`- 許諾条項: ${e.license}`)
  if (e.author) lines.push(`- 作者: ${e.author}`)
  if (e.homepage) lines.push(`- 参照: ${e.homepage}`)
  lines.push('')
  if (e.text) {
    lines.push('```')
    lines.push(e.text)
    lines.push('```')
    lines.push('')
  }
}

writeFileSync('THIRD-PARTY-NOTICES.md', lines.join('\n'), 'utf8')
console.log(`THIRD-PARTY-NOTICES.md を生成しました（${entries.length} パッケージ）`)
