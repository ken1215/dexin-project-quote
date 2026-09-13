import type { ReactNode } from 'react'

export default function EmptyState(
  { title, hint, action }: { title: string; hint?: string; action?: ReactNode },
) {
  return (
    <div className="rounded-lg border border-dashed border-ink-200 bg-ink-50 px-6 py-10 text-center">
      <div className="text-ink-700">{title}</div>
      {hint && <div className="mt-1 text-sm text-ink-500">{hint}</div>}
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  )
}
