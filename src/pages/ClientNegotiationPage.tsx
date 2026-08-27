import { Fragment, useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { calcTotals, lineAmount, money } from '../lib/calc'
import type {
  DraftLine, DraftSection, NegoResponse, Negotiation,
  Quote, QuoteLine, QuoteSection, QuoteStatus,
} from '../types'

/* ═══════════════════════════════════════════════════════════════════════════
   醫院採購（聯新國際醫院）專用議價頁。

   使用者是報價的「收受方」，不是自家同仁。本頁只呈現他們手上那張報價單
   已經印著的資訊：單號、案名、日期、項目、單價、複價、合計。

   刻意不碰的表：price_items / price_floors / price_history / labor_rates /
   material_indices / evidence_sources，以及 settings 裡的 quote_stamp、
   labor_base_daily、labor_discount。這些是我方的底價、成本與議價籌碼，
   RLS 已經擋掉，前端也不去問——問了只會拿到空陣列，還會讓畫面誤判成
   「資料還沒載入」。同理不使用 useRefData()，那個 context 撈的正是上面那些表。
   ═══════════════════════════════════════════════════════════════════════════ */

/** 採購看得到的單據狀態；其餘（draft / submitted / rejected）根本不該出現在這裡 */
const VISIBLE_STATUS: QuoteStatus[] = ['approved', 'negotiating', 'closed']

/** 對外用語：不要把我方內部流程狀態的原始字串或內部說法露出去 */
const CLIENT_STATUS_LABEL: Partial<Record<QuoteStatus, string>> = {
  approved: '已收到報價',
  negotiating: '議價中',
  closed: '已定案',
}

const CLIENT_STATUS_TAG: Partial<Record<QuoteStatus, string>> = {
  approved: 'bg-green/15 text-green',
  negotiating: 'bg-bright/15 text-bright',
  closed: 'bg-deep/15 text-deep',
}

const statusText = (s: QuoteStatus): string => CLIENT_STATUS_LABEL[s] ?? '處理中'
const statusTagClass = (s: QuoteStatus): string => CLIENT_STATUS_TAG[s] ?? 'bg-ink-200 text-ink-700'

/** 我方回覆的中文說法 */
const RESPONSE_LABEL: Record<NegoResponse, string> = {
  accept: '接受',
  partial: '部分讓步',
  hold: '維持原價',
}

interface SettingRow { key: string; value: unknown }

/** settings 只讀得到 mgmt_fee_rate / tax_rate / company / client / catalog_version */
const rateOf = (rows: SettingRow[], key: string, fallback: number): number => {
  const v = rows.find((r) => r.key === key)?.value
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return fallback
}

/** settings 也讀不到時的保底值，與系統預設一致 */
const DEFAULT_MGMT = 0.09
const DEFAULT_TAX = 0.05

const toDraftLine = (l: QuoteLine, price: number): DraftLine => ({
  key: l.id,
  item_id: l.item_id,
  labor_rate_id: l.labor_rate_id,
  name: l.name,
  spec: l.spec,
  unit: l.unit,
  unit_price: price,
  qty: Number(l.qty),
  is_custom: l.is_custom,
  reason: l.reason,
  note: l.note,
})

const timeText = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-TW', { hour12: false })
}

const numOf = (s: string): number => {
  const v = Number(s)
  return Number.isFinite(v) ? v : 0
}

function ErrorBox({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-warn/30 bg-warn-bg px-4 py-2 text-sm text-warn">
      {text}
    </div>
  )
}

export default function ClientNegotiationPage() {
  const { id } = useParams<{ id: string }>()
  return id ? <QuoteNegotiation quoteId={id} /> : <QuoteIndex />
}

/* ───────────────────────── 畫面一：報價單清單 ───────────────────────── */

