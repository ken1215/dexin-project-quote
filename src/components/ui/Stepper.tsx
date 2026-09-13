/**
 * 分步流程的步驟列（五步精靈用）。
 *
 * 可點規則：**往回任意跳；往前只能到「第一個未完成步」**。
 * 跳到一個還填不出東西的步驟，同仁只會以為系統壞了，所以更後面的段一律停用，
 * 而且要「看得出來不能點」——灰字 ＋ cursor-not-allowed ＋ title 說明原因，
 * 不是只把顏色調淡。
 *
 * 配色：已完成段 bg-sprout、目前段 bg-deep、未到段 bg-ink-200（色塊，不是文字）。
 * 新芽綠對白底只有 1.98:1，一律不得當文字色，所以文字走墨階。
 *
 * 手機（<640px）：五段等寬色塊 ＋ 步驟名縮寫（取前兩字）；桌機才顯示「N. 完整步驟名」。
 * 這些差異全部用 Tailwind 的 sm: utility 在元件裡處理，
 * 元件樣式（.step-seg…）留在 index.css 的 @layer components 內、不落進任何 @media
 * （scripts/check-css.mjs 的紅線：落進 @media 的元件樣式會對其他裝置整條失效）。
 */
export interface StepperProps {
  /** 五步的完整名稱（手機自動取前兩字當縮寫） */
  steps: string[]
  /** 目前步驟的索引，0 起算（網址上的 step 是 1 起算，由呼叫端換算） */
  current: number
  /** 點擊某一段；參數同樣是 0 起算的索引 */
  onJump: (i: number) => void
  /** 每一步的完成判定，長度與 steps 相同 */
  done: boolean[]
}

/** 手機只放得下兩個字：「位置與使用者」→「位置」 */
const abbr = (s: string): string => (s.length <= 2 ? s : s.slice(0, 2))

export default function Stepper({ steps, current, onJump, done }: StepperProps) {
  // 第一個未完成步＝往前跳得到的最遠處；全部完成時整列都能點。
  const firstOpen = done.findIndex((d) => !d)
  const reach = Math.max(current, firstOpen < 0 ? steps.length - 1 : firstOpen)

  return (
    <nav className="no-print" aria-label="開單步驟">
      <ol className="flex gap-1 sm:gap-2">
        {steps.map((label, i) => {
          const enabled = i <= reach
          const tone = i === current
            ? 'bg-deep'
            : (done[i] ? 'bg-sprout' : 'bg-ink-200')
          return (
            <li key={label} className="min-w-0 flex-1">
              <button
                type="button"
                className={`step-seg ${enabled ? '' : 'step-seg-off'}`}
                disabled={!enabled}
                title={enabled ? undefined : '請先完成前面的步驟'}
                aria-current={i === current ? 'step' : undefined}
                onClick={() => onJump(i)}
              >
                <span className={`step-seg-bar ${tone}`} />
                <span
                  className={
                    'step-seg-label '
                    + (i === current ? 'font-semibold text-deep' : '')
                  }
                >
                  <span className="sm:hidden">{i + 1} {abbr(label)}</span>
                  <span className="hidden sm:inline">{i + 1}. {label}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
