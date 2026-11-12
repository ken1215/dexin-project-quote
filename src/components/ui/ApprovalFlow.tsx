import { compactLine, formatStamp, visibleSteps } from '../../lib/approvalFlow'
import type { Flow, FlowStep } from '../../lib/approvalFlow'

/**
 * 簽核關卡列：送審 → 處長核可 → 副部長核定 → 定案。
 *
 * 只負責畫。關卡狀態怎麼推導、戳記採不採用，全部在 lib/approvalFlow.ts（有自我檢查）；
 * 這裡不查資料、不推導權限。
 *
 * 視覺依 2026-11-12 定案的設計稿：
 *   · 每關「圖示＋文字」雙重標示，不只靠顏色
 *   · 越級＝橘色虛線圓「越」、退回＝紅底「退」——都不是打勾，不會被看成已完成
 *   · 已完成關卡之間的連接線用新芽綠（sprout）。那是純裝飾線，**不得**拿 sprout 當字色
 *     （白底對比只有 1.98:1）
 *   · 桌機四關橫排、手機直排時間軸，用 sm: utility 切換，不寫 @media
 *
 * names：簽核人 id → 姓名。查得到顯示「職稱 姓名」，查不到只顯示職稱
 * （同仁端受 profiles RLS 限制查不到主管姓名，屬預期）。
 */

/** 畫面上的五種樣子：流程狀態再加上「被副部長退回重審的目前關卡」也畫成退回 */
type Look = 'done' | 'current' | 'todo' | 'skipped' | 'back'

const lookOf = (st: FlowStep): Look =>
  st.state === 'rejected' || (st.state === 'current' && st.returned) ? 'back' : st.state

const DOT: Record<Look, string> = {
  done: 'bg-green text-white',
  current: 'bg-deep text-white ring-4 ring-light',
  todo: 'border-[1.5px] border-ink-200 bg-white text-ink-500',
  skipped: 'border-[1.5px] border-dashed border-alert bg-white text-alert-d',
  back: 'bg-warn text-white',
}
const SEG: Record<Look, string> = {
  done: 'bg-green',
  current: 'bg-deep',
  todo: 'bg-ink-200',
  skipped: 'border-[1.5px] border-dashed border-alert bg-white',
  back: 'bg-warn',
}
const TITLE: Record<Look, string> = {
  done: 'text-ink-900', current: 'text-deep', todo: 'text-ink-500',
  skipped: 'text-ink-900', back: 'text-ink-900',
}
const CAPTION: Record<Look, string> = {
  done: 'text-ink-500', current: 'text-ink-500', todo: 'text-ink-500',
  skipped: 'text-alert-d', back: 'text-warn',
}
/** 給螢幕報讀器的狀態說明（圓點裡的 ✓／越／退 是 aria-hidden 的視覺符號） */
const SR: Record<Look, string> = {
  done: '已完成', current: '目前關卡', todo: '尚未進行', skipped: '越級，未經此關', back: '已退回',
}
const mark = (look: Look, n: number): string =>
  look === 'done' ? '✓' : look === 'skipped' ? '越' : look === 'back' ? '退' : String(n)

/**
 * 這一關連到下一關的線。手機是垂直線、桌機是水平線。
 * 越級之後那段是橘色虛線（用 border 畫，背景色畫不出虛線）。
 */
