import { useEffect, useRef, useState } from 'react'
import type { DraftQuote } from '../types'
import { decodeDraft, draftKey, encodeDraft } from '../lib/draftStorage'

/**
 * 開單改成分步之後更怕重整——步驟愈多，一次重整損失愈大。
 * 掛載時讀一次暫存交給呼叫端決定要不要套用；之後每次 draft 變動就寫回（500ms 去抖）。
 * 存檔成功由呼叫端呼叫 clear()。
 *
 * localStorage 在無痕視窗／關閉站台資料時可能整個拋錯，所有存取都包 try/catch，
 * 失敗就當作沒有暫存功能，不能讓開單本身跟著壞掉。
 */
export function useDraftAutosave(
  { userId, quoteId, draft, enabled }:
  { userId: string; quoteId?: string; draft: DraftQuote; enabled: boolean },
) {
  const key = draftKey(userId, quoteId)
  const [restored, setRestored] = useState<{ savedAt: number; draft: DraftQuote } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 掛載時讀一次。刻意只在 key 變動時跑，不跟著 draft 跑。
  useEffect(() => {
    if (!enabled || !userId) return
    try { setRestored(decodeDraft(localStorage.getItem(key))) } catch { setRestored(null) }
  }, [key, enabled, userId])

  useEffect(() => {
    if (!enabled || !userId) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      try { localStorage.setItem(key, encodeDraft(draft, Date.now())) } catch { /* 存不了就算了 */ }
    }, 500)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [key, draft, enabled, userId])

  const clear = () => {
    try { localStorage.removeItem(key) } catch { /* 同上 */ }
    setRestored(null)
  }

  return {
    restored,
    applyRestored: () => { const d = restored?.draft; setRestored(null); return d },
    discardRestored: clear,
    clear,
  }
}
