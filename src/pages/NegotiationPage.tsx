import { Fragment, useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useRefData } from '../context/RefDataContext'
import { calcTotals, concessionPct, discountAndRound, discountText, evidenceSentence, money } from '../lib/calc'
import Alert from '../components/ui/Alert'
import ConfirmPanel from '../components/ui/ConfirmPanel'
import EmptyState from '../components/ui/EmptyState'
import PageHeader from '../components/ui/PageHeader'
import Stat from '../components/ui/Stat'
import StatusTag from '../components/ui/StatusTag'
import { RESPONSE_LABEL } from '../types'
import type {
  DraftLine, DraftSection, Negotiation,
  PriceFloor, Quote, QuoteLine, QuoteSection,
} from '../types'

/**
 * 2026-10-06 起議價簡化成「副部長直接減價 → 定案」：院方還價、我方回應兩欄拿掉，
 * 每列只剩定案單價與理由。理由預設「協議折價」，副部長可再補充。
 */
interface RowState {
  final_price: string
  rationale: string
}

/** 理由欄預設文字；也是歷程上 response='discount' 的中文標籤 */
const DEFAULT_RATIONALE = RESPONSE_LABEL.discount

const numOf = (s: string): number => {
  const v = Number(s)
  return Number.isFinite(v) ? v : 0
}

/** 取整單位：往下抹到這個倍數（1 = 只打折不抹零） */
const ROUND_TO = [
  { v: 1, label: '不抹零' },
  { v: 100, label: '抹到百元' },
  { v: 1000, label: '抹到千元' },
  { v: 10000, label: '抹到萬元' },
]

const timeText = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-TW', { hour12: false })
}

