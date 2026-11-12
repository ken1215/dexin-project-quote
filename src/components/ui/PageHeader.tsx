import type { ReactNode } from 'react'

/**
 * 德新 CIS 的頁面語彙：編號 ＋ 英文小標 ／ 中文大標（Noto Serif TC 900）。
 * 編號跟著導覽順序走（01 報價單、02 開單、03 單價、04 指數、05 人員、06 議價）。
 *
 * meta：緊貼在標題右側的小標籤（單號、狀態），長標題換行時跟著標題走。
 * description：標題下一行的說明小字。
 * actions：靠右的按鈕群。
 *
 * 頁面大標是全頁唯一的 h1（頁首的系統名稱不是標題）。
 */
export default function PageHeader(
  { index, eyebrow, title, meta, description, actions }:
  {
    index?: string
    eyebrow?: string
    title: string
    meta?: ReactNode
    description?: ReactNode
    actions?: ReactNode
  },
) {
  return (
    <div className="mb-5 flex flex-wrap items-end gap-3">
      <div className="min-w-0 space-y-1">
        {eyebrow && (
          <div className="font-brand text-[0.6875rem] font-medium tracking-[0.24em] text-ink-500">
            {index ? `${index} — ` : ''}{eyebrow}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <h1 className="min-w-0 break-words font-serif text-[1.25rem] font-black tracking-[0.04em] text-ink-900 sm:text-[1.5rem]">
            {title}
          </h1>
          {meta && <div className="flex flex-wrap items-center gap-2">{meta}</div>}
        </div>
        {description && <p className="text-[0.8125rem] text-ink-500">{description}</p>}
      </div>
      {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
