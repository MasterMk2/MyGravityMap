import { useCallback, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { HowToExport, LicenseLinks, LicenseText, PrivacyNote } from './About'

export function FileDrop() {
  const { status, phase, progress, error, loadFile, loadDemo, reset } = useAppStore()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const onFiles = useCallback(
    (files: FileList | null) => {
      const file = files?.[0]
      if (file) void loadFile(file)
    },
    [loadFile],
  )

  const busy = status === 'hashing' || status === 'parsing'

  return (
    <div
      className={`filedrop ${dragging ? 'filedrop--over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        onFiles(e.dataTransfer.files)
      }}
    >
      <div className="filedrop__card">
        <h1>MyGravityMap</h1>
        <p className="filedrop__lead">
          Google マップのタイムライン履歴から、自分がどこに引き寄せられて生きてきたかを
          可視化します。<br />
          <code>location-history.json</code> をここにドロップするか、下のボタンから選んでください。
        </p>

        {!busy && (
          <>
            <button onClick={() => inputRef.current?.click()}>ファイルを選ぶ</button>
            <input
              ref={inputRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => onFiles(e.target.files)}
            />
            {/* 自分のエクスポートが無い人向け。実在の人の記録と誤解されないよう、架空であることを並べて書く */}
            <div style={{ marginTop: 14 }}>
              <button onClick={() => void loadDemo()}>デモデータで試す</button>
              <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--muted)' }}>
                架空の人物の約 7 年分。実在の人のデータではありません
              </p>
            </div>
          </>
        )}

        {busy && (
          <div className="filedrop__progress">
            <div className="bar">
              <div className="bar__fill" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <span>
              {phase}… {Math.round(progress * 100)}%
            </span>
          </div>
        )}

        {status === 'error' && (
          <div className="filedrop__error">
            <p>読み込みに失敗しました: {error}</p>
            <button onClick={reset}>やり直す</button>
          </div>
        )}

        <PrivacyNote />
        <HowToExport />
        <LicenseText />
        <LicenseLinks />
      </div>
    </div>
  )
}
