import { Fragment, useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useRefData } from '../context/RefDataContext'
import { calcTotals, concessionPct, evidenceSentence, money } from '../lib/calc'
import Alert from '../components/ui/Alert'
import ConfirmPanel from '../components/ui/ConfirmPanel'
import EmptyState from '../components/ui/EmptyState'
import PageHeader from '../components/ui/PageHeader'
import Stat from '../components/ui/Stat'
import StatusTag from '../components/ui/StatusTag'
import type {
  DraftLine, DraftSection, NegoResponse, Negotiation,
  PriceFloor, Quote, QuoteLine, QuoteSection,
} from '../types'

const RESPONSE_LABEL: Record<NegoResponse, string> = {
  accept: '接受',
  partial: '部分讓步',
  hold: '堅持原價',
}

interface RowState {
  client_offer: string
  response: NegoResponse | ''
  final_price: string
  rationale: string
}

const numOf = (s: string): number => {
  const v = Number(s)
  return Number.isFinite(v) ? v : 0
}

const timeText = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-TW', { hour12: false })
}

export default function NegotiationPage() {
  const { id } = useParams<{ id: string }>()
  const { profile, session } = useAuth()
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
    setSections((s.data ?? []) as QuoteSection[])
    setLines(ql)
    setNegos((n.data ?? []) as Negotiation[])
    setFloors((f.data ?? []) as PriceFloor[])
    setRows(Object.fromEntries(ql.map((x): [string, RowState] => [x.id, {
      client_offer: '',
      response: '',
      final_price: String(Number(x.unit_price)),
      rationale: '',
    }])))
    setLoading(false)
  }, [id])

  useEffect(() => { void load() }, [load])

  const reloadNegos = useCallback(async () => {
    if (!id) return
    const { data, error: e } = await supabase
      .from('negotiations').select('*').eq('quote_id', id).order('round')
    if (e) { setError(`議價歷程重新載入失敗：${e.message}`); return }
    setNegos((data ?? []) as Negotiation[])
  }, [id])

  const setRow = (lineId: string, patch: Partial<RowState>) => {
    setRows((prev) => ({ ...prev, [lineId]: { ...prev[lineId], ...patch } }))
  }

  const floorOf = (itemId: string | null): number | null => {
    if (!itemId) return null
    const f = floors.find((x) => x.item_id === itemId)
    return f ? Number(f.floor_price) : null
  }

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
  const origTotals = calcTotals(buildSections((l) => Number(l.unit_price)), mgmt, tax)
  const finalTotals = calcTotals(finalSections, mgmt, tax)
  const diff = origTotals.total - finalTotals.total
  const totalPct = concessionPct(origTotals.total, finalTotals.total)

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

  const maxRound = negos.reduce((a, n) => Math.max(a, Number(n.round) || 0), 0)
  const nextRound = maxRound + 1

  const onResponse = (l: QuoteLine, v: NegoResponse | '') => {
    const r = rows[l.id]
    if (v === 'accept') {
      const offer = r ? r.client_offer.trim() : ''
      setRow(l.id, { response: v, final_price: offer === '' ? (r ? r.final_price : '') : offer })
    } else if (v === 'hold') {
      setRow(l.id, { response: v, final_price: String(Number(l.unit_price)) })
    } else {
      setRow(l.id, { response: v })
    }
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

  const setStatusNegotiating = async () => {
    if (!quote) return
    setBusy(true); setError(null); setMsg(null)
    const { error: e } = await supabase.from('quotes')
      .update({ status: 'negotiating', updated_at: new Date().toISOString() })
      .eq('id', quote.id)
    setBusy(false)
    if (e) { setError(`狀態更新失敗：${e.message}`); return }
    setQuote({ ...quote, status: 'negotiating' })
    setMsg('已將本單狀態切換為「議價中」。')
  }

  const saveRound = async () => {
    if (!quote) return
    setError(null); setMsg(null)
    const targets = lines.filter((l) => {
      const r = rows[l.id]
      return Boolean(r) && (r.client_offer.trim() !== '' || r.response !== '')
    })
    if (!targets.length) {
      setError('沒有可儲存的內容：請至少為一列填入院方還價或選擇我方回應。')
      return
    }
    const payload = targets.map((l) => {
      const r = rows[l.id]
      return {
        quote_id: quote.id,
        line_id: l.id,
        round: nextRound,
        client_offer: r.client_offer.trim() === '' ? null : numOf(r.client_offer),
        response: r.response === '' ? null : r.response,
        final_price: r.final_price.trim() === '' ? null : numOf(r.final_price),
        rationale: r.rationale,
        responded_by: profile?.id ?? session?.user.id ?? null,
      }
    })
    setBusy(true)
    const { error: e } = await supabase.from('negotiations').insert(payload)
    setBusy(false)
    if (e) { setError(`儲存失敗：${e.message}`); return }
    setMsg(`第 ${nextRound} 輪議價已儲存，共 ${payload.length} 項。`)
    await reloadNegos()
  }

  const closeCase = async () => {
    if (!quote) return
    setBusy(true); setError(null); setMsg(null)
    // 核定後的 quote_lines／母單狀態前端已寫不進去，改由 RPC 在同一交易內完成，
    // 不會再出現「單價寫回一半、狀態沒改」的半套結果。
    // 畫面上每一列都送（含沒填的），由 RPC 決定哪幾列要寫歷程、哪幾列跳過不改價，
    // 前端不先過濾才不會漏掉使用者還沒按「儲存本輪議價」的內容。
    const payload = lines.map((l) => {
      const r = rows[l.id]
      const offer = r ? r.client_offer.trim() : ''
      const fin = r ? r.final_price.trim() : ''
      // 理由一律送原文，連空字串也照送——saveRound 寫進 negotiations 的就是原字串，
      // 這裡若把空值轉成 null，RPC 比對「與最新一筆完全相同」時 '' 與 null 不相等，
      // 先按「儲存本輪議價」再定案就會在歷程上多出一筆重複回合。
      // 空理由算不算「有內容」由 RPC 判定（契約允許 null／空字串），前端不代為判空。
      return {
        line_id: l.id,
        client_offer: offer === '' ? null : numOf(offer),
        response: r && r.response !== '' ? r.response : null,
        final_price: fin === '' ? null : numOf(fin),
        rationale: r ? r.rationale : '',
      }
    })
    const { data, error: e } = await supabase.rpc('close_quote_case', {
      p_quote_id: quote.id,
      p_rows: payload,
    })
    setBusy(false)
    if (e) { setError(`定案失敗：${e.message}`); return }
    const res = (data ?? {}) as { round?: number; rows_logged?: number; lines_updated?: number }
    setConfirmClose(false)
    // 不報 rows_logged：先按「儲存本輪議價」再定案時，RPC 會判定重複而全數跳過，
    // 顯示「寫入 0 筆」會被誤讀成失敗。
    setMsg(`本案已定案：第 ${Number(res.round ?? 0)} 輪、寫回 ${Number(res.lines_updated ?? 0)} 項單價。`)
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

  const rounds = Array.from(new Set(negos.map((n) => Number(n.round)))).sort((a, b) => b - a)
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

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn"
            disabled={busy || quote.status === 'negotiating' || quote.status === 'closed'}
            onClick={() => void setStatusNegotiating()}
          >
            切換為「議價中」
          </button>
          <span className="min-w-0 text-xs text-ink-500">
            本輪將存為第 {nextRound} 輪（目前已有 {maxRound} 輪紀錄）
          </span>
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
        <Stat
          label="總讓步幅度"
          value={<span className={pctTone(totalPct)}>{totalPct.toFixed(1)}%</span>}
        />
      </div>

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
            <div className="card-title">逐項議價</div>
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
              <table className="rwd-table w-full border-collapse sm:min-w-[1120px]">
                <thead>
                  <tr>
                    <th className="th w-10">項次</th>
                    <th className="th min-w-[150px]">品名</th>
                    <th className="th w-14">單位</th>
                    <th className="th num w-16">數量</th>
                    <th className="th num w-24">我方原單價</th>
                    <th className="th num w-28">院方還價</th>
                    <th className="th w-28">我方回應</th>
                    <th className="th num w-28">定案單價</th>
                    <th className="th num w-20">讓步幅度</th>
                    <th className="th min-w-[230px]">理由／佐證</th>
                  </tr>
                </thead>
                <tbody>
                  {finalSections.map((sec) => (
                    <Fragment key={sec.key}>
                      <tr>
                        <td className="td bg-light/50 font-semibold text-deep" colSpan={10}>
                          {sec.title || '（未命名大項）'}
                        </td>
                      </tr>
                      {sec.lines.map((dl) => {
                        const l = lines.find((x) => x.id === dl.key)
                        if (!l) return null
                        const r = rows[l.id]
                        const orig = Number(l.unit_price)
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
                            <td className="td" data-label="院方還價">
                              <input
                                type="number"
                                className="field num"
                                value={r ? r.client_offer : ''}
                                onChange={(e) => setRow(l.id, { client_offer: e.target.value })}
                              />
                            </td>
                            <td className="td" data-label="我方回應">
                              <select
                                className="field"
                                value={r ? r.response : ''}
                                onChange={(e) => onResponse(l, e.target.value as NegoResponse | '')}
                              >
                                <option value="">— 未回應 —</option>
                                <option value="accept">{RESPONSE_LABEL.accept}</option>
                                <option value="partial">{RESPONSE_LABEL.partial}</option>
                                <option value="hold">{RESPONSE_LABEL.hold}</option>
                              </select>
                            </td>
                            <td className="td" data-label="定案單價">
                              {/* 手機時這格是 flex 容器，多個子元素要先包成一個 */}
                              <div className="min-w-0 flex-1">
                                <input
                                  type="number"
                                  className="field num"
                                  value={r ? r.final_price : ''}
                                  onChange={(e) => setRow(l.id, { final_price: e.target.value })}
                                />
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
                            {/* 理由欄不給 data-label：手機時佔整行，欄位名改用行內小標 */}
                            <td className="td">
                              <div className="w-full min-w-0">
                                <div className="label sm:hidden">理由／佐證</div>
                                <textarea
                                  className="field"
                                  rows={2}
                                  value={r ? r.rationale : ''}
                                  onChange={(e) => setRow(l.id, { rationale: e.target.value })}
                                  placeholder="說明堅持原價或讓步的理由"
                                />
                                <button
                                  type="button"
                                  className="btn mt-1 w-full text-sm sm:text-xs"
                                  onClick={() => appendEvidence(l)}
                                >
                                  帶入佐證
                                </button>
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
                hint="填好上方逐項議價並按「儲存本輪議價」後，每一輪都會列在這裡。"
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
                              <th className="th num w-24">院方還價</th>
                              <th className="th w-24">我方回應</th>
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
                                <td className="td num" data-label="院方還價">
                                  {n.client_offer === null ? '—' : money(Number(n.client_offer))}
                                </td>
                                <td className="td" data-label="我方回應">
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
              ].map((row) => (
                <div key={row.k} className="flex items-baseline gap-2 border-b border-ink-200 py-1">
                  <dt className="min-w-0 break-words text-ink-700">{row.k}</dt>
                  <dd className="num ml-auto min-w-0 text-ink-900">{row.v}</dd>
                </div>
              ))}
            </dl>

            {/* 手機：主要動作釘在畫面底部（.action-bar）；sm 以上改回上下堆疊的整寬按鈕 */}
            <div className="action-bar mt-3 sm:flex-col">
              <button
                type="button"
                className="btn btn-primary w-full"
                disabled={busy || lines.length === 0}
                onClick={() => void saveRound()}
              >
                {busy ? '處理中…' : `儲存本輪議價（第 ${nextRound} 輪）`}
              </button>
              <button
                type="button"
                className="btn btn-danger w-full"
                disabled={busy || quote.status === 'closed' || lines.length === 0}
                onClick={() => { setMsg(null); setError(null); setConfirmClose(true) }}
              >
                本案定案
              </button>
            </div>
          </div>

          {confirmClose && (
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
                ，並把狀態改為「已定案」。覆寫後列印出來的即為定案版金額，原報價金額不再保留。
              </p>
              <p className="mt-2">
                定案後合計 <span className="num font-semibold text-deep">{money(finalTotals.total)}</span>
                ，較原報價讓價 {money(diff)} 元（{totalPct.toFixed(1)}%）。
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
