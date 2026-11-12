import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { calcTotals, discountText, money } from '../lib/calc'
import { buildApprovalFlow } from '../lib/approvalFlow'
import { canReviewStatus, isOwnerEditable, matchesTab, sortQuotes } from '../lib/quoteFilters'
import type { QuoteTab, SortKey } from '../lib/quoteFilters'
import Alert from '../components/ui/Alert'
import ApprovalFlow from '../components/ui/ApprovalFlow'
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
  // 這一頁收的是 approved＋negotiating（舊單）＋closed。只寫「已核定」會跟狀態標籤的
  // 「已核定」（單指 approved）同字不同義，讓人以為已核定就是定案。
  { key: 'done', label: '已核定／定案' },
  { key: 'all', label: '全部' },
]

/**
 * 清單列＝單據本體 ＋ 算好的合計金額（quoteFilters 的純函式吃的就是這個形狀）。
 * orig＝定案前原報價合計（沒有 orig_price 的單等於 total），只拿來顯示折扣幅度，排序仍用 total。
 */
type Row = Quote & { total: number; orig: number }

interface SortState { key: SortKey; dir: 'asc' | 'desc' }

/**
 * 用共用的 calcTotals 算單一報價單的合計金額（單一虛擬大項裝入所有明細即可）。
 * total＝現行單價＋round_off（定案單即定案合計）；orig＝orig_price ?? unit_price 且不帶 round_off
 * （抹零是定案時給的讓利）——與列印頁／單據頁／議價頁同一口徑。
 */
function quoteTotal(quote: Quote, lines: QuoteLine[]): { total: number; orig: number } {
  const toDraft = (l: QuoteLine, unitPrice: number): DraftLine => ({
    key: l.id,
    item_id: l.item_id,
    labor_rate_id: l.labor_rate_id,
    name: l.name,
    spec: l.spec,
    unit: l.unit,
    unit_price: unitPrice,
    qty: l.qty,
    is_custom: l.is_custom,
    reason: l.reason,
    note: l.note,
  })
  const cur: DraftSection[] = [{ key: 'all', title: '', lines: lines.map((l) => toDraft(l, l.unit_price)) }]
  const orig: DraftSection[] = [{
    key: 'all', title: '',
    lines: lines.map((l) => toDraft(l, Number(l.orig_price ?? l.unit_price))),
  }]
  return {
    total: calcTotals(cur, quote.mgmt_fee_rate, quote.tax_rate, quote.round_off).total,
    orig: calcTotals(orig, quote.mgmt_fee_rate, quote.tax_rate, 0).total,
  }
}

