import type { DraftQuote } from '../types'

/**
 * 暫存 key。一定要同時綁使用者與單據：
 * 共用電腦上換人登入、或同一人開不同單，草稿都不能互相蓋。
 */
export function draftKey(userId: string, quoteId?: string): string {
  return `dexin-quote-draft:${userId}:${quoteId ?? 'new'}`
}

export function encodeDraft(draft: DraftQuote, now: number): string {
  return JSON.stringify({ savedAt: now, draft })
}

/** 壞掉的暫存一律當作沒有——寧可少還原一次，也不要讓畫面炸在使用者面前 */
export function decodeDraft(raw: string | null): { savedAt: number; draft: DraftQuote } | null {
  if (!raw) return null
  try {
    const o: unknown = JSON.parse(raw)
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null
    const { savedAt, draft } = o as { savedAt?: unknown; draft?: unknown }
    if (typeof savedAt !== 'number') return null
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return null
    if (!Array.isArray((draft as DraftQuote).sections)) return null
    return { savedAt, draft: draft as DraftQuote }
  } catch {
    return null
  }
}
