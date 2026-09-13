import type { ReactNode } from 'react'

export type AlertKind = 'error' | 'warn' | 'success' | 'info'

/** 全站訊息樣式的唯一出處。改版前這四種在各頁各刻一遍，樣式相近但寫法都不同。 */
const STYLE: Record<AlertKind, string> = {
  error: 'border-warn/40 bg-warn-bg text-warn',
  warn: 'border-alert/40 bg-warn-bg text-alert',
  success: 'border-green/40 bg-green/5 text-green',
  info: 'border-ink-200 bg-ink-50 text-ink-500',
}

export default function Alert(
  { kind = 'info', title, children }:
  { kind?: AlertKind; title?: string; children: ReactNode },
) {
  return (
    <div
      className={`rounded-md border px-4 py-2.5 text-sm ${STYLE[kind]}`}
      role={kind === 'error' ? 'alert' : undefined}
    >
      {title && <div className="mb-1 font-semibold">{title}</div>}
      {children}
    </div>
  )
}
