import { Fragment, useMemo, useState } from 'react'
import EmptyState from '../../../components/ui/EmptyState'
import { money } from '../../../lib/calc'
import type { PriceItem } from '../../../types'
import LineTable from '../LineTable'
import TotalsCard from '../TotalsCard'
import type { StepItemsProps } from '../QuoteWizard'

/**
 * ③ 細項：「挑出要做的項目，填數量」。
 *
 * 版面：桌機兩欄（左品項庫 minmax(0,1fr)／右明細籃 340px `lg:sticky lg:top-16`），
 * 手機把明細籃收成底部抽屜。**外層 grid 到根節點的每一層 grid／flex 子項都要 min-w-0**——
 * 明細表是 min-w-[860px] 的寬表格，少一層 min-w-0 整頁就會被它撐開橫捲（實測踩過）。
 *
 * 品項表沿用現行 `.rwd-table` 版型與「加入」即時回饋（`justAdded`／`.row-added`／
 * 「已加入 ×N」）——那是實測有效的回饋，原樣保留，不重新設計。
 * 加入一律呼叫 `q.addItem`（由 `onAddItem` 帶進來），工程大項會依 `Category.section_title`
 * 自動長出；**這裡絕不自己建 section**（預建的空大項會被 persist 寫成「工程項目 N」並印進 A4）。
 *
 * 明細籃直接用 Task 8 抽出的 `LineTable` ＋ `TotalsCard`（契約 `StepTableProps` 原封餵進去），
 * 不在步驟裡另刻一份表格。
 *
 * 「上一步／下一步：算工資」與停用原因**不在這裡**：`QuoteWizard` 的 `.action-bar` 已統一提供
 * （`done[2]` ＝ 有明細且每列 qty > 0、品名非空，走 `dbGuard` 的寬口徑，不是 `validateQuote`
 * ——零元品項只有送審才擋，這裡擋會讓人連草稿都存不了）。
 * 精靈的紅線是「手機釘底那組與桌機那組不得出現同一顆按鈕」，步驟裡再放一顆就重複了。
 *
 * 所有畫面狀態（頁籤／關鍵字／抽屜開合）都留在本元件，**不進 DraftQuote**——
 * encodeDraft 會把 draft 整包寫進 localStorage，畫面狀態塞進去會污染暫存。
 * 狀態一律在 render 當下推導，不在 effect 內 setState。
 */
