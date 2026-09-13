import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { calcTotals, money } from '../lib/calc'
import { matchesTab, sortQuotes } from '../lib/quoteFilters'
import type { QuoteTab, SortKey } from '../lib/quoteFilters'
import Alert from '../components/ui/Alert'
import ConfirmPanel from '../components/ui/ConfirmPanel'
import EmptyState from '../components/ui/EmptyState'
import PageHeader from '../components/ui/PageHeader'
import StatusTag from '../components/ui/StatusTag'
import type { DraftLine, DraftSection, Quote, QuoteLine, Role } from '../types'

/** 一次載回的張數上限。伺服器端分頁列為後續，載到上限就在清單底部誠實提示。 */
const LOAD_LIMIT = 200
/** 批次刪除一次最多送出的張數，超過請分批 */
const BATCH_DELETE_LIMIT = 100
/** 確認面板最多列出幾個單號 */
const CONFIRM_LIST_LIMIT = 10

/**
 * 分頁 tabs 取代改版前的狀態下拉。歸屬定義在 src/lib/quoteFilters.ts，
 * 與 header 的「待我處理」徽章共用同一份，不要在這裡另算一套。
 */
const TABS: { key: QuoteTab; label: string }[] = [
  { key: 'todo', label: '待我處理' },
  { key: 'active', label: '進行中' },
  { key: 'done', label: '已核定' },
  { key: 'all', label: '全部' },
]

/** 清單列＝單據本體 ＋ 算好的合計金額（quoteFilters 的純函式吃的就是這個形狀） */
type Row = Quote & { total: number }

interface SortState { key: SortKey; dir: 'asc' | 'desc' }

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

/**
 * 可排序的表頭。點同一欄切換升降冪，目前的排序欄位在標題後面掛 ▲／▼。
 * 觸控裝置補到 40px：手機以下 thead 整個隱藏，所以這條實際只對平板生效。
 */
function SortTh(
  { label, column, sort, onSort, className = '' }:
  {
    label: string
    column: SortKey
    sort: SortState
    onSort: (key: SortKey) => void
    className?: string
  },
) {
  const on = sort.key === column
  return (
    <th
      className={`th ${className}`}
      aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        className="inline-flex items-center gap-1 text-xs font-semibold text-ink-700 transition hover:text-deep pointer-coarse:min-h-10"
        onClick={() => onSort(column)}
      >
        {label}
        <span className={on ? 'text-deep' : 'text-ink-200'}>
          {on && sort.dir === 'asc' ? '▲' : '▼'}
        </span>
      </button>
    </th>
  )
}

