import type { ReactNode } from 'react'

/**
 * 德新 CIS 的頁面語彙：編號 ＋ 英文小標 ／ 中文大標。
 * 編號跟著導覽順序走（01 報價單、02 開單、03 單價、04 指數、05 人員、06 議價）；
 * 醫院採購端只有一頁，不編號。
 */
export default function PageHeader(
  { index, eyebrow, title, actions }:
  { index?: string; eyebrow: string; title: string; actions?: ReactNode },
) {
  return (
    <div className="mb-4 flex flex-wrap items-end gap-3 border-b border-ink-200 pb-3">
      <div className="min-w-0">
        <div className="text-[0.6875rem] tracking-[0.18em] text-ink-500">
          {index ? `${index} — ` : ''}{eyebrow}
        </div>
        <h2 className="truncate text-[1.25rem] font-semibold text-ink-900">{title}</h2>
      </div>
      {actions && <div className="ml-auto flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}