/**
 * 可排序的表頭。點同一欄切換升降冪，目前的排序欄位在標題後面掛 ▲／▼。
 * 觸控裝置補到 40px：手機改用卡片、沒有表頭，所以這條實際只對平板生效。
 * 樣式（橫線式表頭）由呼叫端的 className 帶入，不套共用 .th。
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
      className={className}
      aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        className="inline-flex items-center gap-1 text-xs font-medium text-ink-500 transition hover:text-deep pointer-coarse:min-h-10"
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
  const { profile, isManager, isAdmin, isDeptHead } = useAuth()

  const [quotes, setQuotes] = useState<Quote[]>([])
  const [totals, setTotals] = useState<Record<string, { total: number; orig: number }>>({})
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
      const totalMap: Record<string, { total: number; orig: number }> = {}
      for (const q of list) {
        totalMap[q.id] = quoteTotal(q, linesByQuote.get(q.id) ?? [])
      }
      setTotals(totalMap)

      if (isManager) {
        // 建立人＋兩關簽核人一次查回：建立人欄與狀態欄的關卡小字共用這份對照表。
        // 只在主管端查——profiles 的 RLS 是「本人或主管」，同仁查不到別人，關卡小字就只出職稱。
        const creatorIds = [...new Set(
          list.flatMap((q) => [q.created_by, q.approved_l1_by, q.approved_by])
            .filter((x): x is string => Boolean(x)),
        )]
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
  /** 停用帳號沒有待辦（進單後也沒有審核按鈕），與 header 徽章同一口徑 */
  const active = profile?.active ?? true
  /** 載入張數觸頂：分頁上的張數只算得到已載入的單，要標「+」提醒不是全部 */
  const capped = quotes.length >= LOAD_LIMIT

  const rows = useMemo<Row[]>(
    () => quotes.map((q) => ({ ...q, total: totals[q.id]?.total ?? 0, orig: totals[q.id]?.orig ?? 0 })),
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
      for (const t of TABS) if (matchesTab(r, t.key, role, userId, active)) out[t.key]++
    }
    return out
  }, [byKeyword, role, userId, active])

  /**
   * 預設分頁：一律從「待我處理」開始，載完之後若一張都沒有就落到「進行中」——
   * 不要讓人一進來就看到空畫面。
   * 看的是不受關鍵字影響的總張數：用篩後張數的話，打字時分頁會自己跳走。
   */
  const hasTodo = useMemo(
    () => rows.some((r) => matchesTab(r, 'todo', role, userId, active)),
    [rows, role, userId, active],
  )
  const defaultTab: QuoteTab = loading || hasTodo ? 'todo' : 'active'
  const tab = tabChoice ?? defaultTab

  const visible = useMemo(
    () => sortQuotes(
      byKeyword.filter((r) => matchesTab(r, tab, role, userId, active)),
      sort.key,
      sort.dir,
    ),
    [byKeyword, tab, role, userId, active, sort],
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

  /** 與 useQuoteDraft 共用 lib/quoteFilters 的 canReviewStatus，判斷只有那一份 */
  function canReview(q: Quote): boolean {
    return canReviewStatus(q.status, { isDeptHead, isAdmin })
  }

  /**
   * 主按鈕文字要跟點進去實際看到的頁面一致：
   * 只有草稿／被退回、而且是我開的單，點進去才是可編輯的精靈（與 useQuoteDraft 的 editableByOwner 同一判斷）；
   * 其餘（已送審、已核定、已定案、別人的草稿）都是唯讀審閱頁，叫「檢視」。
   */
  function canEdit(q: Quote): boolean {
    return isOwnerEditable(q.status) && !!profile && q.created_by === profile.id
  }

  /** 只認「目前篩選後看得見」的勾選，避免刪到被篩選條件藏起來的單 */
  const selectedQuotes = useMemo(
    () => visible.filter((q) => selected.has(q.id)),
    [visible, selected],
  )
  const allVisibleSelected = visible.length > 0 && visible.every((q) => selected.has(q.id))
  const nonDraftSelected = selectedQuotes.filter((q) => q.status !== 'draft').length
  /** 勾選欄只給主管看（建立人併在日期欄）；確認面板橫跨整列時要算進去 */
  const colCount = isManager ? 7 : 6

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

  /**
   * 一列的操作按鈕。桌機表格與手機卡片共用同一份（兩者用 sm:hidden／hidden sm:block 切換，
   * 任何一種螢幕寬度只會看到其中一組，不會有同一顆按鈕出現兩次）。
   * 第一顆是該列主動作：輪到我審「審查」(實心)／我的草稿與退回「編輯」／其餘「檢視」；刪除永遠排最後。
   */
  function rowActions(q: Row) {
    return (
      <>
        {/* 輪到我簽核的單給「審查」主鈕；同一頁（QuoteReview），只是不要讓主管點「編輯」去簽核 */}
        {canReview(q) ? (
          <Link to={`/quote/${q.id}`} className="btn btn-primary">審查</Link>
        ) : (
          <Link to={`/quote/${q.id}`} className="btn btn-outline">{canEdit(q) ? '編輯' : '檢視'}</Link>
        )}
        <a href={`#/print/${q.id}`} target="_blank" rel="noopener noreferrer" className="btn">列印</a>
        {/* 議價頁是 adminOnly（處長看得到卻進不去只會撞拒絕畫面）。
            副部長可減價定案；部長進去只能看 */}
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
      </>
    )
  }

  /** 合計金額＋定案折扣幅度。只有定案且有 orig_price 的單才有折扣；改版前定案的舊單 orig＝total，不顯示 */
  function totalCell(q: Row) {
    const off = q.status === 'closed' ? discountText(q.orig, q.total) : ''
    return (
      <>
        <span className="num font-semibold text-ink-900">{money(q.total)}</span>
        {off && <span className="num ml-1.5 text-[0.6875rem] text-green">{off}</span>}
      </>
    )
  }

  /** 單筆刪除確認：貼在觸發它的那一列（桌機）／那張卡（手機）正下方 */
  function confirmOnePanel(q: Row) {
    return (
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
          <dd className="num font-semibold text-deep">
            {money(q.total)}
            {q.status === 'closed' && discountText(q.orig, q.total) && (
              <span className="ml-1.5 text-[0.6875rem] font-normal text-green">{discountText(q.orig, q.total)}</span>
            )}
          </dd>
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
    )
  }

  /* 清單表格的橫線式樣式：只在本頁用，所以不動共用的 .th／.td（明細表、單價庫、議價表都靠它們） */
  const TH = 'whitespace-nowrap border-b border-ink-200 bg-ink-50 px-4 py-3 text-left text-xs font-medium text-ink-500'
  const TD = 'border-b border-ink-200/70 px-4 py-3.5 align-top'

  return (
    <div>
      {/* 主 CTA「＋ 開新單」由全站 header（components/Layout.tsx）提供，這裡刻意不再放第二顆。
          同一頁不得同時出現兩顆文字相同的主要動作。 */}
      <PageHeader
        index="01"
        eyebrow="QUOTATIONS"
        title="報價單"
        description="狀態欄下方的小段顯示走到哪一關；點「審查」直接進入核可畫面。"
      />

      <div className="space-y-4">
        {/* 分頁 chip 與關鍵字同一列：桌機兩端對齊，手機 chip 橫捲、關鍵字換到下一行 */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            role="group"
            aria-label="篩選"
            className="flex min-w-0 max-w-full gap-1.5 overflow-x-auto pb-0.5 sm:flex-wrap sm:overflow-visible sm:pb-0"
          >
            {TABS.map((t) => {
              const on = tab === t.key
              // 「待我處理」有張數、又不是目前分頁時，數字改警示色提醒有待辦
              const nudge = !on && t.key === 'todo' && counts.todo > 0
              return (
                <button
                  key={t.key}
                  type="button"
                  className={`chip shrink-0 gap-1.5 ${on ? 'chip-on' : ''}`}
                  aria-pressed={on}
                  onClick={() => setTabChoice(t.key)}
                >
                  {t.label}
                  <span
                    className={
                      'num text-xs ' +
                      (on ? 'font-semibold' : nudge ? 'font-semibold text-alert-d' : 'text-ink-500')
                    }
                  >
                    {counts[t.key]}{capped && t.key !== 'all' ? '+' : ''}
                  </span>
                </button>
              )
            })}
          </div>

          <label className="flex w-full items-center gap-2 text-[0.8125rem] text-ink-500 sm:w-auto" htmlFor="quote-keyword">
            <span className="shrink-0">關鍵字</span>
            <input
              id="quote-keyword"
              type="search"
              className="field min-w-0 sm:w-60"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="案名或單號"
            />
          </label>
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
            /* 頁首的「＋ 開新單」在手機也看得到，這裡只是順手的入口：用次要樣式、文字也不同字，
               不跟頁首搶「唯一的實心主按鈕」。 */
            action={<Link to="/quote/new" className="btn btn-outline">建立第一張報價單</Link>}
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
            {/* 批次刪除自成一列、緊鄰勾選欄。
                手機卡片沒有表頭全選框，這裡補一個只在手機出現的全選控制，行為與表頭那顆完全相同。 */}
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

            {/* ── 桌機／平板：橫線式表格（寬度不夠時在容器內橫捲，body 不得橫捲） ── */}
            <div className="hidden min-w-0 overflow-hidden rounded-lg border border-ink-200 bg-white sm:block">
              <div className="min-w-0 overflow-x-auto">
                <table className="w-full min-w-[60rem] border-collapse text-sm">
                  <thead>
                    <tr>
                      {isManager && (
                        <th className={`${TH} w-10`}>
                          <input
                            type="checkbox"
                            aria-label="全選目前篩選後的報價單"
                            checked={allVisibleSelected}
                            disabled={busy}
                            onChange={(e) => toggleAllVisible(e.target.checked)}
                          />
                        </th>
                      )}
                      <SortTh label="單號／案名" column="quote_no" sort={sort} onSort={toggleSort} className={TH} />
                      <th className={TH}>申請單位</th>
                      <SortTh
                        label={isManager ? '建立人／日期' : '日期'}
                        column="quote_date" sort={sort} onSort={toggleSort} className={TH}
                      />
                      <th className={`${TH} min-w-[9.5rem]`}>狀態</th>
                      <SortTh
                        label="合計（含稅）" column="total" sort={sort} onSort={toggleSort}
                        className={`${TH} text-right`}
                      />
                      <th className={`${TH} text-right`}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((q) => (
                      <Fragment key={q.id}>
                        <tr className="transition hover:bg-light/30">
                          {isManager && (
                            <td className={TD}>
                              <input
                                type="checkbox"
                                aria-label={`選取 ${q.quote_no}`}
                                checked={selected.has(q.id)}
                                disabled={busy}
                                onChange={(e) => toggleOne(q.id, e.target.checked)}
                              />
                            </td>
                          )}
                          <td className={TD}>
                            <div className="font-num tabular-nums text-xs text-ink-500">{q.quote_no}</div>
                            <div className="mt-0.5 break-words font-medium text-ink-900">{q.project}</div>
                          </td>
                          <td className={`${TD} min-w-[8.5rem] break-words text-ink-700`}>{q.dept}</td>
                          <td className={`${TD} text-ink-700`}>
                            {isManager && <div className="break-words">{creators[q.created_by] || '—'}</div>}
                            <div className={isManager ? 'mt-0.5 whitespace-nowrap font-num text-xs tabular-nums text-ink-500' : 'font-num tabular-nums whitespace-nowrap'}>
                              {q.quote_date}
                            </div>
                          </td>
                          <td className={TD}>
                            <span className="inline-flex flex-col items-start gap-1.5">
                              <StatusTag status={q.status} l1Skipped={q.l1_skipped} />
                              <ApprovalFlow variant="compact" flow={buildApprovalFlow(q)} names={creators} />
                            </span>
                          </td>
                          <td className={`${TD} whitespace-nowrap text-right`}>{totalCell(q)}</td>
                          <td className={TD}>
                            <div className="flex justify-end gap-1.5 whitespace-nowrap">{rowActions(q)}</div>
                          </td>
                        </tr>

                        {/* 單筆確認也貼著它的刪除鈕：橫跨整列插在該列正下方 */}
                        {confirmOne?.id === q.id && (
                          <tr>
                            <td className={TD} colSpan={colCount}>
                              {/* 這張表在橫捲容器裡，面板外層要 min-w-0 才不會把表格撐寬 */}
                              <div className="w-full min-w-0">{confirmOnePanel(q)}</div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ── 手機（<640px）：專屬卡片。案名＋狀態 → 關卡段＋金額 → 兩欄按鈕 ── */}
            <ul className="space-y-2.5 sm:hidden">
              {visible.map((q) => (
                <li key={q.id} className="min-w-0 space-y-2.5 rounded-lg border border-ink-200 bg-white px-4 py-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-num tabular-nums text-xs text-ink-500">{q.quote_no}</div>
                      <div className="break-words text-[0.9375rem] font-medium text-ink-900">{q.project}</div>
                      <div className="break-words text-xs text-ink-500">
                        {[q.dept, isManager ? creators[q.created_by] : '', q.quote_date].filter(Boolean).join('・')}
                      </div>
                    </div>
                    <span className="shrink-0"><StatusTag status={q.status} l1Skipped={q.l1_skipped} /></span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <ApprovalFlow variant="compact" flow={buildApprovalFlow(q)} names={creators} className="min-w-0" />
                    <span className="shrink-0 text-right">{totalCell(q)}</span>
                  </div>
                  {isManager && (
                    <label className="flex items-center gap-2 text-xs text-ink-500">
                      <input
                        type="checkbox"
                        aria-label={`選取 ${q.quote_no}`}
                        checked={selected.has(q.id)}
                        disabled={busy}
                        onChange={(e) => toggleOne(q.id, e.target.checked)}
                      />
                      選取此單
                    </label>
                  )}
                  <div className="grid grid-cols-2 gap-2">{rowActions(q)}</div>
                  {confirmOne?.id === q.id && <div className="min-w-0">{confirmOnePanel(q)}</div>}
                </li>
              ))}
            </ul>
          </>
        )}

        {/* 200 張是伺服器一次載回的上限，不是「總共只有這些」。誠實講在清單底部，
            免得有人搜不到舊單以為單不見了。 */}
        {!loading && quotes.length >= LOAD_LIMIT && (
          <p className="text-[0.6875rem] text-ink-500">
            已載入最新 {LOAD_LIMIT} 張；更舊的單目前搜尋不到（伺服器端分頁待後續處理）。
            分頁上的張數只計入已載入的單（標「+」），可能少於實際張數；
            「待我處理」的實際張數以頁首「報價單」旁的徽章為準。
          </p>
        )}
      </div>
    </div>
  )
}
