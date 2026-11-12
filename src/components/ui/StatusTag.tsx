import type { QuoteStatus } from '../../types'
import { STATUS_LABEL } from '../../types'

/**
 * 狀態色票（2026-11-12 設計稿定案；只用 index.css 既有 token，不自創色）。
 * 小字一律落在 ≧4.5:1：橘色系用深階 alert-d、綠色系字用墨黑（green 在淡綠底上偏淡）。
 * 「待處長核可」與「待副部長核定」同色——兩者都是「等主管」，差別由字面與關卡段表達。
 */
const TAG_CLASS: Record<QuoteStatus, string> = {
  draft: 'bg-ink-200/70 text-ink-700',
  submitted: 'bg-alert/15 text-alert-d',
  approved_l1: 'bg-alert/15 text-alert-d',
  approved: 'bg-green/12 text-ink-900',
  negotiating: 'bg-bright/15 text-deep',   // 舊單顯示用（議價中已退出流程）
  closed: 'bg-deep/10 text-deep-d',
  rejected: 'bg-warn-bg text-warn',
}

/**
 * 越級標記只在「已核定之後」成立。l1_skipped 欄位在越級核定後被整單退回時不會被清，
 * 會一路殘留到重跑的草稿／待處長核可／待副部長核定——那些狀態下掛「越級核定」是錯的。
 * 與 lib/approvalFlow.ts 同一條規則。
 */
const SKIP_VISIBLE: QuoteStatus[] = ['approved', 'negotiating', 'closed']

export default function StatusTag(
  { status, l1Skipped = false }: { status: QuoteStatus; l1Skipped?: boolean },
) {
  const showSkip = l1Skipped && SKIP_VISIBLE.includes(status)
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className={`tag ${TAG_CLASS[status]}`}>{STATUS_LABEL[status]}</span>
      {/* 改版前只寫「越級」兩字、說明藏在 title 裡，觸控裝置完全看不到 */}
      {showSkip && <span className="tag bg-alert/15 text-alert-d">越級核定（未經工務處長）</span>}
    </span>
  )
}
