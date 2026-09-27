/**
 * IndexedDB の settings ストアに保存される useState。
 * 基図や重力マップの設定を、次に開いたときも同じにしておくために使う。
 *
 * 読み込みは非同期なので、最初の描画は既定値で行い、読めたら差し替える。
 * 読み込みが済むまでは書き込まない（既定値で保存済みの値を上書きしないように）。
 * IndexedDB が使えない環境（プライベートブラウズなど）では、ただの useState として動く。
 */
import { useEffect, useState } from 'react'
import { getSetting, setSetting } from './db'

export function usePersistentState<T>(
  key: string,
  initial: T,
  /** 保存値の検証。形が変わった古い値を捨てて既定値に戻すために使う */
  isValid: (v: unknown) => v is T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(initial)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    getSetting<unknown>(key, undefined)
      .then((v) => {
        if (alive && v !== undefined && isValid(v)) setValue(v)
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setLoaded(true)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key ごとに一度だけ読む
  }, [key])

  useEffect(() => {
    if (loaded) void setSetting(key, value).catch(() => undefined)
  }, [key, value, loaded])

  return [value, setValue]
}
