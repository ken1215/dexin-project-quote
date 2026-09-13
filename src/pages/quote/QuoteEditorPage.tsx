import { Fragment, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import StatusTag from '../../components/ui/StatusTag'
import { useRefData } from '../../context/RefDataContext'
import { money } from '../../lib/calc'
import { DEPT_OPTIONS, useQuoteDraft } from '../../hooks/useQuoteDraft'
import type { UseQuoteDraft } from '../../hooks/useQuoteDraft'
import type { LaborRate, PriceItem } from '../../types'
import LineTable from './LineTable'
import QuoteReview from './QuoteReview'
import TotalsCard from './TotalsCard'

/**
 * 報價單頁的分派點：同一條路由，兩種身分看到兩種畫面。
 *
 * 不能編輯的單（送審中、已核定、議價中、已定案，或輪到主管簽核）一律走審閱版面。
 * 改版前這些狀態是留在同一個編輯畫面把輸入框 disabled 掉，主管看到的是一片灰欄位。
 */
export default function QuoteEditorPage() {
  const { id } = useParams()
  const q = useQuoteDraft(id)
  if (q.loading) return <div className="p-10 text-center text-ink-500">載入中…</div>
  if (q.locked || q.canReview) return <QuoteReview q={q} />
  return <QuoteEditor q={q} />
}

/** 開單／改單畫面。三步精靈（QuoteWizard）是下一個 task，這裡先維持原本的單頁版面。 */
function QuoteEditor({ q }: { q: UseQuoteDraft }) {
  const {
    categories, items, laborRates, laborBase, laborDiscount, mgmtFeeRate, taxRate,
    loading: refLoading, error: refError,
  } = useRefData()

  /* ── 品項挑選（純畫面狀態，不屬於單據內容） ─────────────── */
  const [cat, setCat] = useState<string>('all')
  const [kw, setKw] = useState('')

  /* ── 參考資料索引 ───────────────────────────────────────── */
  const itemById = useMemo(
    () => new Map<string, PriceItem>(items.map((i) => [i.id, i])),
    [items],
  )
  const rateById = useMemo(
    () => new Map<string, LaborRate>(laborRates.map((r) => [r.id, r])),
    [laborRates],
  )

  const visibleItems = useMemo(() => {
    const kwd = kw.trim().toLowerCase()
    return items.filter((i) => {
      if (!i.active) return false
      if (cat !== 'all' && i.category_id !== cat) return false
      if (!kwd) return true
      return `${i.name} ${i.spec}`.toLowerCase().includes(kwd)
    })
  }, [items, cat, kw])

  /* ── 畫面 ───────────────────────────────────────────────── */
  if (refLoading) {
    return <div className="p-10 text-center text-ink-500">載入中…</div>
  }

  return (
    <div className="space-y-4">
      {/* 訊息區 */}
      {(q.err || refError) && (
        <div className="rounded-md border border-warn/40 bg-warn-bg px-4 py-2.5 text-sm text-warn">
          {q.err || `參考資料載入失敗：${refError}`}
        </div>
      )}
      {q.issues.length > 0 && (
        <div className="rounded-md border border-warn/40 bg-warn-bg px-4 py-2.5 text-sm text-warn">
          <div className="mb-1 font-semibold">請先修正以下問題：</div>
          <ul className="list-disc pl-5">
            {q.issues.map((m) => <li key={m}>{m}</li>)}
          </ul>
        </div>
      )}
      {q.notice && (
        <div className="rounded-md border border-green/40 bg-green/5 px-4 py-2.5 text-sm text-green">
          {q.notice}
        </div>
      )}
      {q.draft.status === 'rejected' && q.reviewNote && (
        <div className="rounded-md border border-alert/40 bg-warn-bg px-4 py-2.5 text-sm text-alert">
          退回意見：{q.reviewNote}
        </div>
      )}

      {/* 表頭 */}
      <div className="card">
        <div className="card-title flex flex-wrap items-center gap-2">
          <span>報價單表頭</span>
          {q.draft.quote_no && <span className="tag">{q.draft.quote_no}</span>}
          {/* 越級核定要在單子上看得出來，否則稽核時只剩資料庫欄位知道（StatusTag 一併顯示） */}
          <StatusTag status={q.draft.status} l1Skipped={q.l1Skipped} />
        </div>
        {/* 手機單欄、平板兩欄、桌機四欄（mobile-first 疊法，別只給 md 值） */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4">
          <div className="sm:col-span-2">
            <label className="label">工程地點／案名（必填）</label>
            <input
              className="field" value={q.draft.project}
              placeholder="例：聯新國際醫院 3F 復健科天花板修繕"
              onChange={(e) => q.patchDraft({ project: e.target.value })}
            />
          </div>
          <div>
            <label className="label">申請單位</label>
            {/* 上面選常用的、下面直接打，兩個都通。input+datalist 在已有值時會被自己的
                內容濾掉選項、換人要先清空，不直覺，所以拆成兩個控制項。 */}
            <select
              className="field" value=""
              onChange={(e) => { if (e.target.value) q.patchDraft({ dept: e.target.value }) }}
            >
              <option value="">— 從常用名單選 —</option>
              {DEPT_OPTIONS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <input
              className="field mt-1" value={q.draft.dept}
              placeholder="或直接輸入"
              onChange={(e) => q.patchDraft({ dept: e.target.value })}
            />
          </div>
          <div>
            <label className="label">工程現場聯絡窗口</label>
            <input
              className="field" value={q.draft.contact}
              onChange={(e) => q.patchDraft({ contact: e.target.value })}
            />
          </div>
          <div>
            <label className="label">報價日期</label>
            <input
              className="field" type="date" value={q.draft.quote_date}
              onChange={(e) => q.patchDraft({ quote_date: e.target.value })}
            />
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        {/* min-w-0 不能省：grid/flex 子項的 min-width 預設是 auto，會被裡面
            min-w-[860px] 的明細表撐開，.table-scroll 的 overflow 就白設了
            （LineTable 自己也包了一層 min-w-0，兩層都要留著） */}
        <div className="min-w-0 space-y-4">
          {/* 品項挑選。挑選區走亮藍系、明細區走深藍系——兩塊都是白卡片時，
              同仁常把「還在挑」當成「已經加進單子」 */}
          <div className="card border-l-4 border-l-bright bg-bright/[0.04]">
            <div className="card-title border-bright/30 text-bright">選擇工料項目</div>
            <div className="mb-2 flex flex-wrap gap-1">
              <button
                type="button"
                onClick={() => setCat('all')}
                className={`btn ${cat === 'all' ? 'btn-primary' : ''}`}
              >全部</button>
              {categories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCat(c.id)}
                  className={`btn ${cat === c.id ? 'btn-primary' : ''}`}
                >{c.name}</button>
              ))}
            </div>
            <input
              className="field mb-2"
              placeholder="搜尋品名或規格…"
              value={kw}
              onChange={(e) => setKw(e.target.value)}
            />
            {/* 挑選區是「顯示＋一顆加入鈕」，手機轉卡片（rwd-table）比橫捲好按 */}
            <div className="max-h-[60vh] overflow-auto rounded-md border border-ink-200 sm:max-h-72">
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
                  {visibleItems.map((it, ii) => (
                    <Fragment key={it.id}>
                    {/* 清單已依 sort 排好，子分類必為連續區塊——變了就插一列標題 */}
                    {it.subgroup && it.subgroup !== visibleItems[ii - 1]?.subgroup && (
                      <tr>
                        <td
                          className="border border-ink-200 bg-bright/10 px-2 py-1 text-[0.75rem] font-semibold text-bright"
                          colSpan={4}
                        >
                          {it.subgroup}
                        </td>
                      </tr>
                    )}
                    <tr
                      className={
                        'transition-colors duration-300 ' +
                        (q.justAdded?.id === it.id
                          ? 'row-added'
                          : 'hover:bg-light/40')
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
                            'btn w-full transition active:scale-[0.97] sm:w-auto ' +
                            (q.justAdded?.id === it.id
                              ? 'border-green bg-green text-white hover:border-green hover:text-white'
                              : '')
                          }
                          onClick={() => q.addItem(it)}
                        >
                          {q.justAdded?.id === it.id
                            ? `已加入${q.justAdded.qty > 1 ? ` ×${q.justAdded.qty}` : ''}`
                            : '加入'}
                        </button>
                      </td>
                    </tr>
                    </Fragment>
                  ))}
                  {visibleItems.length === 0 && (
                    <tr>
                      <td className="td text-center text-ink-500" colSpan={4}>
                        沒有符合條件的品項。
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* 明細：與審閱版面共用同一份表格元件，這裡是可編輯模式 */}
          <LineTable
            sections={q.draft.sections}
            totals={q.totals}
            readOnly={false}
            laborRates={laborRates}
            itemById={itemById}
            rateById={rateById}
            laborBase={laborBase}
            laborDiscount={laborDiscount}
            canRemoveSection={q.draft.sections.length > 1}
            onPatchSection={q.patchSection}
            onPatchLine={q.patchLine}
            onRemoveLine={q.removeLine}
            onRemoveSection={q.removeSection}
            onAddCustomLine={q.addCustomLine}
            onChangeLineRate={q.changeLineRate}
          />

          <button type="button" className="btn w-full sm:w-auto" onClick={q.addSection}>
            ＋ 新增工程大項
          </button>
        </div>

        {/* 合計與動作 */}
        <div className="space-y-4 lg:sticky lg:top-16 lg:self-start">
          <TotalsCard totals={q.totals} mgmtFeeRate={mgmtFeeRate} taxRate={taxRate} />

          {/* 手機上「儲存草稿／送核可」這兩顆已經在釘底動作列了，
              這裡一律 hidden sm:inline-flex，不要讓同一顆按鈕在一支手機上出現兩次。
              釘底列沒有的（列印預覽）才在手機顯示。
              簽核那幾顆按鈕不在這裡——輪到主管簽核的單一律走 QuoteReview。 */}
          <div className="card space-y-2">
            <div className="card-title hidden sm:block">動作</div>
            <button
              type="button" className="btn hidden w-full sm:inline-flex" disabled={q.saving}
              onClick={() => void q.onSaveDraft()}
            >{q.saving ? '儲存中…' : '儲存草稿'}</button>
            {(q.draft.status === 'draft' || q.draft.status === 'rejected') && (
              <button
                type="button" className="btn btn-primary hidden w-full sm:inline-flex" disabled={q.saving}
                onClick={() => void q.onSubmit()}
              >{q.draft.status === 'rejected' ? '修正後重新送審' : '送工務處長核可'}</button>
            )}
            <button
              type="button" className="btn w-full" disabled={q.saving}
              onClick={() => void q.onPrint()}
            >列印預覽</button>
          </div>
        </div>
      </div>

      {/* 手機專用的釘底動作列：右側「動作」卡在手機會被推到整頁最下面，
          同仁在工地捲到一半想送審得先捲到底。這裡把最主要的兩顆鈕釘在
          畫面底部（sm 以上隱藏，桌機仍只有右側那一組）。
          按鈕與右側卡片共用同一組 handler，僅版面重複、不含任何額外邏輯。 */}
      <div className="action-bar no-print sm:hidden">
        <button
          type="button" className="btn" disabled={q.saving}
          onClick={() => void q.onSaveDraft()}
        >{q.saving ? '儲存中…' : '儲存草稿'}</button>
        {(q.draft.status === 'draft' || q.draft.status === 'rejected') && (
          <button
            type="button" className="btn btn-primary" disabled={q.saving}
            onClick={() => void q.onSubmit()}
          >{q.draft.status === 'rejected' ? '重新送審' : '送核可'}</button>
        )}
      </div>
    </div>
  )
}
