import type { QuoteStatus } from '../../types'
import { STATUS_LABEL } from '../../types'

/** 內部用色票（沿用改版前 QuoteListPage 的對照表，不要自己重配） */
const TAG_CLASS: Record<QuoteStatus, string> = {
  draft: 'bg-ink-200 text-ink-700',
  submitted: 'bg-alert/15 text-alert',
  approved_l1: 'bg-alert/25 text-alert',
  approved: 'bg-green/15 text-green',
  negotiating: 'bg-bright/15 text-bright',
  closed: 'bg-deep/15 text-deep',
  rejected: 'bg-warn-bg text-warn',
}

/**
 * 對外用語：醫院採購不該看到我方內部流程狀態。
 * 這份對照表與 VISIBLE_STATUS 是同一條界線，改動前先想清楚會露出什麼。
 */
const CLIENT_LABEL: Partial<Record<QuoteStatus, string>> = {
  approved: '已收到報價',
  negotiating: '議價中',
  closed: '已定案',
}

export default function StatusTag(
  { status, l1Skipped = false, variant = 'internal' }:
  { status: QuoteStatus; l1Skipped?: boolean; variant?: 'internal' | 'client' },
) {
  if (variant === 'client') {
    const label = CLIENT_LABEL[status] ?? '處理中'
    const cls = CLIENT_LABEL[status] ? TAG_CLASS[status] : 'bg-ink-200 text-ink-700'
    // 對外一律不顯示越級核定——那是我方內部的簽核細節
    return <span className={`tag ${cls}`}>{label}</span>
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className={`tag ${TAG_CLASS[status]}`}>{STATUS_LABEL[status]}</span>
      {/* 改版前只寫「越級」兩字、說明藏在 title 裡，觸控裝置完全看不到 */}
      {l1Skipped && <span className="tag bg-alert/15 text-alert">越級核定（未經工務處長）</span>}
    </span>
  )
}