export default function QuoteListPage() {
  const { profile, isManager, isAdmin, isProcurement } = useAuth()

  const [quotes, setQuotes] = useState<Quote[]>([])
  const [totals, setTotals] = useState<Record<string, number>>({})
  const [creators, setCreators] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** 刪除成功後 +1，觸發清單重新載入 */
  const [reloadTick, setReloadTick] = useState(0)

  /**
   * 使用者點過的分頁。null＝還沒點過，此時由 defaultTab 在 render 當下推導；
   * 刻意不寫成 useEffect + setState——oxlint 的 react(set-state-in-effect) 會擋
   * （本 repo 基準 23 warnings 不得劣化），而且會白白多跑一輪 render。
   */
  const [tabChoice, setTabChoice] = useState<QuoteTab | null>(null)
  const [keyword, setKeyword] = useState('')
  const [sort, setSort] = useState<SortState>({ key: 'quote_date', dir: 'desc' })

  /** 刪除相關：進行中、成功訊息、部分未刪除的提醒、失敗訊息 */
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [opWarn, setOpWarn] = useState<string | null>(null)
  const [opError, setOpError] = useState<string | null>(null)

  /** 頁內確認面板（本專案不用 window.confirm 這類阻塞式對話框） */
  const [confirmOne, setConfirmOne] = useState<Row | null>(null)
  const [confirmBatch, setConfirmBatch] = useState(false)

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
        .limit(LOAD_LIMIT)

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

  const role: Role = profile?.role ?? 'staff'
  const userId = profile?.id ?? ''

  const rows = useMemo<Row[]>(
    () => quotes.map((q) => ({ ...q, total: totals[q.id] ?? 0 })),
    [quotes, totals],
  )

  /** 關鍵字先篩掉，分頁上的張數才會跟著關鍵字走（顯示幾張、點進去就是幾張） */
  const byKeyword = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return rows
    return rows.filter(
      (r) => r.project.toLowerCase().includes(kw) || r.quote_no.toLowerCase().includes(kw),
    )
  }, [rows, keyword])

  const counts = useMemo(() => {
    const out: Record<QuoteTab, number> = { todo: 0, active: 0, done: 0, all: 0 }
    for (const r of byKeyword) {
      for (const t of TABS) if (matchesTab(r, t.key, role, userId)) out[t.key]++
    }
    return out
  }, [byKeyword, role, userId])

  /**
   * 預設分頁：一律從「待我處理」開始，載完之後若一張都沒有就落到「進行中」——
   * 不要讓人一進來就看到空畫面。醫院採購沒有待辦定義，直接給「全部」。
   */
  const defaultTab: QuoteTab = isProcurement
    ? 'all'
    : (loading || counts.todo > 0 ? 'todo' : 'active')
  const tab = tabChoice ?? defaultTab

  const visible = useMemo(
    () => sortQuotes(
      byKeyword.filter((r) => matchesTab(r, tab, role, userId)),
      sort.key,
      sort.dir,
    ),
    [byKeyword, tab, role, userId, sort],
  )

  /**
   * 刪除按鈕的顯示條件，刻意與資料庫 RLS 政策同一套判斷：
   * 刪單不可逆，只有副部長可刪任何一張（處長有簽核與單價庫權限但不含刪單）；
   * 同仁只能刪自己建立、且仍是草稿的單。
   */
  function canDelete(q: Quote): boolean {
    if (isAdmin) return true
    return !!profile && q.created_by === profile.id && q.status === 'draft'
  }

  /** 只認「目前篩選後看得見」的勾選，避免刪到被篩選條件藏起來的單 */
  const selectedQuotes = useMemo(
    () => visible.filter((q) => selected.has(q.id)),
    [visible, selected],
  )
  const allVisibleSelected = visible.length > 0 && visible.every((q) => selected.has(q.id))
  const nonDraftSelected = selectedQuotes.filter((q) => q.status !== 'draft').length
  /** 勾選欄與建立人欄只給主管看；確認面板橫跨整列時要算進去 */
  const colCount = isManager ? 9 : 7

  function resetMessages() {
    setNotice(null)
    setOpWarn(null)
    setOpError(null)
  }

  /** 點同一欄切換升降冪；換欄一律從大到小（新的單、貴的單先看） */
  function toggleSort(key: SortKey) {
    setSort((prev) => (
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'desc' }
    ))
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
      for (const q of visible) {
        if (checked) next.add(q.id)
        else next.delete(q.id)
      }
      return next
    })
  }

  function openConfirmOne(q: Row) {
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
      <PageHeader
        index="01"
        eyebrow="QUOTATIONS"
        title="報價單"
        actions={<Link to="/quote/new" className="btn btn-primary">＋ 開新單</Link>}
      />

      <div className="card space-y-3">
        {/* 分頁取代狀態下拉；每顆右側是該分頁在目前關鍵字下的張數 */}
        <div className="flex flex-wrap gap-2">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`chip ${tab === t.key ? 'chip-on' : ''}`}
              aria-pressed={tab === t.key}
              onClick={() => setTabChoice(t.key)}
            >
              {t.label}
              <span className="num ml-1.5 text-[0.6875rem] opacity-75">{counts[t.key]}</span>
            </button>
          ))}
        </div>

        <div className="w-full sm:max-w-md">
          <label className="label" htmlFor="quote-keyword">關鍵字（案名或單號）</label>
          <input
            id="quote-keyword"
            className="field"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="輸入案名或單號搜尋…"
          />
        </div>

        {error && <Alert kind="error" title="載入失敗">{error}</Alert>}
        {opError && <Alert kind="error">{opError}</Alert>}
        {opWarn && <Alert kind="warn">{opWarn}</Alert>}
        {notice && <Alert kind="success">{notice}</Alert>}

        {loading ? (
          <div className="py-10 text-center text-sm text-ink-500">載入中…</div>
        ) : quotes.length === 0 ? (
          <EmptyState
            title="還沒有任何報價單"
            hint="建立第一張報價單開始使用。"
            action={<Link to="/quote/new" className="btn btn-primary">＋ 開新單</Link>}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            title="這個條件下沒有單"
            hint="換一個分頁，或把關鍵字清掉再看一次。"
            action={(
              <button
                type="button"
                className="btn"
                onClick={() => { setTabChoice('all'); setKeyword('') }}
              >
                清除篩選
              </button>
            )}
          />
        ) : (
          <>
            {/* 批次刪除自成一列、緊鄰勾選欄；主 CTA 已移到 PageHeader，兩者不再並排。
                手機把表格轉成卡片後 <thead> 會被隱藏，連帶失去表頭的全選框，
                這裡補一個只在手機出現的全選控制，行為與表頭那顆完全相同。 */}
            {isManager && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-[0.8125rem] text-ink-700 sm:hidden">
                    <input
                      type="checkbox"
                      aria-label="全選目前篩選後的報價單"
                      checked={allVisibleSelected}
                      disabled={busy}
                      onChange={(e) => toggleAllVisible(e.target.checked)}
                    />
                    全選目前篩選的 {visible.length} 張
                  </label>
                  {isAdmin && selectedQuotes.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={busy}
                      onClick={openConfirmBatch}
                    >
                      刪除選取的 {selectedQuotes.length} 張
                    </button>
                  )}
                </div>

                {/* 確認面板就放在觸發它的按鈕正下方，不再擺到頁首讓人回頭找 */}
                {confirmBatch && (
                  <ConfirmPanel
                    tone="danger"
                    title={`確認刪除選取的 ${selectedQuotes.length} 張報價單`}
                    confirmLabel={`確認刪除 ${selectedQuotes.length} 張`}
                    busy={busy}
                    onConfirm={() => void deleteSelected()}
                    onCancel={() => setConfirmBatch(false)}
                  >
                    <p className="break-words">
                      將刪除下列單號：
                      <span className="num break-words font-semibold text-ink-900">
                        {confirmNoList.join('、')}
                      </span>
                      {confirmNoRest > 0 && (
                        <span className="text-ink-500">…等 {selectedQuotes.length} 張</span>
                      )}
                    </p>
                    <p className="mt-2 font-semibold text-warn">
                      將一併刪除這些單的所有明細與議價紀錄，且無法復原。
                    </p>
                    {nonDraftSelected > 0 && (
                      <p className="mt-2 text-alert">
                        其中 {nonDraftSelected} 張不是草稿狀態，已送審／核可／議價過，刪除後將失去該筆往來紀錄。
                        若只是不再進行，建議保留存查。
                      </p>
                    )}
                  </ConfirmPanel>
                )}
              </div>
            )}

            <div className="table-scroll">
              <table className="rwd-table w-full border-collapse">
                <thead>
                  <tr>
                    {isManager && (
                      <th className="th w-8">
                        <input
                          type="checkbox"
                          aria-label="全選目前篩選後的報價單"
                          checked={allVisibleSelected}
                          disabled={busy}
                          onChange={(e) => toggleAllVisible(e.target.checked)}
                        />
                      </th>
                    )}
                    <SortTh label="單號" column="quote_no" sort={sort} onSort={toggleSort} />
                    <th className="th">案名</th>
                    <th className="th">申請單位</th>
                    {isManager && <th className="th">建立人</th>}
                    <SortTh label="日期" column="quote_date" sort={sort} onSort={toggleSort} />
                    <th className="th">狀態</th>
                    <SortTh
                      label="合計金額" column="total" sort={sort} onSort={toggleSort} className="num"
                    />
                    <th className="th">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((q) => (
                    <Fragment key={q.id}>
                      <tr>
                        {isManager && (
                          /* 勾選格不給 data-label：手機卡片上用內嵌文字說明即可 */
                          <td className="td text-center">
                            <label className="inline-flex items-center gap-2">
                              <input
                                type="checkbox"
                                aria-label={`選取 ${q.quote_no}`}
                                checked={selected.has(q.id)}
                                disabled={busy}
                                onChange={(e) => toggleOne(q.id, e.target.checked)}
                              />
                              <span className="text-[0.6875rem] text-ink-500 sm:hidden">選取此單</span>
                            </label>
                          </td>
                        )}
                        <td className="td" data-label="單號">
                          <span className="min-w-0 break-words">{q.quote_no}</span>
                        </td>
                        <td className="td" data-label="案名">
                          <span className="min-w-0 break-words">{q.project}</span>
                        </td>
                        <td className="td" data-label="申請單位">
                          <span className="min-w-0 break-words">{q.dept}</span>
                        </td>
                        {isManager && (
                          <td className="td" data-label="建立人">
                            <span className="min-w-0 break-words">{creators[q.created_by] || '—'}</span>
                          </td>
                        )}
                        <td className="td" data-label="日期">{q.quote_date}</td>
                        <td className="td" data-label="狀態">
                          <StatusTag status={q.status} l1Skipped={q.l1_skipped} />
                        </td>
                        <td className="td num" data-label="合計金額">{money(q.total)}</td>
                        {/* 操作格不給 data-label：手機會自動佔滿整行，按鈕改 2 欄排列比較好按 */}
                        <td className="td">
                          <div className="grid w-full grid-cols-2 gap-1.5 sm:flex sm:w-auto sm:flex-wrap">
                            <Link to={`/quote/${q.id}`} className="btn">編輯</Link>
                            <a href={`#/print/${q.id}`} target="_blank" rel="noopener noreferrer" className="btn">列印</a>
                            {/* 議價頁是 adminOnly，處長看得到卻進不去只會撞拒絕畫面 */}
                            {isAdmin && (
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

                      {/* 單筆確認也貼著它的刪除鈕：橫跨整列插在該列正下方 */}
                      {confirmOne?.id === q.id && (
                        <tr>
                          <td className="td" colSpan={colCount}>
                            {/* 這張表在 .table-scroll 裡，面板外層要 min-w-0 才不會把表格撐寬 */}
                            <div className="w-full min-w-0">
                              <ConfirmPanel
                                tone="danger"
                                title="確認刪除報價單"
                                confirmLabel="確認刪除"
                                busy={busy}
                                onConfirm={() => void deleteOne(q)}
                                onCancel={() => setConfirmOne(null)}
                              >
                                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                                  <dt className="text-ink-500">單號</dt>
                                  <dd className="min-w-0 break-words font-semibold text-ink-900">
                                    {q.quote_no}
                                  </dd>
                                  <dt className="text-ink-500">案名</dt>
                                  <dd className="min-w-0 break-words text-ink-900">{q.project}</dd>
                                  <dt className="text-ink-500">狀態</dt>
                                  <dd className="min-w-0">
                                    <StatusTag status={q.status} l1Skipped={q.l1_skipped} />
                                  </dd>
                                  <dt className="text-ink-500">合計金額</dt>
                                  <dd className="num font-semibold text-deep">{money(q.total)}</dd>
                                </dl>
                                <p className="mt-3 font-semibold text-warn">
                                  將一併刪除此單的所有明細與議價紀錄，且無法復原。
                                </p>
                                {q.status !== 'draft' && (
                                  <p className="mt-2 text-alert">
                                    此單已送審／核可／議價過，刪除後將失去該筆往來紀錄。若只是不再進行，建議保留存查。
                                  </p>
                                )}
                              </ConfirmPanel>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* 200 張是伺服器一次載回的上限，不是「總共只有這些」。誠實講在清單底部，
            免得有人搜不到舊單以為單不見了。 */}
        {!loading && quotes.length >= LOAD_LIMIT && (
          <p className="text-[0.6875rem] text-ink-500">
            已載入最新 {LOAD_LIMIT} 張；更舊的單目前搜尋不到（伺服器端分頁待後續處理）。
          </p>
        )}
      </div>
    </div>
  )
}