function QuoteIndex() {
  const navigate = useNavigate()
  const [quotes, setQuotes] = useState<Quote[]>([])
  const [totals, setTotals] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)

      const [q, s] = await Promise.all([
        supabase.from('quotes').select('*')
          .in('status', VISIBLE_STATUS)
          .order('quote_date', { ascending: false })
          .order('quote_no', { ascending: false }),
        supabase.from('settings').select('key,value').in('key', ['mgmt_fee_rate', 'tax_rate']),
      ])
      if (cancelled) return
      if (q.error) { setError(`報價單載入失敗：${q.error.message}`); setLoading(false); return }
      if (s.error) { setError(`費率設定載入失敗：${s.error.message}`); setLoading(false); return }

      const rows = (q.data ?? []) as Quote[]
      const setRows = (s.data ?? []) as SettingRow[]
      const defMgmt = rateOf(setRows, 'mgmt_fee_rate', DEFAULT_MGMT)
      const defTax = rateOf(setRows, 'tax_rate', DEFAULT_TAX)
      setQuotes(rows)

      if (rows.length === 0) { setTotals({}); setLoading(false); return }

      // 一次撈完整批單的明細再分組，不要每張單各發一次請求
      const { data: lineData, error: lErr } = await supabase
        .from('quote_lines').select('*').in('quote_id', rows.map((r) => r.id))
      if (cancelled) return
      if (lErr) { setError(`報價明細載入失敗：${lErr.message}`); setLoading(false); return }

      const lines = (lineData ?? []) as QuoteLine[]
      const map: Record<string, number> = {}
      for (const r of rows) {
        const mine = lines.filter((l) => l.quote_id === r.id)
        const sections: DraftSection[] = [{
          key: 'all', title: '', lines: mine.map((l) => toDraftLine(l, Number(l.unit_price))),
        }]
        // 費率優先用該筆單自己的欄位（單據成立當下的費率），缺值才退回 settings
        const mgmt = Number.isFinite(Number(r.mgmt_fee_rate)) && r.mgmt_fee_rate !== null
          ? Number(r.mgmt_fee_rate) : defMgmt
        const tax = Number.isFinite(Number(r.tax_rate)) && r.tax_rate !== null
          ? Number(r.tax_rate) : defTax
        map[r.id] = calcTotals(sections, mgmt, tax).total
      }
      setTotals(map)
      setLoading(false)
    }

    void load()
    return () => { cancelled = true }
  }, [])

  return (
    <div className="space-y-4">
      <div className="card">
        <h2 className="text-[17px] font-semibold text-deep">報價單議價</h2>
        <p className="mt-2 text-[13px] text-ink-700">
          以下為立德新股份有限公司送交本院之報價單。您可針對個別項目提出議價，
          我方將於收到後回覆。
        </p>
      </div>

      {error && <ErrorBox text={error} />}

      {loading ? (
        <div className="p-10 text-center text-ink-500">報價單載入中…</div>
      ) : quotes.length === 0 ? (
        <div className="card text-center text-ink-500">
          目前沒有待議價的報價單。<br />
          當立德新送出報價後，單據會自動出現在這裡，屆時即可於本頁提出議價。
        </div>
      ) : (
        <div className="card">
          {/* 手機：每張報價單變成一張卡片（.rwd-table）；桌機維持表格並可橫捲 */}
          <div className="table-scroll">
            <table className="w-full border-collapse sm:min-w-[760px] rwd-table">
              <thead>
                <tr>
                  <th className="th w-32">單號</th>
                  <th className="th min-w-[220px]">案名／工程地點</th>
                  <th className="th w-28">報價日期</th>
                  <th className="th w-28">狀態</th>
                  <th className="th num w-32">合計金額（含稅）</th>
                  <th className="th w-28">操作</th>
                </tr>
              </thead>
              <tbody>
                {quotes.map((q) => (
                  <tr key={q.id}>
                    <td className="td num" data-label="單號">{q.quote_no}</td>
                    <td className="td text-ink-900" data-label="案名／工程地點">
                      <span className="block min-w-0 break-words">{q.project || '—'}</span>
                    </td>
                    <td className="td num" data-label="報價日期">{q.quote_date}</td>
                    <td className="td" data-label="狀態">
                      <span className={`tag ${statusTagClass(q.status)}`}>{statusText(q.status)}</span>
                    </td>
                    <td className="td num font-semibold text-deep" data-label="合計金額（含稅）">
                      {totals[q.id] === undefined ? '—' : money(totals[q.id])}
                    </td>
                    {/* 沒有 data-label：手機會佔滿整行，按鈕撐滿好按 */}
                    <td className="td">
                      <button
                        type="button"
                        className="btn w-full sm:w-auto"
                        onClick={() => navigate(`/client/${q.id}`)}
                      >
                        檢視／議價
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

/* ─────────────────── 畫面二：單一報價單的逐項議價 ─────────────────── */

interface RowState { offer: string; note: string }

function QuoteNegotiation({ quoteId }: { quoteId: string }) {
  const navigate = useNavigate()
  const { profile, session } = useAuth()

  const [quote, setQuote] = useState<Quote | null>(null)
  const [sections, setSections] = useState<QuoteSection[]>([])
  const [lines, setLines] = useState<QuoteLine[]>([])
  const [negos, setNegos] = useState<Negotiation[]>([])
  const [mgmtRate, setMgmtRate] = useState(DEFAULT_MGMT)
  const [taxRate, setTaxRate] = useState(DEFAULT_TAX)
  const [rows, setRows] = useState<Record<string, RowState>>({})

  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)

    // 只問採購讀得到的五張表：quotes / quote_sections / quote_lines /
    // negotiations / settings（且 settings 只取費率兩個 key）
    const [q, s, l, n, cfg] = await Promise.all([
      supabase.from('quotes').select('*').eq('id', quoteId).in('status', VISIBLE_STATUS).maybeSingle(),
      supabase.from('quote_sections').select('*').eq('quote_id', quoteId).order('sort'),
      supabase.from('quote_lines').select('*').eq('quote_id', quoteId).order('sort'),
      supabase.from('negotiations').select('*').eq('quote_id', quoteId).order('round'),
      supabase.from('settings').select('key,value').in('key', ['mgmt_fee_rate', 'tax_rate']),
    ])
    const firstErr = [q, s, l, n, cfg].find((r) => r.error)?.error
    if (firstErr) { setError(`資料載入失敗：${firstErr.message}`); setLoading(false); return }
    if (!q.data) { setError('查無此報價單，或本院尚未收到這張單。'); setLoading(false); return }

    const quoteRow = q.data as Quote
    const setRows_ = (cfg.data ?? []) as SettingRow[]
    const ql = (l.data ?? []) as QuoteLine[]

    setQuote(quoteRow)
    setSections((s.data ?? []) as QuoteSection[])
    setLines(ql)
    setNegos((n.data ?? []) as Negotiation[])
    setMgmtRate(quoteRow.mgmt_fee_rate !== null && Number.isFinite(Number(quoteRow.mgmt_fee_rate))
      ? Number(quoteRow.mgmt_fee_rate) : rateOf(setRows_, 'mgmt_fee_rate', DEFAULT_MGMT))
    setTaxRate(quoteRow.tax_rate !== null && Number.isFinite(Number(quoteRow.tax_rate))
      ? Number(quoteRow.tax_rate) : rateOf(setRows_, 'tax_rate', DEFAULT_TAX))
    setRows(Object.fromEntries(ql.map((x): [string, RowState] => [x.id, { offer: '', note: '' }])))
    setLoading(false)
  }, [quoteId])

  useEffect(() => { void load() }, [load])

  const reloadNegos = useCallback(async () => {
    const { data, error: e } = await supabase
      .from('negotiations').select('*').eq('quote_id', quoteId).order('round')
    if (e) { setError(`議價紀錄重新載入失敗：${e.message}`); return }
    setNegos((data ?? []) as Negotiation[])
  }, [quoteId])

  const setRow = (lineId: string, patch: Partial<RowState>) => {
    setRows((prev) => ({ ...prev, [lineId]: { ...(prev[lineId] ?? { offer: '', note: '' }), ...patch } }))
  }

  const readOnly = quote?.status === 'closed'

  /** 該列採購有填建議單價就用建議價，否則沿用我方原報價 */
  const priceOf = (l: QuoteLine): number => {
    const r = rows[l.id]
    if (!r || r.offer.trim() === '') return Number(l.unit_price)
    return numOf(r.offer)
  }

  /** 依大項分組；找不到所屬大項的項目集中在最後，不要讓它們消失 */
  const buildSections = (price: (l: QuoteLine) => number): DraftSection[] => {
    const known = new Set(sections.map((x) => x.id))
    const out: DraftSection[] = sections.map((sec) => ({
      key: sec.id,
      title: sec.title,
      lines: lines.filter((l) => l.section_id === sec.id).map((l) => toDraftLine(l, price(l))),
    }))
    const orphans = lines.filter((l) => !known.has(l.section_id))
    if (orphans.length) {
      out.push({ key: '__orphan', title: '其他項目', lines: orphans.map((l) => toDraftLine(l, price(l))) })
    }
    return out
  }

  const origTotals = calcTotals(buildSections((l) => Number(l.unit_price)), mgmtRate, taxRate)
  const offerTotals = calcTotals(buildSections(priceOf), mgmtRate, taxRate)
  const diff = offerTotals.total - origTotals.total

  const maxRound = negos.reduce((a, n) => Math.max(a, Number(n.round) || 0), 0)
  const nextRound = maxRound + 1

  const submit = async () => {
    if (!quote || readOnly) return
    setError(null); setMsg(null)

    const targets = lines.filter((l) => {
      const r = rows[l.id]
      return Boolean(r) && (r.offer.trim() !== '' || r.note.trim() !== '')
    })
    if (!targets.some((l) => (rows[l.id]?.offer ?? '').trim() !== '')) {
      setError('請至少填寫一項建議單價。')
      return
    }
    const bad = targets.find((l) => {
      const v = (rows[l.id]?.offer ?? '').trim()
      return v !== '' && !(Number.isFinite(Number(v)) && Number(v) >= 0)
    })
    if (bad) { setError(`「${bad.name}」的建議單價請填寫 0 以上的數字。`); return }

    // response / final_price 是我方的判斷欄位，這裡一律不送
    const payload = targets.map((l) => {
      const r = rows[l.id]
      return {
        quote_id: quote.id,
        line_id: l.id,
        round: nextRound,
        client_offer: r.offer.trim() === '' ? null : numOf(r.offer),
        rationale: r.note.trim(),
        responded_by: profile?.id ?? session?.user.id ?? null,
      }
    })

    setBusy(true)
    const { error: e } = await supabase.from('negotiations').insert(payload)
    setBusy(false)
    if (e) { setError(`送出失敗：${e.message}`); return }

    setRows(Object.fromEntries(lines.map((l): [string, RowState] => [l.id, { offer: '', note: '' }])))
    await reloadNegos()
    setMsg('已送出，我方將於審閱後回覆。')
  }

  if (loading) return <div className="p-10 text-center text-ink-500">報價單載入中…</div>

  if (!quote) {
    return (
      <div className="card">
        <div className="text-warn">{error ?? '查無此報價單。'}</div>
        <button type="button" className="btn mt-3" onClick={() => navigate('/client')}>
          返回清單
        </button>
      </div>
    )
  }

  const rounds = Array.from(new Set(negos.map((n) => Number(n.round)))).sort((a, b) => b - a)
  const nameOfLine = (lineId: string | null): string => {
    if (!lineId) return '整單'
    return lines.find((l) => l.id === lineId)?.name ?? '（該項目已不在本單）'
  }

  let seq = 0

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-[17px] font-semibold text-deep">報價單議價</h2>
          <span className="tag">{quote.quote_no}</span>
          <span className={`tag ${statusTagClass(quote.status)}`}>{statusText(quote.status)}</span>
          <button type="button" className="btn ml-auto shrink-0" onClick={() => navigate('/client')}>
            返回清單
          </button>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="min-w-0">
            <div className="label">單號</div>
            <div className="num text-ink-900">{quote.quote_no}</div>
          </div>
          <div className="min-w-0">
            <div className="label">案名／工程地點</div>
            {/* 案名可能很長，手機要斷行不要撐爆版面 */}
            <div className="break-words text-ink-900">{quote.project || '—'}</div>
          </div>
          <div>
            <div className="label">報價日期</div>
            <div className="num text-ink-900">{quote.quote_date}</div>
          </div>
          <div>
            <div className="label">合計金額（含稅）</div>
            <div className="num text-[17px] font-semibold text-deep">{money(origTotals.total)}</div>
          </div>
        </div>

        {readOnly && (
          <div className="mt-3 rounded-md border border-ink-200 bg-light/50 px-3 py-2 text-[13px] text-deep">
            本案已定案，如需調整請洽立德新工務處。
          </div>
        )}
      </div>

      {error && <ErrorBox text={error} />}
      {msg && (
        <div className="rounded-md border border-green/40 bg-green/10 px-4 py-2 text-sm text-green">
          {msg}
        </div>
      )}

      <div className="card">
        <div className="card-title">逐項議價</div>
        {lines.length === 0 ? (
          <div className="text-ink-500">本單沒有任何項目。</div>
        ) : (
          <>
            <p className="mb-3 text-[13px] text-ink-700">
              請於「貴院建議單價」填入希望的單價，並於「說明」簡述理由；未填寫的項目視為不議價，
              沿用我方原報價。
            </p>
            {/* 手機：每個品項變成一張卡片（.rwd-table）；桌機維持表格並可橫捲 */}
            <div className="table-scroll">
              <table className="w-full border-collapse sm:min-w-[1040px] rwd-table">
                <thead>
                  <tr>
                    <th className="th w-12">項次</th>
                    <th className="th min-w-[220px]">工程項目及說明</th>
                    <th className="th w-14">單位</th>
                    <th className="th num w-20">數量</th>
                    <th className="th num w-28">我方報價單價</th>
                    <th className="th num w-28">複價</th>
                    <th className="th num w-36">貴院建議單價</th>
                    <th className="th min-w-[240px]">說明</th>
                  </tr>
                </thead>
                <tbody>
                  {buildSections(priceOf).map((sec) => (
                    <Fragment key={sec.key}>
                      <tr>
                        {/* 大項標題列：手機沒有 data-label 會自成一張整行的標題卡 */}
                        <td className="td bg-light/50 font-semibold text-deep" colSpan={8}>
                          <span className="block w-full min-w-0 break-words">
                            {sec.title || '（未命名大項）'}
                          </span>
                        </td>
                      </tr>
                      {sec.lines.map((dl) => {
                        const l = lines.find((x) => x.id === dl.key)
                        if (!l) return null
                        seq += 1
                        const r = rows[l.id]
                        const orig = Number(l.unit_price)
                        const filled = Boolean(r) && r.offer.trim() !== ''
                        const offer = filled ? numOf(r.offer) : orig
                        const pct = orig ? ((offer - orig) / orig) * 100 : 0
                        return (
                          <tr key={l.id}>
                            <td className="td num" data-label="項次">{seq}</td>
                            {/* 沒有 data-label：手機佔滿整行，當成卡片標題 */}
                            <td className="td">
                              <div className="w-full min-w-0">
                                <div className="break-words text-ink-900">{l.name}</div>
                                {l.spec && (
                                  <div className="break-words text-[11px] text-ink-500">{l.spec}</div>
                                )}
                                {/* 與列印版報價單同一條規則：臨時項目印 reason，其餘印 note */}
                                {(l.is_custom ? l.reason : l.note) && (
                                  <div className="break-words text-[11px] text-ink-500">
                                    {l.is_custom ? l.reason : l.note}
                                  </div>
                                )}
                              </div>
                            </td>
                            <td className="td" data-label="單位">{l.unit}</td>
                            <td className="td num" data-label="數量">{Number(l.qty)}</td>
                            <td className="td num" data-label="我方報價單價">{money(orig)}</td>
                            <td className="td num" data-label="複價">
                              {money(lineAmount(orig, Number(l.qty)))}
                            </td>
                            <td className="td" data-label="貴院建議單價">
                              {/* 手機時 td 是 flex，輸入框與百分比提示要包在同一格子裡才不會被拆成兩欄 */}
                              <div className="w-full min-w-0 flex-1">
                                <input
                                  type="number"
                                  min={0}
                                  inputMode="decimal"
                                  className="field num"
                                  disabled={readOnly}
                                  value={r ? r.offer : ''}
                                  onChange={(e) => setRow(l.id, { offer: e.target.value })}
                                />
                                {filled && (
                                  <div className={`mt-1 text-[11px] font-semibold ${
                                    pct < 0 ? 'text-green' : pct > 0 ? 'text-alert' : 'text-ink-500'
                                  }`}>
                                    {pct > 0 ? '+' : ''}{pct.toFixed(1)}%
                                    <span className="ml-1 font-normal text-ink-500">
                                      （複價 {money(lineAmount(offer, Number(l.qty)))}）
                                    </span>
                                  </div>
                                )}
                              </div>
                            </td>
                            <td className="td" data-label="說明">
                              <div className="w-full min-w-0 flex-1">
                                <textarea
                                  className="field"
                                  rows={2}
                                  disabled={readOnly}
                                  value={r ? r.note : ''}
                                  onChange={(e) => setRow(l.id, { note: e.target.value })}
                                  placeholder="例：與他案比較偏高／規格可調整"
                                />
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-md border border-ink-200 px-3 py-2">
                <div className="label">我方原報價合計（含稅）</div>
                <div className="num text-[15px] font-semibold text-ink-900">
                  {money(origTotals.total)}
                </div>
              </div>
              <div className="rounded-md border border-ink-200 px-3 py-2">
                <div className="label">依貴院建議之調整後合計（含稅）</div>
                <div className="num text-[15px] font-semibold text-deep">
                  {money(offerTotals.total)}
                </div>
              </div>
              <div className="rounded-md border border-ink-200 px-3 py-2">
                <div className="label">與原報價差額</div>
                <div className={`num text-[15px] font-semibold ${
                  diff < 0 ? 'text-green' : diff > 0 ? 'text-alert' : 'text-ink-700'
                }`}>
                  {diff > 0 ? '+' : ''}{money(diff)}
                </div>
              </div>
            </div>
            <p className="mt-2 text-[12px] text-ink-500">
              以上金額含工程管理費 {(mgmtRate * 100).toFixed(1)}% 與營業稅 {(taxRate * 100).toFixed(1)}%；
              未填寫建議單價的項目沿用我方原價。此為試算，實際金額以雙方確認後之報價單為準。
            </p>

            {!readOnly && (
              <>
                <p className="mt-4 text-xs text-ink-500">
                  送出後我方將逐項審閱並回覆，回覆內容會顯示在下方紀錄。
                </p>
                {/* 手機：送出鈕釘在畫面底部並撐滿寬度；sm 以上回到一般排版 */}
                <div className="action-bar mt-2">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => void submit()}
                  >
                    {busy ? '送出中…' : '送出議價要求'}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>

      <div className="card">
        <div className="card-title">議價往返紀錄</div>
        {rounds.length === 0 ? (
          <div className="text-ink-500">尚無議價紀錄。</div>
        ) : (
          <div className="space-y-4">
            {rounds.map((rd) => {
              const group = negos.filter((n) => Number(n.round) === rd)
              const when = group.map((n) => n.responded_at).sort()[0] ?? ''
              return (
                <div key={rd} className="rounded-md border border-ink-200">
                  <div className="flex flex-wrap items-center gap-2 border-b border-ink-200 bg-light/50 px-3 py-1.5">
                    <span className="font-semibold text-deep">第 {rd} 輪</span>
                    <span className="text-xs text-ink-500">{when ? timeText(when) : ''}</span>
                    <span className="ml-auto text-xs text-ink-500">{group.length} 項</span>
                  </div>
                  {/* 手機：每筆往返變成一張卡片（.rwd-table）；桌機維持表格並可橫捲 */}
                  <div className="table-scroll">
                    <table className="w-full border-collapse sm:min-w-[860px] rwd-table">
                      <thead>
                        <tr>
                          <th className="th min-w-[160px]">工程項目</th>
                          <th className="th num w-28">貴院建議單價</th>
                          <th className="th min-w-[180px]">貴院說明</th>
                          <th className="th w-24">我方回覆</th>
                          <th className="th num w-28">我方回覆單價</th>
                          <th className="th min-w-[200px]">我方說明</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.map((n) => {
                          // rationale 一欄兩用：有 response 代表這筆是我方寫的回覆，
                          // 說明歸「我方說明」；沒有 response 就是貴院送來的那筆。
                          const answered = n.response !== null
                          return (
                            <tr key={n.id}>
                              {/* 沒有 data-label：手機佔滿整行，當成卡片標題 */}
                              <td className="td">
                                <span className="block w-full min-w-0 break-words">
                                  {nameOfLine(n.line_id)}
                                </span>
                              </td>
                              <td className="td num" data-label="貴院建議單價">
                                {n.client_offer === null ? '—' : money(Number(n.client_offer))}
                              </td>
                              <td
                                className="td whitespace-pre-wrap break-words text-[12px] text-ink-700"
                                data-label="貴院說明"
                              >
                                {answered ? '—' : (n.rationale || '—')}
                              </td>
                              <td className="td" data-label="我方回覆">
                                {n.response
                                  ? RESPONSE_LABEL[n.response]
                                  : <span className="text-ink-500">等待我方回覆</span>}
                              </td>
                              <td className="td num" data-label="我方回覆單價">
                                {n.final_price === null ? '—' : money(Number(n.final_price))}
                              </td>
                              <td
                                className="td whitespace-pre-wrap break-words text-[12px] text-ink-700"
                                data-label="我方說明"
                              >
                                {answered ? (n.rationale || '—') : '—'}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