export default function StepItems(props: StepItemsProps) {
  const {
    items, categories, justAdded, onAddItem, mgmtFeeRate, taxRate, ...table
  } = props

  /* ── 畫面狀態（純 UI，不屬於單據內容） ───────────────────── */
  const [cat, setCat] = useState<string>('all')
  const [kw, setKw] = useState('')
  /** 手機底部抽屜是否展開；桌機不看這個值（右欄一律顯示） */
  const [open, setOpen] = useState(false)

  // 在 ② 取消勾選後，頁籤可能還指著一個已經不在清單裡的大類。
  // 在 render 當下折回「全部」，不要用 effect 去 setState（會新增 set-state-in-effect 警告）。
  const activeCat = categories.some((c) => c.id === cat) ? cat : 'all'
  // 只勾一個大類時頁籤沒有意義，整列不出現（少一個要看的東西）
  const showTabs = categories.length > 1
  const nameOfCat = (id: string): string => categories.find((c) => c.id === id)?.name ?? ''

  /* ── 品項庫：容器已篩過「已勾大類 ＋ active」，這裡只再做頁籤與關鍵字 ── */
  const shown = useMemo(() => {
    const kwd = kw.trim().toLowerCase()
    return items.filter((i) => {
      if (activeCat !== 'all' && i.category_id !== activeCat) return false
      if (!kwd) return true
      return `${i.name} ${i.spec}`.toLowerCase().includes(kwd)
    })
  }, [items, activeCat, kw])

  /**
   * 依 `subgroup` 分組。清單已依 sort 排好，同大類同子分類必為連續區塊
   * （現行品項表就是靠這個前提插標題列），所以用「與前一列比對」分段即可。
   * 子分類名稱在不同大類底下可能重複（例：兩類都有「其他」），所以連大類一起比。
   */
  const groups = useMemo(() => {
    const out: { key: string; categoryId: string; label: string; rows: PriceItem[] }[] = []
    for (const it of shown) {
      const label = it.subgroup.trim()
      const last = out[out.length - 1]
      if (last && last.categoryId === it.category_id && last.label === label) {
        last.rows.push(it)
      } else {
        out.push({
          key: `${it.category_id}|${label}|${it.id}`,
          categoryId: it.category_id,
          label,
          rows: [it],
        })
      }
    }
    return out
  }, [shown])

  /**
   * 每個品項目前在單子上的數量。手機的明細籃收在抽屜裡、桌機在右欄，
   * 品項列上不寫的話，同仁按完就不知道這項到底加了幾件（「已加入 ×N」1.6 秒就消失）。
   */
  const qtyOnSheet = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of table.sections) {
      for (const l of s.lines) {
        if (l.is_custom || !l.item_id) continue
        m.set(l.item_id, (m.get(l.item_id) ?? 0) + (Number(l.qty) || 0))
      }
    }
    return m
  }, [table.sections])

  const lineCount = table.sections.reduce((a, s) => a + s.lines.length, 0)

  /* ── 明細籃（桌機右欄／手機抽屜共用同一份 DOM，不重複渲染第二份表格） ── */
  const basket = (
    <div className="min-w-0 space-y-3">
      {lineCount === 0 ? (
        <EmptyState
          title="還沒有加入任何項目"
          hint="左邊挑一項按「加入」，工程大項會自動長出來。"
        />
      ) : (
        <LineTable
          {...table}
          readOnly={false}
          canRemoveSection={table.sections.length > 1}
        />
      )}
      <TotalsCard totals={table.totals} mgmtFeeRate={mgmtFeeRate} taxRate={taxRate} />
    </div>
  )

  /* 手機／平板展開時蓋在畫面下緣（fixed ＋ max-h-[70vh]）；lg 以上還原成右欄的一般區塊。
     lg:static 會讓 inset 整組失效，不必再逐條把 bottom／inset-x 歸零。 */
  const panelCls = (open
    ? 'fixed inset-x-0 bottom-0 z-30 max-h-[70vh] overflow-y-auto border-t border-ink-200 bg-ink-50 p-3 shadow-lg'
    : 'hidden')
    + ' lg:static lg:z-auto lg:block lg:max-h-none lg:overflow-visible'
    + ' lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none'

  return (
    <div className="min-w-0 space-y-4">
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* ── 左：品項庫 ─────────────────────────────────────
            挑選區走亮藍系、明細區走深藍系——兩塊都是白卡片時，
            同仁常把「還在挑」當成「已經加進單子」。 */}
        <div className="min-w-0">
          <div className="card min-w-0 border-l-4 border-l-bright bg-bright/[0.04]">
            <div className="card-title border-bright/30 text-bright">
              選擇工料項目
              <span className="ml-2 text-[0.75rem] font-normal text-ink-500">
                只列出上一步勾選的大類
              </span>
            </div>

            {showTabs && (
              <div className="mb-2 flex flex-wrap gap-1">
                <button
                  type="button"
                  onClick={() => setCat('all')}
                  className={`btn ${activeCat === 'all' ? 'btn-primary' : ''}`}
                >全部</button>
                {categories.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setCat(c.id)}
                    className={`btn ${activeCat === c.id ? 'btn-primary' : ''}`}
                  >{c.name}</button>
                ))}
              </div>
            )}

            <input
              className="field mb-2"
              placeholder="搜尋品名或規格…"
              value={kw}
              onChange={(e) => setKw(e.target.value)}
            />

            {items.length === 0 ? (
              <EmptyState
                title="這些大類底下沒有可挑的品項"
                hint="回上一步換一個大類，或用明細籃裡的「＋ 臨時項目」。"
              />
            ) : (
              <>
                {/* 挑選區是「顯示＋一顆加入鈕」，手機轉卡片（rwd-table）比橫捲好按 */}
                <div className="max-h-[60vh] min-w-0 overflow-auto rounded-md border border-ink-200 sm:max-h-[32rem]">
                  <table className="rwd-table w-full border-collapse">
                    {/* sticky 下在每個 th（見 index.css 的 .th-sticky），不是 thead——
                        collapse 表格對 thead 的背景繪製各家瀏覽器不一致 */}
                    <thead>
                      <tr>
                        <th className="th th-sticky text-left">品名／規格</th>
                        <th className="th th-sticky w-16">單位</th>
                        <th className="th th-sticky w-24">標準單價</th>
                        <th className="th th-sticky w-20">加入</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groups.map((g) => (
                        <Fragment key={g.key}>
                          <tr>
                            <td
                              className="border border-ink-200 bg-bright/10 px-2 py-1 text-[0.75rem] font-semibold text-bright"
                              colSpan={4}
                            >
                              {/* 「全部」頁籤下好幾個大類混在一起，子分類前面要掛大類才分得出來 */}
                              {activeCat === 'all' && showTabs
                                ? (
                                    <>
                                      <span className="text-ink-500">{nameOfCat(g.categoryId)}</span>
                                      {g.label && <span>{` · ${g.label}`}</span>}
                                    </>
                                  )
                                : (g.label || nameOfCat(g.categoryId))}
                            </td>
                          </tr>
                          {g.rows.map((it) => {
                            const onSheet = qtyOnSheet.get(it.id) ?? 0
                            return (
                              <tr
                                key={it.id}
                                className={
                                  'transition-colors duration-300 '
                                  + (justAdded?.id === it.id ? 'row-added' : 'hover:bg-light/40')
                                }
                              >
                                <td className="td">
                                  {/* 卡片模式下 td 會變成 flex，內容要包一層才會維持原本的直向堆疊 */}
                                  <div className="min-w-0">
                                    <span className="break-words text-ink-900">{it.name}</span>
                                    {it.needs_area && (
                                      <span className="ml-1.5 rounded bg-alert/10 px-1.5 py-0.5 text-[0.6875rem] text-alert">
                                        待轉 m²
                                      </span>
                                    )}
                                    {onSheet > 0 && (
                                      <span className="ml-1.5 rounded bg-green/10 px-1.5 py-0.5 text-[0.6875rem] text-green">
                                        單上 {onSheet} {it.unit}
                                      </span>
                                    )}
                                    {it.spec && (
                                      <div className="break-words text-[0.6875rem] text-ink-500">{it.spec}</div>
                                    )}
                                  </div>
                                </td>
                                <td className="td text-center" data-label="單位">{it.unit}</td>
                                <td className="td num" data-label="標準單價">{money(it.std_price)}</td>
                                <td className="td text-center">
                                  {/* 按下後就地變成「已加入 ×N」——同時回答「有沒有進去」
                                      與「我剛剛按了幾次」。1.6 秒後復原。
                                      active:scale 給按壓的觸感，手機上尤其明顯。 */}
                                  <button
                                    type="button"
                                    aria-live="polite"
                                    className={
                                      'btn w-full transition active:scale-[0.97] sm:w-auto '
                                      + (justAdded?.id === it.id
                                        ? 'border-green bg-green text-white hover:border-green hover:text-white'
                                        : '')
                                    }
                                    onClick={() => onAddItem(it)}
                                  >
                                    {justAdded?.id === it.id
                                      ? `已加入${justAdded.qty > 1 ? ` ×${justAdded.qty}` : ''}`
                                      : '加入'}
                                  </button>
                                </td>
                              </tr>
                            )
                          })}
                        </Fragment>
                      ))}
                      {shown.length === 0 && (
                        <tr>
                          <td className="td text-center text-ink-500" colSpan={4}>
                            沒有符合條件的品項。
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="mt-1 text-[0.75rem] text-ink-500">
                  {shown.length} 項可選；加入後在右邊（手機在下方「展開明細」）改數量。
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── 右：明細籃 ─────────────────────────────────────
            桌機是 340px 的釘住側欄；手機這一格是空的（抽屜走 fixed，不佔格）。 */}
        <aside className="min-w-0 lg:sticky lg:top-16 lg:self-start">
          <div className={panelCls}>
            <div className="mb-2 flex items-center justify-between gap-2 lg:hidden">
              <span className="text-[0.9375rem] font-semibold text-deep">
                明細 {lineCount} 項
              </span>
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                收合
              </button>
            </div>
            {basket}
          </div>
        </aside>
      </div>

      {/* 手機／平板收合時的摘要列；展開時整條讓給抽屜（抽屜自己有「收合」）。
          inline style 的 bottom：<640px 時 .action-bar 是 sticky bottom-0，而精靈自己那條
          上一步／下一步也釘在 0，兩條會疊在一起（同為 z-10，後畫的精靈那條會蓋掉這條）。
          往上讓開一個動作列的高度（py-2 ＋ pointer:coarse 的 min-h-10 ＋ 安全區）。
          640px 以上 .action-bar 轉 static，bottom 自動失效，不必再加斷點。
          刻意不調高 z-index：真要重疊時，寧可蓋住這條摘要，也不能蓋住「下一步」。 */}
      {!open && (
        <div
          className="action-bar no-print lg:hidden"
          style={{ bottom: 'calc(3.5rem + env(safe-area-inset-bottom))' }}
        >
          <span className="flex min-w-0 items-center text-sm text-ink-700">
            明細 {lineCount} 項 · 合計 {money(table.totals.total)} 元
          </span>
          <button type="button" className="btn" onClick={() => setOpen(true)}>
            展開明細
          </button>
        </div>
      )}
    </div>
  )
}
