import { laborListPrice, lineAmount, money } from '../../lib/calc'
import type { Totals } from '../../lib/calc'
import { CN, discountLabel } from '../../hooks/useQuoteDraft'
import type { DraftLine, DraftSection, LaborRate, PriceItem } from '../../types'

/**
 * 報價明細表。開單（編輯）與簽核（審閱）共用同一份版面，差別只有 readOnly：
 * readOnly 時每一格換成**純文字**，不是把輸入框 disabled 掉——改版前主管打開單子
 * 看到的是一片灰欄位，看不出那是「不能改」還是「壞掉」。
 * 刪除鈕與「＋ 臨時項目」在 readOnly 下整個不渲染，不是停用。
 *
 * 版面上三個東西不能拿掉：外層 min-w-0、.table-scroll、表格的 min-w-[860px]。
 * grid/flex 子項的 min-width 預設是 auto，少了 min-w-0 就會被 860px 的表格撐開，
 * .table-scroll 的橫捲形同虛設，整頁跟著變寬（實測踩過）。
 */
interface LineTableProps {
  sections: DraftSection[]
  totals: Totals
  readOnly: boolean
  laborRates: LaborRate[]
  itemById: Map<string, PriceItem>
  rateById: Map<string, LaborRate>
  laborBase: number
  laborDiscount: number
  onPatchSection?: (sk: string, patch: Partial<DraftSection>) => void
  onPatchLine?: (sk: string, lk: string, patch: Partial<DraftLine>) => void
  onRemoveLine?: (sk: string, lk: string) => void
  onRemoveSection?: (sk: string) => void
  onAddCustomLine?: (sk: string) => void
  onChangeLineRate?: (sk: string, lk: string, rateId: string) => void
  /** 刪除大項在只剩一個大項時停用（編輯模式才有意義） */
  canRemoveSection?: boolean
}