export default function NegotiationPage() {
  const { id } = useParams<{ id: string }>()
  // 減價、抹零、定案只給在職副部長（部長進得來但只能看）；db/29 的 RPC／trigger 才是真正的閘門
  const { isViceDirector } = useAuth()
  const { items, indexOf, evidenceOf, mgmtFeeRate, taxRate } = useRefData()

  const [quote, setQuote] = useState<Quote | null>(null)
  const [sections, setSections] = useState<QuoteSection[]>([])
  const [lines, setLines] = useState<QuoteLine[]>([])
  const [negos, setNegos] = useState<Negotiation[]>([])
  const [floors, setFloors] = useState<PriceFloor[]>([])
  const [rows, setRows] = useState<Record<string, RowState>>({})

  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  /** 整單打折取整（副部長）：輸入「幾折」，如 9、8.5 */
  const [discZhe, setDiscZhe] = useState('9')
  const [roundTo, setRoundTo] = useState(1000)
  /** 已套用的抹零金額；任何一列定案單價被手動改過就歸零（零頭不再對得上） */
  const [roundOff, setRoundOff] = useState(0)

  const load = useCallback(async () => {
    if (!id) { setError('網址缺少單據編號。'); setLoading(false); return }
    setLoading(true)
    setError(null)
    const [q, s, l, n, f] = await Promise.all([
      supabase.from('quotes').select('*').eq('id', id).maybeSingle(),
      supabase.from('quote_sections').select('*').eq('quote_id', id).order('sort'),
      supabase.from('quote_lines').select('*').eq('quote_id', id).order('sort'),
      supabase.from('negotiations').select('*').eq('quote_id', id).order('round'),
      supabase.from('price_floors').select('*'),
    ])
    const firstErr = [q, s, l, n, f].find((r) => r.error)?.error
    if (firstErr) { setError(`資料載入失敗：${firstErr.message}`); setLoading(false); return }
    if (!q.data) { setError('查無此報價單，或您沒有檢視權限。'); setLoading(false); return }

    const ql = (l.data ?? []) as QuoteLine[]
    setQuote(q.data as Quote)
    // 已定案的單要把當時抹掉的零頭讀回來，否則定案後合計又長回尾數
    setRoundOff(Number((q.data as Quote).round_off) || 0)
    setSections((s.data ?? []) as QuoteSection[])
    setLines(ql)
    setNegos((n.data ?? []) as Negotiation[])
    setFloors((f.data ?? []) as PriceFloor[])
    setRows(Object.fromEntries(ql.map((x): [string, RowState] => [x.id, {
      final_price: String(Number(x.unit_price)),
      rationale: DEFAULT_RATIONALE,
    }])))
    setLoading(false)
  }, [id])

  useEffect(() => { void load() }, [load])

  const setRow = (lineId: string, patch: Partial<RowState>) => {
    if ('final_price' in patch) setRoundOff(0)
    setRows((prev) => ({ ...prev, [lineId]: { ...prev[lineId], ...patch } }))
  }

  const floorOf = (itemId: string | null): number | null => {
    if (!itemId) return null
    const f = floors.find((x) => x.item_id === itemId)
    return f ? Number(f.floor_price) : null
  }

  /**
   * 「我方原單價」基準：已定案的單 unit_price 已被覆寫成定案價，要靠 orig_price
   * （db/29，第一次改價時保留）才算得出原報價；沒改過價的列 orig_price 為 null，就用 unit_price。
   */
  const baseOf = (l: QuoteLine): number => Number(l.orig_price ?? l.unit_price)

  const finalOf = (l: QuoteLine): number => {
    const r = rows[l.id]
    if (!r || r.final_price.trim() === '') return Number(l.unit_price)
    return numOf(r.final_price)
  }

  const buildSections = (price: (l: QuoteLine) => number): DraftSection[] => {
    const known = new Set(sections.map((s) => s.id))
    const toDraft = (l: QuoteLine): DraftLine => ({
      key: l.id,
      item_id: l.item_id,
      labor_rate_id: l.labor_rate_id,
      name: l.name,
      spec: l.spec,
      unit: l.unit,
      unit_price: price(l),
      qty: Number(l.qty),
      is_custom: l.is_custom,
      reason: l.reason,
      note: l.note,
    })
    const out: DraftSection[] = sections.map((s) => ({
      key: s.id,
      title: s.title,
      lines: lines.filter((l) => l.section_id === s.id).map(toDraft),
    }))
    const orphans = lines.filter((l) => !known.has(l.section_id))
    if (orphans.length) {
      out.push({ key: '__orphan', title: '未分類項目', lines: orphans.map(toDraft) })
    }
    return out
  }

  const mgmt = quote ? Number(quote.mgmt_fee_rate) : mgmtFeeRate
  const tax = quote ? Number(quote.tax_rate) : taxRate
  // 同一份分組結果同時餵給合計與表格，少算一次也少一次不一致的機會
  const finalSections = buildSections(finalOf)
  // 原報價合計不帶 round_off（抹零是定案時給的讓利），定案合計帶——與列印頁／清單／單據頁同一口徑
  const origTotals = calcTotals(buildSections(baseOf), mgmt, tax)
  const finalTotals = calcTotals(finalSections, mgmt, tax, roundOff)
  const diff = origTotals.total - finalTotals.total
  const discText = discountText(origTotals.total, finalTotals.total)

  // 項次在 render 當下一次推導完；原本靠 JSX 內 `seq += 1` 累加，
  // oxlint react(immutability) 會警告「render 完成後仍在改變數」。
  const seqOf = new Map<string, number>()
  for (const sec of finalSections) {
    for (const dl of sec.lines) seqOf.set(dl.key, seqOf.size + 1)
  }

  const belowFloor = lines.filter((l) => {
    const fp = floorOf(l.item_id)
    return fp !== null && finalOf(l) < fp
  })

  const discount = numOf(discZhe) / 10
  const discountOk = discount > 0 && discount <= 1
  // 以「我方原單價」為基準打折，不疊在已議過的定案價上——按兩次 9 折不會變 81 折
  const discPreview = discountOk
    ? discountAndRound(buildSections(baseOf), mgmt, tax, discount, roundTo)
    : null

  const applyDiscount = () => {
    if (!discPreview) { setError('折數請填 1～10 之間，例如 9 或 8.5。'); return }
    setError(null); setMsg(null)
    const note = `整單 ${discZhe} 折${roundTo > 1 ? `，合計${ROUND_TO.find((x) => x.v === roundTo)?.label}` : ''}`
    setRows((prev) => Object.fromEntries(lines.map((l): [string, RowState] => {
      const r = prev[l.id]
      // 先拿掉上一次套用留下的「整單 N 折」，重按套用不會疊兩行；剩下空的就回到預設「協議折價」
      const prevRat = (r?.rationale ?? '').split('\n').filter((x) => !/^整單 .+ 折/.test(x)).join('\n').trimEnd()
      return [l.id, {
        final_price: String(discPreview.prices[l.id] ?? baseOf(l)),
        rationale: `${prevRat || DEFAULT_RATIONALE}\n${note}`,
      }]
    })))
    setRoundOff(discPreview.roundOff)
    setMsg(`已套用${note}：定案後合計 ${money(discPreview.total)}。確認無誤後按「本案定案」寫回。`)
  }

  const appendEvidence = (l: QuoteLine) => {
    setMsg(null)
    const item = items.find((i) => i.id === l.item_id)
    if (!item) {
      setError('此列為臨時項目（或單價庫已無此品項），沒有可引用的佐證。')
      return
    }
    const idx = indexOf(item.index_id)
    const src = evidenceOf(idx?.source_id ?? item.evidence_id)
    const sentence = evidenceSentence(item, idx, src?.name)
    if (!sentence) {
      setError(`「${item.name}」尚未登錄佐證說明或指數連動，無可帶入的說詞。`)
      return
    }
    setError(null)
    const cur = rows[l.id]?.rationale ?? ''
    setRow(l.id, { rationale: cur.trim() ? `${cur.trimEnd()}\n${sentence}` : sentence })
  }

  const closeCase = async () => {
    if (!quote) return
    setBusy(true); setError(null); setMsg(null)
    // 核定後的 quote_lines／母單狀態前端已寫不進去，改由 RPC 在同一交易內完成
    // （寫回單價＋orig_price 留原價＋狀態＋round_off），不會出現半套結果。
    // 每一列都送，但只有「定案價 ≠ 現行單價」的列帶 response='discount'＋定案價＋理由；
    // 沒變價的列送全空，RPC 就不寫歷程、不改價，也不會把 orig_price 塞成等於現價。
    const payload = lines.map((l) => {
      const fin = finalOf(l)
      const changed = fin !== Number(l.unit_price)
      return changed
        ? {
            line_id: l.id,
            response: 'discount',
            final_price: fin,
            // 使用者把理由清空時仍記「協議折價」，歷程上不會出現沒有理由的改價
            rationale: rows[l.id]?.rationale.trim() || DEFAULT_RATIONALE,
          }
        : { line_id: l.id, response: null, final_price: null, rationale: '' }
    })
    const { data, error: e } = await supabase.rpc('close_quote_case', {
      p_quote_id: quote.id,
      p_rows: payload,
      p_round_off: roundOff,
    })
    setBusy(false)
    if (e) { setError(`定案失敗：${e.message}`); return }
    const res = (data ?? {}) as { round?: number; rows_logged?: number; lines_updated?: number }
    setConfirmClose(false)
    // lines_updated（db/29 起）＝實際改價的項數；只抹零不改單價時會是 0，屬正常。
    setMsg(`本案已定案：第 ${Number(res.round ?? 0)} 輪、改價 ${Number(res.lines_updated ?? 0)} 項。`)
    await load()
  }

  if (loading) return <div className="p-10 text-center text-ink-500">議價資料載入中…</div>

  if (!quote) {
    return (
      <div className="space-y-4">
        <PageHeader index="06" eyebrow="NEGOTIATION" title="議價" />
        <EmptyState
          title={error ?? '查無此報價單。'}
          hint="請確認網址上的單據編號，或從報價單列表重新進入。"
          action={<Link to="/" className="btn">回報價單列表</Link>}
        />
      </div>
    )
  }

  /**
   * 可操作＝在職副部長且單子是已核定（或舊制議價中）。不滿足就整頁唯讀：
   * 部長進得來看歷程與折扣，但看不到任何輸入框與按鈕。畫面藏按鈕不算權限，RPC 才是。
   */
  const editable = isViceDirector && (quote.status === 'approved' || quote.status === 'negotiating')
  const closed = quote.status === 'closed'
  const rounds = Array.from(new Set(negos.map((n) => Number(n.round)))).sort((a, b) => b - a)
  // 「院方還價」只有改版前（採購角色還在）的舊歷程才有值，新單不渲染這一欄
  const hasOffer = negos.some((n) => n.client_offer !== null)
  const nameOfLine = (lineId: string | null): string => {
    if (!lineId) return '整單'
    return lines.find((l) => l.id === lineId)?.name ?? '（項目已刪除）'
  }

  const pctTone = (p: number): string => (p > 20
    ? 'text-warn font-semibold'
    : p > 10 ? 'text-alert font-semibold' : 'text-ink-700')

  return (
    <div className="space-y-4">
      <PageHeader
        index="06"
        eyebrow="NEGOTIATION"
        title="議價"
        actions={(
          <>
            {/* PageHeader 的 actions 容器沒有 items-center，標籤自己包一層才不會被拉伸 */}
            <span className="flex min-w-0 items-center gap-2">
              <span className="tag min-w-0 max-w-full truncate">{quote.quote_no}</span>
              <StatusTag status={quote.status} />
            </span>
            <Link to={`/quote/${quote.id}`} className="btn">回單據</Link>
            <Link to={`/print/${quote.id}`} className="btn">列印</Link>
          </>
        )}
      />

      <div className="card">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="min-w-0">
            <div className="label">案名／工程地點</div>
            <div className="break-words text-ink-900">{quote.project || '—'}</div>
          </div>
          <div className="min-w-0">
            <div className="label">申請單位／現場窗口</div>
            <div className="break-words text-ink-900">{quote.dept || '—'}／{quote.contact || '—'}</div>
          </div>
          <div className="min-w-0">
            <div className="label">報價日期</div>
            <div className="text-ink-900">{quote.quote_date}</div>
          </div>
        </div>
      </div>

      {/* 整單的四個關鍵數字。改版前分散在頁首、右欄試算表與兩處低於底價提示，
          同一個數字最多出現三次；收斂成一排 Stat，右欄只留金額組成。 */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="原報價合計（含稅）" value={money(origTotals.total)} />
        <Stat label="定案後合計（含稅）" value={money(finalTotals.total)} />
        <Stat
          label="差額（讓價）"
          value={<span className={diff > 0 ? 'text-warn' : 'text-ink-700'}>{money(diff)}</span>}
        />
        {/* 與列印頁／單據頁／清單同一支 discountText；沒降價（含改版前定案的舊單）顯示 — */}
        <Stat
          label="折扣幅度"
          value={<span className="text-green">{discText || '—'}</span>}
        />
      </div>

      {closed && <Alert kind="info">本案已定案，金額以定案版為準。</Alert>}
      {!isViceDirector && !closed && (
        <Alert kind="info">議價減價與定案限行政管理部副部長；本頁僅供檢視。</Alert>
      )}
      {error && <Alert kind="error">{error}</Alert>}
      {msg && <Alert kind="success">{msg}</Alert>}
      {belowFloor.length > 0 && (
        <Alert kind="warn" title={`共 ${belowFloor.length} 項定案單價低於底價`}>
          請重新評估定案單價，或在該列的理由欄補強說明。
        </Alert>
      )}

      {/* 紅線 5：左欄放的是 sm:min-w-[1120px] 的寬表格，軌道用 1fr ＋ 子項 min-width:auto
          會被 min-content 撐開，.table-scroll 等於白設。軌道改 minmax(0,1fr)、子項補 min-w-0。 */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_310px]">
        <div className="min-w-0 space-y-4">
          <div className="card">
            <div className="card-title">逐項減價</div>
            {lines.length === 0 ? (
              /* action 的文字刻意與頁首那顆「回單據」不同：
                 Task 11 會逐頁比對可見按鈕文字有無重複。 */
              <EmptyState
                title="本單沒有任何項目"
                hint="回單據頁補上工料項目後，才能逐項議價。"
                action={<Link to={`/quote/${quote.id}`} className="btn">回單據頁補項目</Link>}
              />
            ) : (
              /* 手機：rwd-table 把每一列變成一張品項卡（欄位名由 data-label 長出來）；
                 sm 以上恢復寬表格，橫捲交給 .table-scroll，body 不會橫捲。 */
              <div className="table-scroll">
              <table className="rwd-table w-full border-collapse sm:min-w-[960px]">
                <thead>
                  <tr>
                    <th className="th w-10">項次</th>
                    <th className="th min-w-[150px]">品名</th>
                    <th className="th w-14">單位</th>
                    <th className="th num w-16">數量</th>
                    <th className="th num w-24">我方原單價</th>
                    <th className="th num w-28">定案單價</th>
                    <th className="th num w-20">讓步幅度</th>
                    <th className="th min-w-[230px]">理由／佐證</th>
                  </tr>
                </thead>
                <tbody>
                  {finalSections.map((sec) => (
                    <Fragment key={sec.key}>
                      <tr>
                        <td className="td bg-light/50 font-semibold text-deep" colSpan={8}>
                          {sec.title || '（未命名大項）'}
                        </td>
                      </tr>
                      {sec.lines.map((dl) => {
                        const l = lines.find((x) => x.id === dl.key)
                        if (!l) return null
                        const r = rows[l.id]
                        const orig = baseOf(l)
                        const fin = finalOf(l)
                        const pct = concessionPct(orig, fin)
                        const fp = floorOf(l.item_id)
                        const under = fp !== null && fin < fp
                        return (
                          <tr key={l.id} className={under ? 'bg-warn-bg' : undefined}>
                            <td className="td num" data-label="項次">{seqOf.get(dl.key)}</td>
                            {/* 品名不給 data-label：手機時佔滿整行，當成這張卡的標題 */}
                            <td className="td">
                              <div className="w-full min-w-0">
                                <div className="break-words text-ink-900">{l.name}</div>
                                {l.spec && (
                                  <div className="break-words text-[0.6875rem] text-ink-500">{l.spec}</div>
                                )}
                                {fp !== null && (
                                  <div className="text-[0.6875rem] text-ink-500">底價 {money(fp)}</div>
                                )}
                              </div>
                            </td>
                            <td className="td" data-label="單位">{l.unit}</td>
                            <td className="td num" data-label="數量">{Number(l.qty)}</td>
                            <td className="td num" data-label="我方原單價">{money(orig)}</td>
                            <td className="td" data-label="定案單價">
                              {/* 手機時這格是 flex 容器，多個子元素要先包成一個 */}
                              <div className="min-w-0 flex-1">
                                {editable ? (
                                  <input
                                    type="number"
                                    className="field num"
                                    value={r ? r.final_price : ''}
                                    onChange={(e) => setRow(l.id, { final_price: e.target.value })}
                                  />
                                ) : (
                                  <span className="num">{money(fin)}</span>
                                )}
                                {under && fp !== null && (
                                  <div className="mt-1 text-[0.6875rem] font-semibold text-warn">
                                    低於底價 {money(fp - fin)} 元
                                  </div>
                                )}
                              </div>
                            </td>
                            <td className={`td num ${pctTone(pct)}`} data-label="讓步幅度">
                              {pct.toFixed(1)}%
                            </td>
                            {/* 理由欄不給 data-label：手機時佔整行，欄位名改用行內小標。
                                唯讀時顯示 —：定案過的理由看下方議價歷程 */}
                            <td className="td">
                              <div className="w-full min-w-0">
                                <div className="label sm:hidden">理由／佐證</div>
                                {editable ? (
                                  <>
                                    <textarea
                                      className="field"
                                      rows={2}
                                      value={r ? r.rationale : ''}
                                      onChange={(e) => setRow(l.id, { rationale: e.target.value })}
                                      placeholder="協議折價；可補充讓價理由或帶入佐證"
                                    />
                                    <button
                                      type="button"
                                      className="btn mt-1 w-full text-sm sm:text-xs"
                                      onClick={() => appendEvidence(l)}
                                    >
                                      帶入佐證
                                    </button>
                                  </>
                                ) : (
                                  <span className="text-ink-500">—</span>
                                )}
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
            )}
          </div>

          <div className="card">
            <div className="card-title">議價歷程</div>
            {rounds.length === 0 ? (
              <EmptyState
                title="尚無議價紀錄"
                hint="副部長定案後，每一輪改價都會列在這裡。"
              />
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
                      {/* 手機：歷程也走 rwd-table 卡片化；sm 以上維持寬表格橫捲 */}
                      <div className="table-scroll">
                        <table className="rwd-table w-full border-collapse sm:min-w-[720px]">
                          <thead>
                            <tr>
                              <th className="th min-w-[140px]">品名</th>
                              {hasOffer && <th className="th num w-24">院方還價</th>}
                              <th className="th w-24">回應</th>
                              <th className="th num w-24">定案價</th>
                              <th className="th min-w-[240px]">理由</th>
                            </tr>
                          </thead>
                          <tbody>
                            {group.map((n) => (
                              <tr key={n.id}>
                                {/* 品名不給 data-label，手機時佔整行當卡片標題 */}
                                <td className="td">
                                  <div className="w-full min-w-0 break-words font-semibold text-ink-900 sm:font-normal">
                                    {nameOfLine(n.line_id)}
                                  </div>
                                </td>
                                {hasOffer && (
                                  <td className="td num" data-label="院方還價">
                                    {n.client_offer === null ? '—' : money(Number(n.client_offer))}
                                  </td>
                                )}
                                <td className="td" data-label="回應">
                                  {n.response ? RESPONSE_LABEL[n.response] : '—'}
                                </td>
                                <td className="td num" data-label="定案價">
                                  {n.final_price === null ? '—' : money(Number(n.final_price))}
                                </td>
                                <td className="td text-[0.75rem] text-ink-700">
                                  <div className="w-full min-w-0 whitespace-pre-wrap break-words">
                                    <span className="label sm:hidden">理由</span>
                                    {n.rationale || '—'}
                                  </div>
                                </td>
                              </tr>
                            ))}
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

        <aside className="space-y-4 lg:sticky lg:top-16 lg:self-start">
          <div className="card">
            <div className="card-title">金額組成</div>
            {/* 四個關鍵數字（原報價合計／定案後合計／差額／總讓步幅度）已收在頁首的 Stat 列，
                這裡只留算式組成，不重複顯示同一個數字。
                規格 B 節第 4 點要求「表格一律 .rwd-table 或 .table-scroll」——這一區本來就是
                label／value 的兩欄對照，不是資料表，改用 flex 列排掉表格，兩個規則都不用套。 */}
            <dl className="space-y-1 text-[0.8125rem]">
              {[
                { k: '原報價工程小計', v: money(origTotals.works) },
                { k: '定案後工程小計', v: money(finalTotals.works) },
                { k: `管理費 ${(mgmt * 100).toFixed(1)}%`, v: money(finalTotals.mgmt) },
                { k: `營業稅 ${(tax * 100).toFixed(1)}%`, v: money(finalTotals.tax) },
                ...(finalTotals.roundOff > 0
                  ? [{ k: '整單折讓（取整）', v: `-${money(finalTotals.roundOff)}` }]
                  : []),
              ].map((row) => (
                <div key={row.k} className="flex items-baseline gap-2 border-b border-ink-200 py-1">
                  <dt className="min-w-0 break-words text-ink-700">{row.k}</dt>
                  <dd className="num ml-auto min-w-0 text-ink-900">{row.v}</dd>
                </div>
              ))}
            </dl>

            {/* 手機：主要動作釘在畫面底部（.action-bar）；sm 以上改回整寬按鈕。
                「儲存本輪議價」已拿掉（2026-10-06 議價簡化）：減價只有定案這一步。
                不可操作（非副部長、或單子不在已核定）就整顆不渲染。 */}
            {editable && (
              <div className="action-bar mt-3 sm:flex-col">
                <button
                  type="button"
                  className="btn btn-danger w-full"
                  disabled={busy || !editable || lines.length === 0}
                  onClick={() => { setMsg(null); setError(null); setConfirmClose(true) }}
                >
                  {busy ? '處理中…' : '本案定案'}
                </button>
              </div>
            )}
          </div>

          {/* 整單打折取整：只給副部長。畫面藏起來不是權限，資料庫 trigger／RPC 才是。 */}
          {editable && lines.length > 0 && (
            <div className="card">
              <div className="card-title">整單打折取整</div>
              <div className="grid grid-cols-2 gap-2">
                <label className="min-w-0">
                  <span className="label">折數（折）</span>
                  <input
                    type="number"
                    className="field num"
                    min={1}
                    max={10}
                    step={0.5}
                    value={discZhe}
                    onChange={(e) => setDiscZhe(e.target.value)}
                  />
                </label>
                <label className="min-w-0">
                  <span className="label">合計取整</span>
                  <select className="field" value={roundTo} onChange={(e) => setRoundTo(Number(e.target.value))}>
                    {ROUND_TO.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                  </select>
                </label>
              </div>
              {discPreview ? (
                <dl className="mt-2 space-y-1 text-[0.8125rem]">
                  <div className="flex items-baseline gap-2">
                    <dt className="text-ink-700">打折後合計</dt>
                    <dd className="num ml-auto">{money(discPreview.total + discPreview.roundOff)}</dd>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <dt className="text-ink-700">抹零</dt>
                    <dd className="num ml-auto">-{money(discPreview.roundOff)}</dd>
                  </div>
                  <div className="flex items-baseline gap-2 border-t border-ink-200 pt-1 font-semibold">
                    <dt className="text-deep">定案合計</dt>
                    <dd className="num ml-auto text-deep">{money(discPreview.total)}</dd>
                  </div>
                </dl>
              ) : (
                <p className="mt-2 text-xs text-warn">折數請填 1～10 之間，例如 9 或 8.5。</p>
              )}
              <button
                type="button"
                className="btn mt-3 w-full"
                disabled={busy || !discPreview}
                onClick={applyDiscount}
              >
                套用到定案單價
              </button>
              <p className="mt-1 text-[0.6875rem] text-ink-500">
                以我方原單價為基準逐項打折（取整到元），零頭記為「整單折讓」印在報價總表。
                套用後若再手動改任一列定案單價，抹零會取消。
              </p>
            </div>
          )}

          {confirmClose && editable && (
            <ConfirmPanel
              tone="danger"
              title="確認定案"
              confirmLabel="確認定案並覆寫金額"
              busy={busy}
              onConfirm={() => void closeCase()}
              onCancel={() => setConfirmClose(false)}
            >
              <p>
                此動作會將本單 {lines.length} 項的報價單價
                <span className="font-semibold text-warn">直接覆寫為上方的定案單價</span>
                ，並把狀態改為「已定案」。原報價單價會另存保留，列印時以劃線並列顯示折扣幅度。
              </p>
              <p className="mt-2">
                定案後合計 <span className="num font-semibold text-deep">{money(finalTotals.total)}</span>
                ，較原報價讓價 {money(diff)} 元{discText ? `（${discText}）` : ''}。
              </p>
              {belowFloor.length > 0 && (
                <p className="mt-2 font-semibold text-warn">
                  注意：其中 {belowFloor.length} 項低於底價。
                </p>
              )}
            </ConfirmPanel>
          )}
        </aside>
      </div>
    </div>
  )
}
