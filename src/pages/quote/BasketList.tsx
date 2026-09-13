import { lineAmount, money } from '../../lib/calc'
import type { Totals } from '../../lib/calc'
import { CN } from '../../hooks/useQuoteDraft'
import type { DraftLine, DraftSection, LaborRate, PriceItem } from '../../types'

/**
 * ③ 細項工料的「明細籃」——**卡片式**，不是表格。
 *
 * 為什麼另開一支而不是沿用 LineTable：LineTable 是 `min-w-[860px]` 的寬表格，
 * 塞進 340px 側欄後品名被斷成三行、整張表橫捲，數量／單價／複價欄整組看不到——
 * 同仁在這一步既看不到加了多少錢也改不了數量，而那正是這一步唯一要做的事。
 * 根因不是格子太窄，是把一張為 860px 設計的表塞進窄欄；加寬側欄治標，換版型才治本。
 *
 * **LineTable 不動**：⑤ 確認送出與 QuoteReview 仍用它（那裡有整頁寬度，表格是對的選擇）。
 *
 * 版面紅線：
 * - **本檔不得出現任何 overflow-x 容器**。窄欄靠折行處理長字串，不靠橫捲。
 * - 品名一律完整顯示：`break-words` ＋ 最多兩行 `line-clamp-2` ＋ `title` 帶完整字串，
 *   不 truncate（truncate 會把「FDC140VNAT-W 三相 380V」截成看不出是哪一台）。
 * - 每一層 flex 子項都要 `min-w-0`，少一層就會被長品名撐開、整頁橫捲（實測踩過多次）。
 * - 數量輸入與刪除鈕的點擊目標高度 ≧ 2.5rem（同仁年紀較長，手機上要好按）。
 *
 * 與規格的兩處偏離（規格 04-basket-and-tasks-10-12.md A 節的卡片示意圖要修）：
 * 1. 卡片多一列「備註／理由」輸入。示意圖沒畫，但 ⑤ 的 LineTable 是 readOnly，
 *    這裡不給就全站都沒地方填備註，而臨時項目的「理由」是 validateQuote 的必填欄位。
 * 2. 臨時項目（`is_custom`）的品名／單位／單價要可改——示意圖只畫了標準品項的唯讀單價。
 *    標準品項的單價仍然唯讀（由單價庫控管）。
 *
 * 工資列只在單價旁**顯示**時段名，不提供時段下拉——那是 ④ 的事
 * （所以本元件刻意不收 `laborRates` 與 `onChangeLineRate`）。
 */
interface BasketListProps {
  sections: DraftSection[]
  totals: Totals
  itemById: Map<string, PriceItem>
  rateById: Map<string, LaborRate>
  onPatchSection: (sk: string, patch: Partial<DraftSection>) => void
  onPatchLine: (sk: string, lk: string, patch: Partial<DraftLine>) => void
  onRemoveLine: (sk: string, lk: string) => void
  onRemoveSection: (sk: string) => void
  onAddCustomLine: (sk: string) => void
  /** 只剩一個大項時停用「刪除大項」 */
  canRemoveSection: boolean
}

