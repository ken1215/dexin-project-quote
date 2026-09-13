import { useSearchParams } from 'react-router-dom'
import Alert from '../../../components/ui/Alert'
import LineTable from '../LineTable'
import TotalsCard from '../TotalsCard'
import type { StepConfirmProps } from '../QuoteWizard'

/**
 * ⑤ 送出：「確認金額，送給處長核可」。
 *
 * 全份唯讀預覽（LineTable readOnly ＋ TotalsCard）＋ 表頭摘要 ＋ 送審前檢查清單。
 *
 * 幾條不能破的規則：
 * - 表頭摘要是**純文字**，不是 disabled input——改版前那片灰欄位看不出是「不能改」還是「壞掉」。
 * - **儲存草稿／送工務處長核可這兩顆不在這裡**：它們在 QuoteWizard 的 .action-bar 上
 *   （手機釘底、sm 以上變回一般區塊），同一顆按鈕不得在一支手機上出現兩次。
 *   StepConfirmProps 也刻意只給 onPrint，沒給 onSubmit／onSaveDraft，就是這個原因；
 *   退回單的「修正後重新送審」文案同樣由 QuoteWizard 那顆負責，persist 會先把狀態轉回
 *   draft，順序不得在這裡繞過。
 * - 「去修正」跳哪一步用精靈自己的完成判定推（見下），**不解析 issues 的中文字串**。
 */

/** 網址上的步驟編號（QuoteWizard 讀 ?step=1～5） */
const STEP_SITE = 1
const STEP_ITEMS = 3

export default function StepConfirm({
  sections, totals, laborRates, itemById, rateById, laborBase, laborDiscount,
  mgmtFeeRate, taxRate, draft, issues, l1Skipped, saving, onPrint,
}: StepConfirmProps) {
  const [, setParams] = useSearchParams()

  // QuoteWizard 的 goStep 同一套寫法：replace 不在歷史裡疊五筆，換步驟捲回頂端
  const goStep = (n: number) => {
    setParams((prev) => {
      const p = new URLSearchParams(prev)
      p.set('step', String(n))
      return p
    }, { replace: true })
    window.scrollTo({ top: 0 })
  }

  /**
   * 「去修正」的落點：沿用 QuoteWizard done[] 的同一組完成判定，
   * **不用正則去解析 issues 的中文字串**——那些訊息要與資料庫 raise 的字對齊、隨時可能改字，
   * 用字串比對接一定會鬆脫。
   *
   * validateQuote 只會產生兩類問題：① 表頭的「工程地點／案名未填」，
   * 其餘全是明細列的欄位（大項名稱、數量、品名、單價、理由），都在 ③ 的明細表上改。
   * ② 大項只是 ③ 的篩選條件、validateQuote 不會為它產生任何訊息，所以不當落點——
   * 純工資單一個標準品項都沒有，把人丟到 ② 只會看到一個沒事可做的步驟。
   */
  const siteDone = draft.project.trim() !== ''
  const fixStep = siteDone ? STEP_ITEMS : STEP_SITE
  const fixLabel = siteDone ? '去修正（第 3 步 細項工料）' : '去修正（第 1 步 位置與使用者）'

  return (
    <div className="space-y-4">
      {issues.length > 0 ? (
        <Alert kind="error" title="請先修正以下問題：">
          <ul className="list-disc space-y-1 pl-5">
            {issues.map((m) => (
              <li key={m}>
                <span className="mr-2 align-middle">{m}</span>
                <button
                  type="button"
                  className="btn px-2 py-0.5 text-xs align-middle"
                  onClick={() => goStep(fixStep)}
                >{fixLabel}</button>
              </li>
            ))}
          </ul>
        </Alert>
      ) : (
        <Alert kind="success" title="檢查通過，可以送出">
          下面的內容就是處長會看到的樣子。確認金額沒問題後，按最下方的
          「{draft.status === 'rejected' ? '修正後重新送審' : '送工務處長核可'}」。
        </Alert>
      )}

      {/* 越級核定過的單會在資料庫留痕，重送時要讓開單人知道這件事還在紀錄上 */}
      {l1Skipped && (
        <Alert kind="warn" title="本單曾越級核定">
          這張單曾由行政管理部副部長越過工務處長直接核定，系統已留痕。
        </Alert>
      )}

      {/* 表頭摘要：四格純文字。值是案名這種長字串，靠左對齊，所以只共用 .stat 卡片樣式，
          不套 ui/Stat（它的值欄是 .num、等寬數字靠右，適合金額不適合這裡）。 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="stat">
          <div className="text-xs text-ink-500">工程地點／案名</div>
          <div className="break-words text-[0.9375rem] font-semibold text-ink-900">
            {draft.project || '—'}
          </div>
        </div>
        <div className="stat">
          <div className="text-xs text-ink-500">申請單位（開單人）</div>
          <div className="break-words text-[0.9375rem] text-ink-900">{draft.dept || '—'}</div>
        </div>
        <div className="stat">
          <div className="text-xs text-ink-500">工程現場聯絡窗口</div>
          <div className="break-words text-[0.9375rem] text-ink-900">{draft.contact || '—'}</div>
        </div>
        <div className="stat">
          <div className="text-xs text-ink-500">報價日期</div>
          <div className="text-[0.9375rem] text-ink-900">{draft.quote_date || '—'}</div>
        </div>
      </div>

      {/* minmax(0,1fr)：少了它左欄會被 LineTable 裡 860px 的表格撐開，整頁跟著橫捲 */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <LineTable
          sections={sections}
          totals={totals}
          readOnly
          laborRates={laborRates}
          itemById={itemById}
          rateById={rateById}
          laborBase={laborBase}
          laborDiscount={laborDiscount}
        />

        <div className="min-w-0 space-y-4 lg:sticky lg:top-16 lg:self-start">
          <TotalsCard totals={totals} mgmtFeeRate={mgmtFeeRate} taxRate={taxRate} />

          {/* 這張卡只放「精靈動作列沒有的那一顆」。儲存草稿與送審在下方 .action-bar，
              在這裡再放一次就會在手機上出現兩顆一模一樣的按鈕（改版前踩過）。 */}
          <div className="card space-y-2 no-print">
            <div className="card-title">動作</div>
            <button
              type="button" className="btn w-full" disabled={saving}
              onClick={onPrint}
            >列印預覽</button>
            <p className="text-[0.6875rem] text-ink-500">
              列印預覽會先存檔再開新分頁。儲存草稿與送審在這一頁最下方。
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
