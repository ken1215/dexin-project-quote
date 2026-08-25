import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { calcTotals, money } from '../lib/calc'
import type { DraftLine, DraftSection, Quote, QuoteLine, QuoteStatus } from '../types'
import { STATUS_LABEL } from '../types'

/** 不同狀態的標籤配色（沿用 .tag 形狀，覆寫底色／文字色） */
const STATUS_TAG_CLASS: Record<QuoteStatus, string> = {
  draft: 'bg-ink-200 text-ink-700',
  submitted: 'bg-alert/15 text-alert',
  approved: 'bg-green/15 text-green',
  negotiating: 'bg-bright/15 text-bright',
  closed: 'bg-deep/15 text-deep',
  rejected: 'bg-warn-bg text-warn',
}

/** 批次刪除一次最多送出的張數，超過請分批 */
const BATCH_DELETE_LIMIT = 100
/** 確認面板最多列出幾個單號 */
const CONFIRM_LIST_LIMIT = 10

/** 用共用的 calcTotals 算單一報價單的合計金額（單一虛擬大項裝入所有明細即可） */
function quoteTotal(quote: Quote, lines: QuoteLine[]): number {
  const draftLines: DraftLine[] = lines.map((l) => ({
    key: l.id,
    item_id: l.item_id,
    labor_rate_id: l.labor_rate_id,
    name: l.name,
    spec: l.spec,
    unit: l.unit,
    unit_price: l.unit_price,
    qty: l.qty,
    is_custom: l.is_custom,
    reason: l.reason,
    note: l.note,
  }))
  const sections: DraftSection[] = [{ key: 'all', title: '', lines: draftLines }]
  return calcTotals(sections, quote.mgmt_fee_rate, quote.tax_rate).total
}

