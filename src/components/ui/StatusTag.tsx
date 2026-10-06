import type { QuoteStatus } from '../../types'
import { STATUS_LABEL } from '../../types'

/** 內部用色票（沿用改版前 QuoteListPage 的對照表，不要自己重配） */
const TAG_CLASS: Record<QuoteStatus, string> = {
  draft: 'bg-ink-200 text-ink-700',
  submitted: 'bg-alert/15 text-alert',
  approved_l1: 'bg-alert/25 text-alert',
  approved: 'bg-green/15 text-green',
  negotiating: 'bg-bright/15 text-bright',   // 舊單顯示用（議價中已退出流程）
  closed: 'bg-deep/15 text-deep',
  rejected: 'bg-warn-bg text-warn',
}

export default function StatusTag(
  { status, l1Skipped = false }: { status: QuoteStatus; l1Skipped?: boolean },
) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className={`tag ${TAG_CLASS[status]}`}>{STATUS_LABEL[status]}</span>
      {/* 改版前只寫「越級」兩字、說明藏在 title 裡，觸控裝置完全看不到 */}
      {l1Skipped && <span className="tag bg-alert/15 text-alert">越級核定（未經工務處長）</span>}
    </span>
  )
}
