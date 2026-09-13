import type { ReactNode } from 'react'

/**
 * 二次確認。改版前每頁各自把確認卡片插在不同位置（有的在頁首、有的在頁尾），
 * 使用者得先找到它。統一成同一個元件、由呼叫端放在觸發按鈕的正下方。
 */
export default function ConfirmPanel(
  { tone = 'normal', title, children, confirmLabel, onConfirm, onCancel, busy = false }:
  {
    tone?: 'danger' | 'normal'
    title: string
    children?: ReactNode
    confirmLabel: string
    onConfirm: () => void
    onCancel: () => void
    busy?: boolean
  },
) {
  const border = tone === 'danger' ? 'border-warn/40 bg-warn-bg' : 'border-ink-200 bg-ink-50'
  return (
    <div className={`rounded-md border px-4 py-3 ${border}`}>
      <div className={`mb-1 font-semibold ${tone === 'danger' ? 'text-warn' : 'text-ink-900'}`}>
        {title}
      </div>
      {children && <div className="mb-2 text-sm text-ink-700">{children}</div>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={`btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`}
          disabled={busy}
          onClick={onConfirm}
        >{busy ? '處理中…' : confirmLabel}</button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>取消</button>
      </div>
    </div>
  )
}