function Connector({ look, last }: { look: Look; last: boolean }) {
  const base = 'my-1 min-h-4.5 flex-1 sm:mx-1.5 sm:my-0 sm:min-h-0'
  if (last) return <span aria-hidden="true" className={`${base} hidden sm:block`} />
  if (look === 'skipped') {
    return (
      <span
        aria-hidden="true"
        className={`${base} w-0 border-l-2 border-dashed border-alert/50 sm:h-0 sm:w-auto sm:border-t-2 sm:border-l-0`}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      className={`${base} w-0.5 sm:h-0.5 sm:w-auto ${look === 'done' ? 'bg-sprout' : 'bg-ink-200'}`}
    />
  )
}

export default function ApprovalFlow(
  { flow, names = {}, variant = 'full', className = '' }:
  { flow: Flow; names?: Record<string, string>; variant?: 'full' | 'compact'; className?: string },
) {
  /* ── 精簡版：清單「狀態」欄，放在 StatusTag 正下方 ─────────── */
  const steps = visibleSteps(flow)
  if (variant === 'compact') {
    const line = compactLine(flow, names)
    const tone = line?.tone === 'warn' ? 'text-warn' : line?.tone === 'skipped' ? 'text-alert-d' : 'text-ink-500'
    return (
      // 清單桌機表格與手機卡片都靠左（手機已改成專屬卡片版面，不再是 rwd-table 的左右對開）
      <span
        role="group"
        aria-label={`簽核流程：${flow.summary}`}
        className={`inline-flex flex-col items-start gap-1 ${className}`}
      >
        <span aria-hidden="true" className="flex gap-[3px]">
          {steps.map((st) => (
            <span key={st.key} className={`h-1.5 w-6 rounded-full sm:w-5.5 ${SEG[lookOf(st)]}`} />
          ))}
        </span>
        {line && <span className={`text-[0.6875rem] leading-tight ${tone}`}>{line.text}</span>}
      </span>
    )
  }

  /* ── 完整版：審閱頁／精靈頁／議價頁 ────────────────────────── */
  return (
    <section className={`card space-y-4 ${className}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-xs text-ink-500">簽核流程</span>
        <span className="inline-flex flex-wrap items-center gap-2 text-[0.8125rem] text-ink-700 sm:text-right">
          {flow.summary}
          {flow.legacy && <span className="tag">舊制</span>}
        </span>
      </div>

      <ol aria-label="簽核流程" className={'sm:grid ' + (steps.length === 4 ? 'sm:grid-cols-4' : 'sm:grid-cols-3')}>
        {steps.map((st, i) => {
          const look = lookOf(st)
          const name = st.byId ? names[st.byId] : undefined
          const when = formatStamp(st.at)
          return (
            <li
              key={st.key}
              aria-current={st.state === 'current' ? 'step' : undefined}
              className="flex min-w-0 gap-3 sm:flex-col sm:gap-2"
            >
              <div className="flex flex-col items-center sm:flex-row">
                <span
                  aria-hidden="true"
                  className={`inline-flex h-6.5 w-6.5 flex-none items-center justify-center rounded-full text-xs font-bold ${DOT[look]}`}
                >
                  {mark(look, i + 1)}
                </span>
                <Connector look={look} last={i === steps.length - 1} />
              </div>
              <div className="flex min-w-0 flex-col gap-0.5 pb-3.5 sm:pr-2 sm:pb-0">
                <span className={`text-[0.8125rem] font-bold ${TITLE[look]}`}>
                  {st.title}
                  <span className="sr-only">（{SR[look]}）</span>
                </span>
                <span className="break-words text-xs text-ink-700">
                  {name ? `${st.actor} ${name}` : st.actor}
                </span>
                {(st.caption || when) && (
                  <span className={`text-xs ${CAPTION[look]}`}>
                    {st.caption}
                    {when && <span className="ml-1 font-num tabular-nums">{when}</span>}
                  </span>
                )}
              </div>
            </li>
          )
        })}
      </ol>

      {/* 退回理由併在這裡：審閱頁與精靈頁原本各有一個獨立的 Alert，同一段理由不出現兩次 */}
      {flow.note && (
        <div className="space-y-1 border-t border-ink-200 pt-3">
          <div className="flex flex-wrap items-baseline gap-x-2.5">
            <span className="text-[0.8125rem] font-bold text-warn">{flow.note.title}</span>
            {flow.note.at && (
              <span className="font-num tabular-nums text-xs text-ink-500">{formatStamp(flow.note.at)}</span>
            )}
          </div>
          <p className="whitespace-pre-wrap break-words text-[0.8125rem] leading-relaxed text-ink-900">
            {flow.note.text}
          </p>
        </div>
      )}
    </section>
  )
}
