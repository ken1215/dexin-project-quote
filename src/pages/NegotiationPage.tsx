import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useRefData } from '../context/RefDataContext'
import { calcTotals, concessionPct, evidenceSentence, money } from '../lib/calc'
import { STATUS_LABEL } from '../types'
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

/** 讓分組表格一次吐出多個 tr 而不破壞 tbody 結構 */
function RowGroup({ children }: { children: ReactNode }) {
  return <>{children}</>
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
  const origTotals = calcTotals(buildSections((l) => Number(l.unit_price)), mgmt, tax)
  const finalTotals = calcTotals(buildSections(finalOf), mgmt, tax)
  const diff = origTotals.total - finalTotals.total
  const totalPct = concessionPct(origTotals.total, finalTotals.total)

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
    const results = await Promise.all(lines.map((l) =>
      supabase.from('quote_lines').update({ unit_price: finalOf(l) }).eq('id', l.id)))
    const upErr = results.find((r) => r.error)?.error
    if (upErr) { setBusy(false); setError(`定案單價寫回失敗：${upErr.message}`); return }
    const { error: e } = await supabase.from('quotes')
      .update({ status: 'closed', updated_at: new Date().toISOString() })
      .eq('id', quote.id)
    setBusy(false)
    if (e) { setError(`狀態更新失敗（單價已寫回）：${e.message}`); return }
    setConfirmClose(false)
    setMsg('本案已定案：報價單單價已更新為定案單價，狀態改為「已定案」。')
    await load()
  }

  if (loading) return <div className="p-10 text-center text-ink-500">議價資料載入中…</div>

  if (!quote) {
    return (
      <div className="card">
        <div className="text-warn">{error ?? '查無此報價單。'}</div>
        <Link to="/" className="btn mt-3">回報價單列表</Link>
      </div>
    )
  }

  const rounds = Array.from(new Set(negos.map((n) => Number(n.round)))).sort((a, b) => b - a)
  const nameOfLine = (lineId: string | null): string => {
    if (!lineId) return '整單'
    return lines.find((l) => l.id === lineId)?.name ?? '（項目已刪除）'
  }

  let seq = 0

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <h2 className="text-[1.0625rem] font-semibold text-deep">議價回應</h2>
          <span className="tag max-w-full truncate">{quote.quote_no}</span>
          <span className="tag">{STATUS_LABEL[quote.status]}</span>
          <Link to={`/quote/${quote.id}`} className="btn ml-auto">回單據</Link>
          <Link to={`/print/${quote.id}`} className="btn">列印</Link>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="min-w-0">
            <div className="label">案名／工程地點</div>
            <div className="break-words text-ink-900">{quote.project || '—'}</div>
          </div>
          <div className="min-w-0">
            <div className="label">申請單位／現場窗口</div>
            <div className="break-words text-ink-900">{quote.dept || '—'}／{quote.contact || '—'}</div>
          </div>
          <div>
            <div className="label">報價日期</div>
            <div className="text-ink-900">{quote.quote_date}</div>
          </div>
          <div>
            <div className="label">原報價合計（含稅）</div>
            <div className="num text-[1.0625rem] font-semibold text-deep">{money(origTotals.total)}</div>
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
          <span className="text-xs text-ink-500">
            本輪將存為第 {nextRound} 輪（目前已有 {maxRound} 輪紀錄）
          </span>
          {belowFloor.length > 0 && (
            <span className="rounded-md bg-warn-bg px-2 py-1 text-sm font-semibold text-warn">
              共 {belowFloor.length} 項低於底價
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-warn/30 bg-warn-bg px-4 py-2 text-sm text-warn">
          {error}
        </div>
      )}
      {msg && (
        <div className="rounded-md border border-green/40 bg-green/10 px-4 py-2 text-sm text-green">
          {msg}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_310px]">
        <div className="space-y-4">
          <div className="card">
            <div className="card-title">逐項議價</div>
            {lines.length === 0 ? (
              <div className="text-ink-500">本單沒有任何項目。</div>
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
                  {buildSections(finalOf).map((sec) => (
                    <RowGroup key={sec.key}>
                      <tr>
                        <td className="td bg-light/50 font-semibold text-deep" colSpan={10}>
                          {sec.title || '（未命名大項）'}
                        </td>
                      </tr>
                      {sec.lines.map((dl) => {
                        const l = lines.find((x) => x.id === dl.key)
                        if (!l) return null
                        seq += 1
                        const r = rows[l.id]
                        const orig = Number(l.unit_price)
                        const fin = finalOf(l)
                        const pct = concessionPct(orig, fin)
                        const fp = floorOf(l.item_id)
                        const under = fp !== null && fin < fp
                        const pctClass = pct > 20
                          ? 'text-warn font-semibold'
                          : pct > 10 ? 'text-alert font-semibold' : 'text-ink-700'
                        return (
                          <tr key={l.id} className={under ? 'bg-warn-bg' : undefined}>
                            <td className="td num" data-label="項次">{seq}</td>
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
                            <td className={`td num ${pctClass}`} data-label="讓步幅度">
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
                    </RowGroup>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-title">議價歷程</div>
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
            <div className="card-title">整單試算</div>
            <table className="w-full border-collapse text-[0.8125rem]">
              <tbody>
                <tr>
                  <td className="td">原報價工程小計</td>
                  <td className="td num">{money(origTotals.works)}</td>
                </tr>
                <tr>
                  <td className="td">定案後工程小計</td>
                  <td className="td num">{money(finalTotals.works)}</td>
                </tr>
                <tr>
                  <td className="td">管理費 {(mgmt * 100).toFixed(1)}%</td>
                  <td className="td num">{money(finalTotals.mgmt)}</td>
                </tr>
                <tr>
                  <td className="td">營業稅 {(tax * 100).toFixed(1)}%</td>
                  <td className="td num">{money(finalTotals.tax)}</td>
                </tr>
                <tr>
                  <td className="td font-semibold text-ink-900">原報價合計</td>
                  <td className="td num font-semibold text-ink-900">{money(origTotals.total)}</td>
                </tr>
                <tr>
                  <td className="td font-semibold text-deep">定案後合計</td>
                  <td className="td num text-[0.9375rem] font-semibold text-deep">
                    {money(finalTotals.total)}
                  </td>
                </tr>
                <tr>
                  <td className="td">差額（讓價）</td>
                  <td className={`td num ${diff > 0 ? 'text-warn' : 'text-ink-700'}`}>
                    {money(diff)}
                  </td>
                </tr>
                <tr>
                  <td className="td">總讓步幅度</td>
                  <td className={`td num ${totalPct > 20
                    ? 'text-warn font-semibold'
                    : totalPct > 10 ? 'text-alert font-semibold' : 'text-ink-700'}`}
                  >
                    {totalPct.toFixed(1)}%
                  </td>
                </tr>
              </tbody>
            </table>

            {belowFloor.length > 0 && (
              <div className="mt-3 rounded-md border border-warn/30 bg-warn-bg px-3 py-2 text-[0.75rem] text-warn">
                共 {belowFloor.length} 項定案單價低於底價，請重新評估或補強理由。
              </div>
            )}

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
            <div className="card border-warn/40">
              <div className="card-title text-warn">確認定案</div>
              <p className="text-[0.8125rem] text-ink-700">
                此動作會將本單 {lines.length} 項的報價單價
                <span className="font-semibold text-warn">直接覆寫為上方的定案單價</span>
                ，並把狀態改為「已定案」。覆寫後列印出來的即為定案版金額，原報價金額不再保留。
              </p>
              <p className="mt-2 text-[0.8125rem] text-ink-700">
                定案後合計 <span className="num font-semibold text-deep">{money(finalTotals.total)}</span>
                ，較原報價讓價 {money(diff)} 元（{totalPct.toFixed(1)}%）。
              </p>
              {belowFloor.length > 0 && (
                <p className="mt-2 text-[0.8125rem] font-semibold text-warn">
                  注意：其中 {belowFloor.length} 項低於底價。
                </p>
              )}
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  className="btn btn-danger w-full sm:w-auto"
                  disabled={busy}
                  onClick={() => void closeCase()}
                >
                  確認定案並覆寫金額
                </button>
                <button
                  type="button"
                  className="btn w-full sm:w-auto"
                  disabled={busy}
                  onClick={() => setConfirmClose(false)}
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
