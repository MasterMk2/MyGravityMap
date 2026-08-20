import { useCallback, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'

export function FileDrop() {
  const { status, phase, progress, error, loadFile, reset } = useAppStore()
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
          Google マップのタイムライン（<code>location-history.json</code>）を
          ここにドロップするか、下のボタンから選んでください。
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

        <p className="filedrop__privacy">
          ファイルはこの端末のブラウザ内だけで処理されます。どこにも送信しません。
          Wi-Fi の MAC アドレスを含む <code>rawSignals</code> は読み飛ばして保存しません。
        </p>
      </div>
    </div>
  )
}
