import type { ReactNode } from 'react'

export default function Stat(
  { label, value, hint }: { label: string; value: ReactNode; hint?: string },
) {
  return (
    <div className="stat">
      <div className="text-xs text-ink-500">{label}</div>
      <div className="num text-[1.125rem] font-semibold text-deep">{value}</div>
      {hint && <div className="text-[0.6875rem] text-ink-500">{hint}</div>}
    </div>
  )
}