export default function QuoteListPage() {
  const { profile, isManager } = useAuth()

  const [quotes, setQuotes] = useState<Quote[]>([])
  const [totals, setTotals] = useState<Record<string, number>>({})
  const [creators, setCreators] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** 刪除成功後 +1，觸發清單重新載入 */
  const [reloadTick, setReloadTick] = useState(0)

  const [statusFilter, setStatusFilter] = useState<QuoteStatus | 'all'>('all')
  const [keyword, setKeyword] = useState('')

  /** 刪除相關：進行中、成功訊息、部分未刪除的提醒、失敗訊息 */
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [opWarn, setOpWarn] = useState<string | null>(null)
  const [opError, setOpError] = useState<string | null>(null)

  /** 頁內確認面板（本專案不用 window.confirm 這類阻塞式對話框） */
  const [confirmOne, setConfirmOne] = useState<Quote | null>(null)
  const [confirmBatch, setConfirmBatch] = useState(false)
  const confirmRef = useRef<HTMLDivElement | null>(null)

  /** 批次勾選（只有主管看得到勾選欄） */
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)

      const { data: quoteRows, error: qErr } = await supabase
        .from('quotes')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200)

      if (cancelled) return
      if (qErr) {
        setError(qErr.message)
        setLoading(false)
        return
      }

      const list = (quoteRows ?? []) as Quote[]
      setQuotes(list)

      if (list.length === 0) {
        setTotals({})
        setCreators({})
        setLoading(false)
        return
      }

      const ids = list.map((q) => q.id)
      const { data: lineRows, error: lErr } = await supabase
        .from('quote_lines')
        .select('*')
        .in('quote_id', ids)

      if (cancelled) return
      if (lErr) {
        setError(lErr.message)
        setLoading(false)
        return
      }

      const linesByQuote = new Map<string, QuoteLine[]>()
      for (const l of (lineRows ?? []) as QuoteLine[]) {
        const arr = linesByQuote.get(l.quote_id)
        if (arr) arr.push(l)
        else linesByQuote.set(l.quote_id, [l])
      }
      const totalMap: Record<string, number> = {}
      for (const q of list) {
        totalMap[q.id] = quoteTotal(q, linesByQuote.get(q.id) ?? [])
      }
      setTotals(totalMap)

      if (isManager) {
        const creatorIds = [...new Set(list.map((q) => q.created_by).filter(Boolean))]
        if (creatorIds.length) {
          const { data: profileRows, error: pErr } = await supabase
            .from('profiles')
            .select('id, full_name')
            .in('id', creatorIds)
          if (cancelled) return
          if (pErr) {
            setError(pErr.message)
            setLoading(false)
            return
          }
          const map: Record<string, string> = {}
          for (const p of (profileRows ?? []) as { id: string; full_name: string }[]) {
            map[p.id] = p.full_name
          }
          setCreators(map)
        } else {
          setCreators({})
        }
      }

      setLoading(false)
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [isManager, reloadTick])

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return quotes.filter((q) => {
      if (statusFilter !== 'all' && q.status !== statusFilter) return false
      if (kw && !q.project.toLowerCase().includes(kw) && !q.quote_no.toLowerCase().includes(kw)) return false
      return true
    })
  }, [quotes, statusFilter, keyword])

  /**
   * 刪除按鈕的顯示條件，刻意與資料庫 RLS 政策同一套判斷：
   * 主管可刪任何一張；同仁只能刪自己建立、且仍是草稿的單。
   */
  function canDelete(q: Quote): boolean {
    if (isManager) return true
    return !!profile && q.created_by === profile.id && q.status === 'draft'
  }

  /** 只認「目前篩選後看得見」的勾選，避免刪到被篩選條件藏起來的單 */
  const selectedQuotes = useMemo(
    () => filtered.filter((q) => selected.has(q.id)),
    [filtered, selected],
  )
  const allVisibleSelected = filtered.length > 0 && filtered.every((q) => selected.has(q.id))
  const nonDraftSelected = selectedQuotes.filter((q) => q.status !== 'draft').length

  /** 面板出現時捲到面板，避免按了表格下方的刪除卻沒看到確認框 */
  useEffect(() => {
    if (confirmOne || confirmBatch) {
      confirmRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [confirmOne, confirmBatch])

  function resetMessages() {
    setNotice(null)
    setOpWarn(null)
    setOpError(null)
  }

  function toggleOne(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  /** 全選／取消全選：只作用於目前篩選後可見的列 */
  function toggleAllVisible(checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const q of filtered) {
        if (checked) next.add(q.id)
        else next.delete(q.id)
      }
      return next
    })
  }

  function openConfirmOne(q: Quote) {
    resetMessages()
    setConfirmBatch(false)
    setConfirmOne(q)
  }

  function openConfirmBatch() {
    resetMessages()
    if (selectedQuotes.length === 0) return
    if (selectedQuotes.length > BATCH_DELETE_LIMIT) {
      setOpError(
        `一次最多刪除 ${BATCH_DELETE_LIMIT} 張，目前選取 ${selectedQuotes.length} 張，請分批處理。`,
      )
      return
    }
    setConfirmOne(null)
    setConfirmBatch(true)
  }

  async function deleteOne(target: Quote) {
    setBusy(true)
    resetMessages()

    const { data, error: dErr } = await supabase
      .from('quotes')
      .delete()
      .eq('id', target.id)
      .select('id')

    if (dErr) {
      setOpError(`刪除失敗：${dErr.message}`)
      setBusy(false)
      return
    }

    const removed = ((data ?? []) as { id: string }[]).length
    setConfirmOne(null)
    if (removed === 0) {
      setOpWarn(`單號 ${target.quote_no} 未被刪除，可能已被他人刪除，或權限不足被資料庫政策擋下。`)
    } else {
      setNotice(`已刪除 1 張報價單（${target.quote_no}）。`)
    }
    setSelected(new Set())
    setBusy(false)
    setReloadTick((t) => t + 1)
  }

  async function deleteSelected() {
    const targets = selectedQuotes
    if (targets.length === 0) return

    setBusy(true)
    resetMessages()

    const ids = targets.map((q) => q.id)
    const { data, error: dErr } = await supabase
      .from('quotes')
      .delete()
      .in('id', ids)
      .select('id')

    if (dErr) {
      setOpError(`刪除失敗：${dErr.message}`)
      setBusy(false)
      return
    }

    const removed = ((data ?? []) as { id: string }[]).length
    setConfirmBatch(false)
    if (removed > 0) setNotice(`已刪除 ${removed} 張報價單。`)
    if (removed < targets.length) {
      setOpWarn(
        `選取 ${targets.length} 張，實際刪除 ${removed} 張，有 ${targets.length - removed} 張未被刪除` +
          '（可能已被他人刪除，或權限不足被資料庫政策擋下）。',
      )
    }
    setSelected(new Set())
    setBusy(false)
    setReloadTick((t) => t + 1)
  }

  const confirmNoList = selectedQuotes.slice(0, CONFIRM_LIST_LIMIT).map((q) => q.quote_no)
  const confirmNoRest = selectedQuotes.length - confirmNoList.length

  return (
    <div className="space-y-4">
      <div ref={confirmRef} className="empty:hidden space-y-4">
        {confirmOne && (
          <div className="card border-warn/40">
            <div className="card-title text-warn">確認刪除報價單</div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
              <dt className="text-ink-500">單號</dt>
              <dd className="font-semibold text-ink-900">{confirmOne.quote_no}</dd>
              <dt className="text-ink-500">案名</dt>
              <dd className="text-ink-900">{confirmOne.project}</dd>
              <dt className="text-ink-500">狀態</dt>
              <dd>
                <span className={`tag ${STATUS_TAG_CLASS[confirmOne.status]}`}>
                  {STATUS_LABEL[confirmOne.status]}
                </span>
              </dd>
              <dt className="text-ink-500">合計金額</dt>
              <dd className="num font-semibold text-deep">{money(totals[confirmOne.id] ?? 0)}</dd>
            </dl>
            <p className="mt-3 text-[13px] font-semibold text-warn">
              將一併刪除此單的所有明細與議價紀錄，且無法復原。
            </p>
            {confirmOne.status !== 'draft' && (
              <p className="mt-2 text-[13px] text-alert">
                此單已送審／核可／議價過，刪除後將失去該筆往來紀錄。若只是不再進行，建議保留存查。
              </p>
            )}
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => void deleteOne(confirmOne)}
              >
                {busy ? '刪除中…' : '確認刪除'}
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setConfirmOne(null)}
              >
                取消
              </button>
            </div>
          </div>
        )}

        {confirmBatch && (
          <div className="card border-warn/40">
            <div className="card-title text-warn">確認刪除選取的 {selectedQuotes.length} 張報價單</div>
            <p className="text-[13px] text-ink-700">
              將刪除下列單號：
              <span className="num font-semibold text-ink-900">{confirmNoList.join('、')}</span>
              {confirmNoRest > 0 && (
                <span className="text-ink-500">…等 {selectedQuotes.length} 張</span>
              )}
            </p>
            <p className="mt-2 text-[13px] font-semibold text-warn">
              將一併刪除這些單的所有明細與議價紀錄，且無法復原。
            </p>
            {nonDraftSelected > 0 && (
              <p className="mt-2 text-[13px] text-alert">
                其中 {nonDraftSelected} 張不是草稿狀態，已送審／核可／議價過，刪除後將失去該筆往來紀錄。
                若只是不再進行，建議保留存查。
              </p>
            )}
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => void deleteSelected()}
              >
                {busy ? '刪除中…' : `確認刪除 ${selectedQuotes.length} 張`}
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setConfirmBatch(false)}
              >
                取消
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">報價單列表</h2>

        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div>
            <label className="label">狀態</label>
            <select
              className="field w-40"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as QuoteStatus | 'all')}
            >
              <option value="all">全部</option>
              {(Object.keys(STATUS_LABEL) as QuoteStatus[]).map((s) => (
                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
              ))}
            </select>
          </div>
          <div className="flex-1 min-w-[200px]">
            <label className="label">關鍵字（案名或單號）</label>
            <input
              className="field"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="輸入案名或單號搜尋…"
            />
          </div>
          {isManager && selectedQuotes.length > 0 && (
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={openConfirmBatch}
            >
              刪除選取的 {selectedQuotes.length} 張
            </button>
          )}
          <Link to="/quote/new" className="btn btn-primary">＋ 開新單</Link>
        </div>

        {error && (
          <div className="mb-3 rounded-md border border-warn/30 bg-warn-bg px-3 py-2 text-sm text-warn">
            載入失敗：{error}
          </div>
        )}

        {opError && (
          <div className="mb-3 rounded-md border border-warn/30 bg-warn-bg px-3 py-2 text-sm text-warn">
            {opError}
          </div>
        )}

        {opWarn && (
          <div className="mb-3 rounded-md border border-alert/40 bg-warn-bg px-3 py-2 text-sm text-alert">
            {opWarn}
          </div>
        )}

        {notice && (
          <div className="mb-3 rounded-md border border-green/40 bg-green/5 px-3 py-2 text-sm text-green">
            {notice}
          </div>
        )}

        {loading ? (
          <div className="py-10 text-center text-sm text-ink-500">載入中…</div>
        ) : quotes.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-sm text-ink-500">目前還沒有任何報價單，建立第一張報價單開始使用。</p>
            <Link to="/quote/new" className="btn btn-primary">＋ 開新單</Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  {isManager && (
                    <th className="th w-8">
                      <input
                        type="checkbox"
                        aria-label="全選目前篩選後的報價單"
                        checked={allVisibleSelected}
                        disabled={busy || filtered.length === 0}
                        onChange={(e) => toggleAllVisible(e.target.checked)}
                      />
                    </th>
                  )}
                  <th className="th">單號</th>
                  <th className="th">案名</th>
                  <th className="th">申請單位</th>
                  {isManager && <th className="th">建立人</th>}
                  <th className="th">日期</th>
                  <th className="th">狀態</th>
                  <th className="th num">合計金額</th>
                  <th className="th">操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td className="td text-center text-ink-500" colSpan={isManager ? 9 : 7}>
                      無符合篩選條件的報價單。
                    </td>
                  </tr>
                ) : (
                  filtered.map((q) => (
                    <tr key={q.id}>
                      {isManager && (
                        <td className="td text-center">
                          <input
                            type="checkbox"
                            aria-label={`選取 ${q.quote_no}`}
                            checked={selected.has(q.id)}
                            disabled={busy}
                            onChange={(e) => toggleOne(q.id, e.target.checked)}
                          />
                        </td>
                      )}
                      <td className="td">{q.quote_no}</td>
                      <td className="td">{q.project}</td>
                      <td className="td">{q.dept}</td>
                      {isManager && <td className="td">{creators[q.created_by] || '—'}</td>}
                      <td className="td">{q.quote_date}</td>
                      <td className="td">
                        <span className={`tag ${STATUS_TAG_CLASS[q.status]}`}>{STATUS_LABEL[q.status]}</span>
                      </td>
                      <td className="td num">{money(totals[q.id] ?? 0)}</td>
                      <td className="td">
                        <div className="flex flex-wrap gap-1.5">
                          <Link to={`/quote/${q.id}`} className="btn">編輯</Link>
                          <a href={`#/print/${q.id}`} target="_blank" rel="noopener noreferrer" className="btn">列印</a>
                          {isManager && (
                            <Link to={`/nego/${q.id}`} className="btn">議價</Link>
                          )}
                          {canDelete(q) && (
                            <button
                              type="button"
                              className="btn btn-danger"
                              disabled={busy}
                              onClick={() => openConfirmOne(q)}
                            >
                              刪除
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
