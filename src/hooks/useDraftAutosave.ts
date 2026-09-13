import { useEffect, useMemo, useRef, useState } from 'react'
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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 讀一次暫存。刻意只綁 key，不跟著 draft 跑——跟著 draft 跑的話，
  // 去抖寫回的內容下一輪就被自己讀回來，還原提示永遠關不掉。
  // 這裡在 render 當下算出來，不寫成 useEffect + setState：
  // oxlint 的 react(set-state-in-effect) 會擋（本 repo 基準 23 warnings 不得劣化），
  // 而且 effect 裡 setState 會白白多跑一輪 render。
  const saved = useMemo(() => {
    if (!enabled || !userId) return null
    try { return decodeDraft(localStorage.getItem(key)) } catch { return null }
  }, [key, enabled, userId])

  // 「這個 key 的暫存已經處理掉了」只記 key、不複製資料，
  // setState 一律由事件觸發（套用／捨棄／存檔成功），不由 effect 觸發。
  const [handledKey, setHandledKey] = useState<string | null>(null)
  const restored = handledKey === key ? null : saved

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
    setHandledKey(key)
  }

  return {
    restored,
    applyRestored: () => { const d = restored?.draft; setHandledKey(key); return d },
    discardRestored: clear,
    clear,
  }
}