export default function LineTable({
  sections, totals, readOnly,
  laborRates, itemById, rateById, laborBase, laborDiscount,
  onPatchSection, onPatchLine, onRemoveLine, onRemoveSection,
  onAddCustomLine, onChangeLineRate,
  canRemoveSection = true,
}: LineTableProps) {
  // 唯讀少一欄「刪除」，空列的 colSpan 要跟著改，否則框線會少一格
  const cols = readOnly ? 7 : 8
  return (
    <div className="min-w-0 space-y-4">
      {sections.map((sec, si) => (
        <div className="card border-l-4 border-l-deep" key={sec.key}>
          <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-ink-200 pb-2">
            <span className="text-[0.9375rem] font-semibold text-deep">
              {CN[si] || si + 1}、
            </span>
            {readOnly ? (
              <span className="text-[0.9375rem] font-semibold text-ink-900">
                {sec.title.trim() || `工程項目 ${si + 1}`}
              </span>
            ) : (
              <input
                className="field w-full sm:max-w-xs"
                value={sec.title}
                placeholder="工程大項名稱"
                onChange={(e) => onPatchSection?.(sec.key, { title: e.target.value })}
              />
            )}
            <span className="num ml-auto text-sm text-ink-700">
              小計 {money(totals.sections[si]?.subtotal ?? 0)}
            </span>
            {!readOnly && (
              <button
                type="button"
                className="btn btn-danger"
                disabled={!canRemoveSection}
                onClick={() => onRemoveSection?.(sec.key)}
              >刪除大項</button>
            )}
          </div>

          {/* 明細列在編輯時每格都是輸入框，屬密集輸入型：手機用 .table-scroll 橫捲，
              不轉卡片（轉了反而更難連續輸入數量／單價） */}
          <div className="table-scroll">
            <table className="w-full min-w-[860px] border-collapse">
              <thead>
                <tr>
                  <th className="th w-12">項次</th>
                  <th className="th text-left">工程項目及說明</th>
                  <th className="th w-16">單位</th>
                  <th className="th w-20">數量</th>
                  <th className="th w-24">單價</th>
                  <th className="th w-28">複價</th>
                  <th className="th w-48 text-left">備註／理由</th>
                  {!readOnly && <th className="th w-14">刪除</th>}
                </tr>
              </thead>
              <tbody>
                {sec.lines.map((l, li) => {
                  const src = l.item_id ? itemById.get(l.item_id) : undefined
                  const isLabor = !l.is_custom
                    && ((src?.cost_type === 'labor' && src.unit === '工') || l.labor_rate_id !== null)
                  const rate = l.labor_rate_id ? rateById.get(l.labor_rate_id) : undefined
                  return (
                    <tr key={l.key} className={l.is_custom ? 'bg-warn-bg' : undefined}>
                      <td className="td text-center">
                        {l.is_custom && <span className="mr-0.5 text-warn">★</span>}
                        {li + 1}
                      </td>
                      <td className="td">
                        {l.is_custom && !readOnly ? (
                          <input
                            className="field"
                            value={l.name}
                            placeholder="臨時項目品名"
                            onChange={(e) => onPatchLine?.(sec.key, l.key, { name: e.target.value })}
                          />
                        ) : (
                          <>
                            <div className="break-words text-ink-900">{l.name}</div>
                            {l.spec && <div className="break-words text-[0.6875rem] text-ink-500">{l.spec}</div>}
                          </>
                        )}
                        {isLabor && (
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            {readOnly ? (
                              <span className="text-[0.6875rem] text-ink-700">
                                {rate ? `${rate.name}（×${rate.multiplier}）` : '（未選時段）'}
                              </span>
                            ) : (
                              <select
                                className="field max-w-[9rem]"
                                value={l.labor_rate_id ?? ''}
                                onChange={(e) => onChangeLineRate?.(sec.key, l.key, e.target.value)}
                              >
                                <option value="">（未選時段）</option>
                                {laborRates.map((r) => (
                                  <option key={r.id} value={r.id}>
                                    {r.name}（×{r.multiplier}）
                                  </option>
                                ))}
                              </select>
                            )}
                            {rate?.legal_basis && (
                              <span className="text-[0.6875rem] text-ink-500">{rate.legal_basis}</span>
                            )}
                            <span className="text-[0.6875rem] text-ink-500">
                              牌價 {money(laborListPrice(laborBase, rate))}
                              {discountLabel(laborDiscount)
                                ? ` × 物管合約 ${discountLabel(laborDiscount)}`
                                : '（物管合約未設折扣）'}
                            </span>
                          </div>
                        )}
                      </td>
                      <td className="td text-center">
                        {l.is_custom && !readOnly ? (
                          <input
                            className="field"
                            value={l.unit}
                            onChange={(e) => onPatchLine?.(sec.key, l.key, { unit: e.target.value })}
                          />
                        ) : l.unit}
                      </td>
                      {readOnly ? (
                        <td className="td num">{l.qty}</td>
                      ) : (
                        <td className="td">
                          <input
                            className="field num"
                            type="number"
                            min={0}
                            step="any"
                            value={l.qty}
                            onChange={(e) => onPatchLine?.(sec.key, l.key, { qty: Number(e.target.value) })}
                          />
                        </td>
                      )}
                      {readOnly ? (
                        <td className="td num">{money(l.unit_price)}</td>
                      ) : (
                        <td className="td">
                          <input
                            className="field num"
                            type="number"
                            min={0}
                            value={l.unit_price}
                            readOnly={!l.is_custom}
                            title={l.is_custom ? undefined : '標準品項單價由單價庫控管，不可修改'}
                            onChange={(e) => {
                              if (!l.is_custom) return
                              onPatchLine?.(sec.key, l.key, { unit_price: Number(e.target.value) })
                            }}
                          />
                        </td>
                      )}
                      <td className="td num">{money(lineAmount(l.unit_price, l.qty))}</td>
                      {readOnly ? (
                        <td className="td">
                          <span className="break-words text-ink-700">
                            {l.is_custom ? l.reason : l.note}
                          </span>
                        </td>
                      ) : (
                        <td className="td">
                          <input
                            className="field"
                            value={l.is_custom ? l.reason : l.note}
                            placeholder={l.is_custom ? '為何需臨時項目（必填）' : '備註'}
                            onChange={(e) =>
                              onPatchLine?.(sec.key, l.key,
                                l.is_custom ? { reason: e.target.value } : { note: e.target.value })
                            }
                          />
                        </td>
                      )}
                      {!readOnly && (
                        <td className="td text-center">
                          <button
                            type="button"
                            className="btn btn-danger"
                            onClick={() => onRemoveLine?.(sec.key, l.key)}
                          >刪</button>
                        </td>
                      )}
                    </tr>
                  )
                })}
                {sec.lines.length === 0 && (
                  <tr>
                    <td className="td text-center text-ink-500" colSpan={cols}>
                      {readOnly ? '本大項沒有明細項目。' : '尚無項目，請由上方「選擇工料項目」加入。'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {!readOnly && (
            <div className="mt-2">
              <button
                type="button"
                className="btn btn-danger w-full sm:w-auto"
                onClick={() => onAddCustomLine?.(sec.key)}
              >
                ＋ 臨時項目（非標準品）
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