export default function BasketList({
  sections, totals, itemById, rateById,
  onPatchSection, onPatchLine, onRemoveLine, onRemoveSection, onAddCustomLine,
  canRemoveSection,
}: BasketListProps) {
  return (
    <div className="min-w-0 space-y-3">
      {sections.map((sec, si) => (
        <div className="card min-w-0 border-l-4 border-l-deep p-3" key={sec.key}>
          {/* ── 組標題：可編輯的大項名稱（沿用 patchSection）────────────
              不換行：input 有 min-w-0 可以一路縮，兩側的字與鈕 shrink-0 保住 */}
          <div className="mb-2 flex min-w-0 items-center gap-2 border-b border-ink-200 pb-2">
            <span className="shrink-0 text-[0.9375rem] font-semibold text-deep">
              {CN[si] || si + 1}、
            </span>
            <input
              className="field min-w-0 flex-1"
              value={sec.title}
              placeholder="工程大項名稱"
              onChange={(e) => onPatchSection(sec.key, { title: e.target.value })}
            />
            <button
              type="button"
              className="btn btn-danger min-h-10 shrink-0 px-2 text-[0.75rem]"
              disabled={!canRemoveSection}
              title="刪除整個大項（連同底下的明細）"
              onClick={() => onRemoveSection(sec.key)}
            >刪除大項</button>
          </div>

          {/* ── 明細：一列一張卡 ──────────────────────────────── */}
          <ul className="min-w-0 space-y-2">
            {sec.lines.map((l) => {
              const src = l.item_id ? itemById.get(l.item_id) : undefined
              const isLabor = !l.is_custom
                && ((src?.cost_type === 'labor' && src.unit === '工') || l.labor_rate_id !== null)
              const rate = l.labor_rate_id ? rateById.get(l.labor_rate_id) : undefined
              // 規格與單位併成一行小字；規格空白時只剩單位，不留一個孤零零的「·」
              const meta = [l.spec.trim(), l.unit.trim()].filter(Boolean).join(' · ')
              return (
                <li
                  key={l.key}
                  className={
                    'min-w-0 rounded-md border border-ink-200 p-2 '
                    + (l.is_custom ? 'bg-warn-bg' : 'bg-white')
                  }
                >
                  {/* 第一行：品名（完整顯示）＋ 刪除這一列 */}
                  <div className="flex min-w-0 items-start gap-2">
                    <div className="min-w-0 flex-1">
                      {l.is_custom ? (
                        <input
                          className="field min-h-10 w-full"
                          value={l.name}
                          placeholder="臨時項目品名"
                          onChange={(e) => onPatchLine(sec.key, l.key, { name: e.target.value })}
                        />
                      ) : (
                        <div
                          className="line-clamp-2 break-words text-[0.8125rem] leading-snug text-ink-900"
                          title={l.name}
                        >{l.name}</div>
                      )}
                      {l.is_custom ? (
                        <input
                          className="field mt-1 min-h-10 w-full text-[0.75rem]"
                          value={l.unit}
                          placeholder="單位（例：式／台／m²）"
                          onChange={(e) => onPatchLine(sec.key, l.key, { unit: e.target.value })}
                        />
                      ) : (
                        meta && (
                          <div
                            className="mt-0.5 break-words text-[0.6875rem] leading-snug text-ink-500"
                            title={meta}
                          >{meta}</div>
                        )
                      )}
                    </div>
                    <button
                      type="button"
                      className="btn btn-danger min-h-10 min-w-10 shrink-0 px-2"
                      title="刪除這一列"
                      aria-label={`刪除 ${l.name || '這一列'}`}
                      onClick={() => onRemoveLine(sec.key, l.key)}
                    >×</button>
                  </div>

                  {/* 第二行：數量 × 單價 …… 複價
                      複價 ml-auto 靠右加粗——這一行就是同仁要看的「加了多少錢」 */}
                  <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <input
                      className="field num min-h-10 w-20 shrink-0"
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="any"
                      value={l.qty}
                      aria-label="數量"
                      onChange={(e) => onPatchLine(sec.key, l.key, { qty: Number(e.target.value) })}
                    />
                    <span className="shrink-0 text-[0.75rem] text-ink-500">×</span>
                    {l.is_custom ? (
                      <input
                        className="field num min-h-10 w-24 shrink-0"
                        type="number"
                        inputMode="decimal"
                        min={0}
                        value={l.unit_price}
                        aria-label="單價"
                        onChange={(e) =>
                          onPatchLine(sec.key, l.key, { unit_price: Number(e.target.value) })}
                      />
                    ) : (
                      <span
                        className="num shrink-0 text-[0.8125rem] text-ink-700"
                        title="標準品項單價由單價庫控管，不可修改"
                      >{money(l.unit_price)}</span>
                    )}
                    {/* 工資列：只標時段名，時段要改在 ④ */}
                    {isLabor && (
                      <span className="tag shrink-0" title="工資時段在第 4 步「工資試算」調整">
                        {rate ? rate.name : '未選時段'}
                      </span>
                    )}
                    <span className="num ml-auto shrink-0 text-[0.875rem] font-semibold text-ink-900">
                      {money(lineAmount(l.unit_price, l.qty))}
                    </span>
                  </div>

                  {/* 第三行：備註（標準品項）／理由（臨時項目必填） */}
                  <input
                    className="field mt-1.5 min-h-10 text-[0.75rem]"
                    value={l.is_custom ? l.reason : l.note}
                    placeholder={l.is_custom ? '為何需臨時項目（必填）' : '備註（選填）'}
                    aria-label={l.is_custom ? '臨時項目理由' : '備註'}
                    onChange={(e) =>
                      onPatchLine(sec.key, l.key,
                        l.is_custom ? { reason: e.target.value } : { note: e.target.value })}
                  />
                </li>
              )
            })}
            {sec.lines.length === 0 && (
              <li className="rounded-md border border-dashed border-ink-200 px-3 py-4 text-center text-[0.75rem] text-ink-500">
                尚無項目，請由左邊「選擇工料項目」加入。
              </li>
            )}
          </ul>

          {/* ── 組尾：本大項小計 ──────────────────────────────── */}
          <div className="mt-2 flex min-w-0 items-center justify-between gap-2 border-t border-ink-200 pt-2">
            <button
              type="button"
              className="btn btn-danger min-h-10 shrink-0 px-2 text-[0.75rem]"
              onClick={() => onAddCustomLine(sec.key)}
            >＋ 臨時項目</button>
            <span className="num min-w-0 text-[0.875rem] font-semibold text-deep">
              小計 {money(totals.sections[si]?.subtotal ?? 0)}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}
