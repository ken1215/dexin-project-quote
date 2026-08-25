import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useRefData } from '../context/RefDataContext'
import { calcTotals, lineAmount, money } from '../lib/calc'
import type { DraftSection, Quote, QuoteLine, QuoteSection, QuoteStatus } from '../types'

/** 大項項次用中文數字 */
const CN = ['壹', '貳', '參', '肆', '伍', '陸', '柒', '捌', '玖', '拾']
const cnNo = (i: number): string => CN[i] ?? String(i + 1)

/** 右上角狀態標記——只有這三種狀態要印在紙上 */
const STAMP: Partial<Record<QuoteStatus, string>> = {
  draft: '草稿',
  submitted: '待核可',
  closed: '定案版',
}

/** 0.05 → 「5」；0.045 → 「4.5」 */
function pct(rate: number): string {
  const v = (Number(rate) || 0) * 100
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

function toText(v: unknown, fallback: string): string {
  if (typeof v === 'string' && v.trim()) return v
  if (typeof v === 'number') return String(v)
  return fallback
}

/** 報價單頁首（總表頁與各明細頁共用） */
function SheetHeader({ quote }: { quote: Quote }) {
  const cell = 'border border-ink-200 px-2 py-1 text-[13px]'
  return (
    <>
      <div className="text-center">
        <div className="text-xl font-bold tracking-widest text-ink-900">立德新股份有限公司</div>
        <div className="mt-1 text-base tracking-[0.4em] text-ink-900">工程標單</div>
      </div>
      <table className="mt-3 w-full border-collapse">
        <tbody>
          <tr>
            <td className={cell}>客戶名稱：聯新國際醫院</td>
            <td className={cell}>報價日期：{quote.quote_date || '—'}</td>
          </tr>
          <tr>
            <td className={cell}>工程地點：{quote.project || '—'}</td>
            <td className={cell}>聯絡人：{quote.contact || '—'}</td>
          </tr>
          <tr>
            <td className={cell}>申請單位：{quote.dept || '—'}</td>
            <td className={cell}>單號：{quote.quote_no || '—'}</td>
          </tr>
        </tbody>
      </table>
    </>
  )
}

export default function PrintPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { items, settings, mgmtFeeRate, taxRate, loading: refLoading } = useRefData()

  const [quote, setQuote] = useState<Quote | null>(null)
  const [sections, setSections] = useState<QuoteSection[]>([])
  const [lines, setLines] = useState<QuoteLine[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!id) { setError('缺少報價單編號'); setLoading(false); return }
    setLoading(true)
    setError(null)
    const [q, s, l] = await Promise.all([
      supabase.from('quotes').select('*').eq('id', id).maybeSingle(),
      supabase.from('quote_sections').select('*').eq('quote_id', id).order('sort'),
      supabase.from('quote_lines').select('*').eq('quote_id', id).order('sort'),
    ])
    const firstErr = [q, s, l].find((r) => r.error)?.error
    if (firstErr) { setError(firstErr.message); setLoading(false); return }
    if (!q.data) { setError('查無此報價單'); setLoading(false); return }
    setQuote(q.data as Quote)
    setSections((s.data ?? []) as QuoteSection[])
    setLines((l.data ?? []) as QuoteLine[])
    setLoading(false)
  }, [id])

  useEffect(() => { void load() }, [load])

  /** 把 DB 形狀轉成 calcTotals 吃的 draft 形狀——金額公式只有 calc.ts 那一份 */
  const draftSections: DraftSection[] = useMemo(
    () => sections.map((s) => ({
      key: s.id,
      title: s.title,
      lines: lines.filter((l) => l.section_id === s.id).map((l) => ({
        key: l.id,
        item_id: l.item_id,
        labor_rate_id: l.labor_rate_id,
        name: l.name,
        spec: l.spec,
        unit: l.unit,
        unit_price: Number(l.unit_price),
        qty: Number(l.qty),
        is_custom: l.is_custom,
        reason: l.reason,
        note: l.note,
      })),
    })),
    [sections, lines],
  )

  /** 費率以單據上鎖定的為準，缺漏才退回目前設定值 */
  const feeRate = Number.isFinite(Number(quote?.mgmt_fee_rate))
    ? Number(quote?.mgmt_fee_rate)
    : mgmtFeeRate
  const busRate = Number.isFinite(Number(quote?.tax_rate))
    ? Number(quote?.tax_rate)
    : taxRate

  const totals = useMemo(
    () => calcTotals(draftSections, feeRate, busRate),
    [draftSections, feeRate, busRate],
  )

  /** 佐證附註：本單用到的品項中有 evidence_note 者，去重後最多 8 條 */
  const evidenceNotes = useMemo(() => {
    const seen = new Set<string>()
    const out: { name: string; note: string }[] = []
    for (const l of lines) {
      if (!l.item_id) continue
      const it = items.find((x) => x.id === l.item_id)
      if (!it || !it.evidence_note) continue
      const key = it.name + '｜' + it.evidence_note
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ name: it.name, note: it.evidence_note })
      if (out.length >= 8) break
    }
    return out
  }, [lines, items])

  const catalogVersion = toText(settings['catalog_version'], '（未設定）')

  if (loading || refLoading) {
    return <div className="p-10 text-center text-ink-500">載入報價單中…</div>
  }
  if (error || !quote) {
    return (
      <div className="p-10 text-center">
        <p className="text-warn">{error ?? '查無此報價單'}</p>
        <button type="button" className="btn mt-4" onClick={() => navigate(-1)}>返回</button>
      </div>
    )
  }

  const stamp = STAMP[quote.status]
  const page =
    'print-page mx-auto mb-6 w-full max-w-[210mm] bg-white p-[10mm] ' +
    'shadow-sm ring-1 ring-ink-200 print:mb-0 print:p-0 print:shadow-none print:ring-0'

  return (
    <div className="min-h-screen bg-ink-50 py-6 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex w-full max-w-[210mm] flex-wrap items-center gap-2 px-2">
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>列印</button>
        <button type="button" className="btn" onClick={() => navigate(-1)}>返回</button>
        <span className="ml-auto text-xs text-ink-500">
          單號 {quote.quote_no || '—'}　狀態：{stamp ?? quote.status}　單價庫 {catalogVersion}
        </span>
      </div>

      {/* ── 總表頁 ── */}
      <div className={page}>
        <div className="relative">
          {stamp && (
            <div className="absolute right-0 top-0 rounded border-2 border-warn px-3 py-1 text-sm font-bold tracking-widest text-warn">
              {stamp}
            </div>
          )}
          <SheetHeader quote={quote} />
        </div>

        <table className="mt-3 w-full border-collapse">
          <thead>
            <tr>
              <th className="th w-[8%]">項次</th>
              <th className="th">工程項目及說明</th>
              <th className="th w-[8%]">單位</th>
              <th className="th w-[8%]">數量</th>
              <th className="th w-[15%]">單價</th>
              <th className="th w-[16%]">複價</th>
            </tr>
          </thead>
          <tbody>
            {totals.sections.map((s, i) => (
              <tr key={s.key}>
                <td className="td text-center">{cnNo(i)}</td>
                <td className="td">{s.title}</td>
                <td className="td text-center">LOT</td>
                <td className="td num">1</td>
                <td className="td num">{money(s.subtotal)}</td>
                <td className="td num">{money(s.subtotal)}</td>
              </tr>
            ))}
            <tr>
              <td className="td text-center">{cnNo(totals.sections.length)}</td>
              <td className="td">工程管理費（{pct(feeRate)}%）</td>
              <td className="td text-center">LOT</td>
              <td className="td num">1</td>
              <td className="td num">{money(totals.mgmt)}</td>
              <td className="td num">{money(totals.mgmt)}</td>
            </tr>
            <tr>
              <td className="td text-center" colSpan={5}>小計</td>
              <td className="td num">{money(totals.sub)}</td>
            </tr>
            <tr>
              <td className="td text-center" colSpan={5}>營業稅 {pct(busRate)}%</td>
              <td className="td num">{money(totals.tax)}</td>
            </tr>
            <tr>
              <td className="td text-center font-bold" colSpan={5}>合計</td>
              <td className="td num font-bold">{money(totals.total)}</td>
            </tr>
          </tbody>
        </table>

        <div className="mt-3 space-y-2 text-[12px] leading-relaxed text-ink-700">
          <p>本報價依單價庫 {catalogVersion} 計算。★ 標示者為非標準單價之臨時項目。</p>
          {evidenceNotes.length > 0 && (
            <div>
              <div className="font-semibold text-ink-900">佐證附註</div>
              <ol className="mt-1 list-decimal space-y-0.5 pl-5">
                {evidenceNotes.map((e) => (
                  <li key={e.name + e.note}>※ {e.name}：{e.note}</li>
                ))}
              </ol>
            </div>
          )}
        </div>

        <div className="mt-8 flex flex-wrap gap-x-10 gap-y-3 text-[13px] text-ink-700">
          <span>製表：____________</span>
          <span>工務處主管核可：____________</span>
          <span>日期：____________</span>
        </div>
      </div>

      {/* ── 明細頁：每個大項一頁 ── */}
      {draftSections.map((sec, si) => {
        const subtotal = sec.lines.reduce((a, l) => a + lineAmount(l.unit_price, l.qty), 0)
        return (
          <div className={page} key={sec.key}>
            <SheetHeader quote={quote} />
            <table className="mt-3 w-full border-collapse">
              <thead>
                <tr>
                  <th className="th w-[8%]">項次</th>
                  <th className="th">工程項目及說明</th>
                  <th className="th w-[7%]">單位</th>
                  <th className="th w-[8%]">數量</th>
                  <th className="th w-[13%]">單價</th>
                  <th className="th w-[14%]">複價</th>
                  <th className="th w-[18%]">備註</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="td text-center font-bold">{cnNo(si)}</td>
                  <td className="td font-bold" colSpan={6}>{sec.title}</td>
                </tr>
                {sec.lines.length === 0 && (
                  <tr>
                    <td className="td text-center text-ink-500" colSpan={7}>本大項無項目</td>
                  </tr>
                )}
                {sec.lines.map((l, li) => (
                  <tr key={l.key}>
                    <td className="td text-center">{l.is_custom ? '★' : ''}{li + 1}</td>
                    <td className="td">
                      {l.name}
                      {l.spec && <span className="text-ink-500">　{l.spec}</span>}
                    </td>
                    <td className="td text-center">{l.unit}</td>
                    <td className="td num">{l.qty}</td>
                    <td className="td num">{money(l.unit_price)}</td>
                    <td className="td num">{money(lineAmount(l.unit_price, l.qty))}</td>
                    <td className="td text-[12px]">{l.is_custom ? l.reason : l.note}</td>
                  </tr>
                ))}
                <tr>
                  <td className="td text-center font-semibold" colSpan={5}>小計</td>
                  <td className="td num font-semibold">{money(subtotal)}</td>
                  <td className="td" />
                </tr>
              </tbody>
            </table>
          </div>
        )
      })}
    </div>
  )
}
