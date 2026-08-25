import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useRefData } from '../context/RefDataContext'
import { calcTotals, lineAmount, money } from '../lib/calc'
import {
  EVIDENCE_LABEL,
  type DraftSection, type EvidenceKind, type Quote, type QuoteLine,
  type QuoteSection, type QuoteStatus,
} from '../types'

/* ═══════════════════════════════════════════════════════════════
   立德新股份有限公司 → 聯新國際醫院　工程標單（列印／轉 PDF 版）
   版面依聯新國際醫療集團 CIS：深藍 #0054A7、亮藍 #008CD6、
   CIS 綠 #00A94F、淺藍 #D3EDFB，墨色 5 階，金額一律 tabular-nums。
   用色克制——整份文件只有「合計」列是滿版深藍，其餘靠淺藍底與細線。
   ═══════════════════════════════════════════════════════════════ */

/** 大項項次用中文數字 */
const CN = ['壹', '貳', '參', '肆', '伍', '陸', '柒', '捌', '玖', '拾']
const cnNo = (i: number): string => CN[i] ?? String(i + 1)

/** 右上角狀態印章：外框式，不填色（填色會蓋住底下的表頭資訊） */
const STAMP: Record<QuoteStatus, { label: string; cls: string }> = {
  draft: { label: '草　稿', cls: 'border-ink-500 text-ink-500' },
  submitted: { label: '待核可', cls: 'border-alert text-alert' },
  approved: { label: '已核可', cls: 'border-green text-green' },
  negotiating: { label: '議價中', cls: 'border-bright text-bright' },
  closed: { label: '定案版', cls: 'border-deep text-deep' },
  rejected: { label: '已退回', cls: 'border-warn text-warn' },
}

/** 佐證來源類別的標籤配色 */
const EV_TAG: Record<EvidenceKind, string> = {
  index: 'border-bright text-bright',
  law: 'border-green text-green',
  market: 'border-alert text-alert',
  history: 'border-ink-500 text-ink-500',
}

/** 工率依據轉中文——estimate 一律另外註明是估計值，不包裝成官方數據 */
const BASIS_LABEL: Record<string, string> = {
  history: '自家歷史成交',
  standard: '官方工料分析',
  estimate: '業界經驗估計',
}
const CONF_TAG: Record<string, { label: string; cls: string }> = {
  high: { label: '高', cls: 'border-green text-green' },
  medium: { label: '中', cls: 'border-ink-500 text-ink-500' },
  low: { label: '低', cls: 'border-alert text-alert' },
}

/** labor_productivity 一列（本頁自用形狀，未進 types.ts 的共用型別） */
interface LaborProductivity {
  id: string
  trade: string
  work_item: string
  unit: string
  output_per_manday: number
  crew: string
  basis: string
  source: string
  confidence: string
  note: string
}

/** 工率分析表的一列（已把同一工率的數量合併） */
interface ProdRow {
  id: string
  work_item: string
  unit: string
  qty: number
  output: number
  manDays: number
  /** 每單位工資成本（未加成） */
  unitCost: number
  /** 每單位報價工資（含加成係數） */
  unitQuote: number
  /** 應攤工資，用報價值 */
  wage: number
  basis: string
  confidence: string
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

/** 去掉小數尾巴的 0：3.00 → 3；0.65 → 0.65 */
function trim2(n: number): string {
  return String(Math.round(n * 100) / 100)
}

/* ── 版面共用 class ───────────────────────────────────────────── */

/** 螢幕上模擬一張 A4；列印時的留白交給 @page margin（見 index.css） */
const SHEET =
  'print-sheet mx-auto mb-8 flex w-full max-w-[210mm] flex-col bg-white ' +
  'px-[12mm] pt-[14mm] pb-[16mm] min-h-[297mm] shadow-md ring-1 ring-ink-200'

const TH = 'border border-ink-200 bg-light px-2 py-1.5 text-[11.5px] font-bold text-ink-700'
const TD = 'border border-ink-200 px-2 py-1 text-[12px] text-ink-900'
const TD_MUTED = 'border border-ink-200 px-2 py-1 text-[11px] text-ink-700'

/* ── 一張紙：頁首 + 內容 + 頁尾頁碼 ───────────────────────────── */

function Sheet(
  { quote, stamp, catalogVersion, feeRate, busRate, page, total, children }: {
    quote: Quote
    stamp: { label: string; cls: string }
    catalogVersion: string
    feeRate: number
    busRate: number
    page: number
    total: number
    children: ReactNode
  },
) {
  return (
    <section className={SHEET}>
      <SheetHeader
        quote={quote}
        stamp={stamp}
        catalogVersion={catalogVersion}
        feeRate={feeRate}
        busRate={busRate}
      />
      <div className="flex-1">{children}</div>
      <footer className="mt-6 border-t border-ink-200 pt-1.5 text-center text-[10px] tracking-[0.2em] text-ink-500">
        第 {page} 頁 / 共 {total} 頁
      </footer>
    </section>
  )
}

/** 表頭資訊的一格：標籤小字 ink-500、值 ink-900 */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 border-b border-ink-200 pb-[3px]">
      <span className="w-[5.5em] shrink-0 text-[10px] tracking-wide text-ink-500">{label}</span>
      <span className="text-[12px] text-ink-900">{value || '—'}</span>
    </div>
  )
}

/** 每一頁都要出現的頁首 */
function SheetHeader(
  { quote, stamp, catalogVersion, feeRate, busRate }: {
    quote: Quote
    stamp: { label: string; cls: string }
    catalogVersion: string
    feeRate: number
    busRate: number
  },
) {
  return (
    <header>
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[19px] font-bold leading-tight tracking-[0.16em] text-deep">
            立德新股份有限公司
          </div>
          <div className="mt-[3px] text-[10.5px] tracking-[0.14em] text-ink-500">
            德新物業 · 工務處
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="rounded-sm border border-deep px-3 py-[3px] text-[13px] font-semibold tracking-[0.3em] text-deep">
            工程標單
          </span>
          <span className="text-[11px] text-ink-700">
            單號　<span className="num text-ink-900">{quote.quote_no || '—'}</span>
          </span>
        </div>
      </div>

      {/* 深藍粗線 + 淺藍細線，做出雙線層次 */}
      <div className="mt-2 h-[2px] w-full bg-deep" />
      <div className="mt-[2px] h-[1px] w-full bg-light" />

      <div className="mt-3 flex items-start gap-4">
        <div className="grid flex-1 grid-cols-2 gap-x-6 gap-y-[5px]">
          <Field label="客戶名稱" value="聯新國際醫院" />
          <Field label="報價日期" value={quote.quote_date} />
          <Field label="工程地點" value={quote.project} />
          <Field label="聯絡人" value={quote.contact} />
          <Field label="申請單位" value={quote.dept} />
          <Field label="單價庫版本" value={catalogVersion} />
          <Field label="工程管理費" value={`${pct(feeRate)}%`} />
          <Field label="營業稅率" value={`${pct(busRate)}%`} />
        </div>
        <div
          className={
            'mt-1 shrink-0 rotate-[-8deg] rounded-lg border-2 px-3 py-[5px] text-center ' +
            'text-[14px] font-bold tracking-[0.18em] opacity-80 ' + stamp.cls
          }
        >
          {stamp.label}
        </div>
      </div>
    </header>
  )
}

/* ── 主元件 ───────────────────────────────────────────────────── */

export default function PrintPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const {
    items, settings, evidenceOf, mgmtFeeRate, taxRate, laborBase, laborMarkup,
    loading: refLoading,
  } = useRefData()

  const [quote, setQuote] = useState<Quote | null>(null)
  const [sections, setSections] = useState<QuoteSection[]>([])
  const [lines, setLines] = useState<QuoteLine[]>([])
  /** price_items.id → labor_productivity.id */
  const [prodOf, setProdOf] = useState<Record<string, string>>({})
  const [prods, setProds] = useState<LaborProductivity[]>([])
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
    const rows = (l.data ?? []) as QuoteLine[]
    setQuote(q.data as Quote)
    setSections((s.data ?? []) as QuoteSection[])
    setLines(rows)

    /* 工率：先一次拿到本單品項的 productivity_id，再一次 .in() 撈工率表。
       兩支查詢就結束，不做 N+1；工率表為空或尚未建置時整區不渲染。 */
    const itemIds = [...new Set(
      rows.map((r) => r.item_id).filter((v): v is string => Boolean(v)),
    )]
    let map: Record<string, string> = {}
    let lp: LaborProductivity[] = []
    if (itemIds.length) {
      const pi = await supabase.from('price_items').select('id,productivity_id').in('id', itemIds)
      const pairs = (pi.data ?? []) as { id: string; productivity_id: string | null }[]
      map = Object.fromEntries(
        pairs.filter((p) => p.productivity_id).map((p) => [p.id, String(p.productivity_id)]),
      )
      const pids = [...new Set(Object.values(map))]
      if (pids.length) {
        const r = await supabase.from('labor_productivity').select('*').in('id', pids)
        lp = (r.data ?? []) as LaborProductivity[]
      }
    }
    setProdOf(map)
    setProds(lp)
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
    const out: { name: string; note: string; kind: EvidenceKind | null }[] = []
    for (const l of lines) {
      if (!l.item_id) continue
      const it = items.find((x) => x.id === l.item_id)
      if (!it || !it.evidence_note) continue
      const key = it.name + '｜' + it.evidence_note
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ name: it.name, note: it.evidence_note, kind: evidenceOf(it.evidence_id)?.kind ?? null })
      if (out.length >= 8) break
    }
    return out
  }, [lines, items, evidenceOf])

  /** 工率分析：同一筆工率的數量合併成一列 */
  const prodRows: ProdRow[] = useMemo(() => {
    if (!prods.length) return []
    const byId = new Map(prods.map((p) => [p.id, p]))
    const qtyOf = new Map<string, number>()
    for (const l of lines) {
      const pid = l.item_id ? prodOf[l.item_id] : undefined
      if (!pid || !byId.has(pid)) continue
      qtyOf.set(pid, (qtyOf.get(pid) ?? 0) + (Number(l.qty) || 0))
    }
    const out: ProdRow[] = []
    for (const [pid, qty] of qtyOf) {
      const p = byId.get(pid)
      const output = Number(p?.output_per_manday) || 0
      if (!p || output <= 0) continue
      const manDays = qty / output
      out.push({
        id: p.id,
        work_item: p.work_item,
        unit: p.unit,
        qty,
        output,
        manDays,
        unitCost: Math.round(laborBase / output),
        unitQuote: Math.round((laborBase * laborMarkup) / output),
        wage: Math.round(manDays * laborBase * laborMarkup),
        basis: p.basis,
        confidence: p.confidence,
      })
    }
    return out
  }, [prods, prodOf, lines, laborBase, laborMarkup])

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
  /** 總表 1 頁 + 各大項明細各 1 頁 + 有工率資料時再 1 頁 */
  const totalPages = 1 + draftSections.length + (prodRows.length ? 1 : 0)
  const sheetProps = { quote, stamp, catalogVersion, feeRate, busRate, total: totalPages }

  return (
    <div className="min-h-screen bg-ink-50 py-6 print:bg-white print:py-0">
      {/* ── 螢幕工具列 ── */}
      <div className="no-print mx-auto mb-5 flex w-full max-w-[210mm] flex-wrap items-center gap-2 px-2">
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>
          列印 / 轉 PDF
        </button>
        <button type="button" className="btn" onClick={() => navigate(-1)}>返回</button>
        <span className="ml-auto flex items-center gap-2 text-xs text-ink-500">
          單號 <span className="num text-ink-900">{quote.quote_no || '—'}</span>
          <span className={'rounded-full border px-2 py-[1px] text-[11px] ' + stamp.cls}>
            {stamp.label.replace('　', '')}
          </span>
          <span>單價庫 {catalogVersion}</span>
        </span>
      </div>

      {/* ── 總表頁 ── */}
      <Sheet {...sheetProps} page={1}>
        <table className="mt-4 w-full border-collapse">
          <thead>
            <tr>
              <th className={TH + ' w-[8%]'}>項次</th>
              <th className={TH}>工程項目及說明</th>
              <th className={TH + ' w-[8%]'}>單位</th>
              <th className={TH + ' w-[8%]'}>數量</th>
              <th className={TH + ' w-[16%]'}>單價</th>
              <th className={TH + ' w-[17%]'}>複價</th>
            </tr>
          </thead>
          <tbody>
            {totals.sections.map((s, i) => (
              <tr key={s.key}>
                <td className={TD + ' text-center'}>{cnNo(i)}</td>
                <td className={TD}>{s.title}</td>
                <td className={TD + ' text-center'}>LOT</td>
                <td className={TD + ' num'}>1</td>
                <td className={TD + ' num'}>{money(s.subtotal)}</td>
                <td className={TD + ' num'}>{money(s.subtotal)}</td>
              </tr>
            ))}
            <tr>
              <td className={TD + ' text-center'}>{cnNo(totals.sections.length)}</td>
              <td className={TD}>工程管理費（{pct(feeRate)}%）</td>
              <td className={TD + ' text-center'}>LOT</td>
              <td className={TD + ' num'}>1</td>
              <td className={TD + ' num'}>{money(totals.mgmt)}</td>
              <td className={TD + ' num'}>{money(totals.mgmt)}</td>
            </tr>
            <tr>
              <td className={TD + ' text-right font-semibold text-ink-700'} colSpan={5}>小計</td>
              <td className={TD + ' num font-semibold'}>{money(totals.sub)}</td>
            </tr>
            <tr>
              <td className={TD + ' text-right font-semibold text-ink-700'} colSpan={5}>
                營業稅 {pct(busRate)}%
              </td>
              <td className={TD + ' num font-semibold'}>{money(totals.tax)}</td>
            </tr>
            {/* 全份文件唯一的滿版重色塊 */}
            <tr className="total-row">
              <td
                className="border border-deep bg-deep px-2 py-[7px] text-right text-[15px] font-bold tracking-[0.3em] text-white"
                colSpan={5}
              >
                合計
              </td>
              <td className="num border border-deep bg-deep px-2 py-[7px] text-[15px] font-bold text-white">
                {money(totals.total)}
              </td>
            </tr>
          </tbody>
        </table>

        <p className="mt-2 text-[11px] text-ink-500">
          本標單依單價庫 {catalogVersion} 計算，金額單位新臺幣元。★ 標示者為非標準單價之臨時項目，理由詳見明細頁。
        </p>

        {/* ── 佐證附註 ── */}
        {evidenceNotes.length > 0 && (
          <div className="mt-4 border-l-4 border-deep bg-light/50 px-4 py-3">
            <div className="text-[12.5px] font-bold tracking-wide text-deep">單價依據</div>
            <ol className="mt-2 space-y-1">
              {evidenceNotes.map((e, i) => (
                <li key={e.name + e.note} className="flex gap-2 text-[11.5px] leading-relaxed text-ink-700">
                  <span className="num w-4 shrink-0 text-ink-500">{i + 1}.</span>
                  {e.kind && (
                    <span
                      className={
                        'shrink-0 self-start rounded-sm border px-1.5 py-[1px] text-[10px] ' +
                        EV_TAG[e.kind]
                      }
                    >
                      {EVIDENCE_LABEL[e.kind]}
                    </span>
                  )}
                  <span>
                    <span className="font-semibold text-ink-900">{e.name}</span>：{e.note}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* ── 簽核欄 ── */}
        <div className="mt-10 grid grid-cols-3 gap-8">
          {['製表', '工務處主管核可', '日期'].map((t) => (
            <div key={t}>
              <div className="text-[10px] tracking-wide text-ink-500">{t}</div>
              <div className="mt-8 border-b border-ink-700" />
            </div>
          ))}
        </div>
      </Sheet>

      {/* ── 明細頁：每個工程大項一頁 ── */}
      {draftSections.map((sec, si) => {
        const subtotal = sec.lines.reduce((a, l) => a + lineAmount(l.unit_price, l.qty), 0)
        return (
          <Sheet {...sheetProps} page={si + 2} key={sec.key}>
            <table className="mt-4 w-full border-collapse">
              <thead>
                <tr>
                  <th className={TH + ' w-[7%]'}>項次</th>
                  <th className={TH}>工程項目及說明</th>
                  <th className={TH + ' w-[7%]'}>單位</th>
                  <th className={TH + ' w-[8%]'}>數量</th>
                  <th className={TH + ' w-[13%]'}>單價</th>
                  <th className={TH + ' w-[14%]'}>複價</th>
                  <th className={TH + ' w-[18%]'}>備註</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="border border-ink-200 bg-light px-2 py-1 text-center text-[12px] font-bold text-deep">
                    {cnNo(si)}
                  </td>
                  <td
                    className="border border-ink-200 bg-light px-2 py-1 text-[12px] font-bold tracking-wide text-deep"
                    colSpan={6}
                  >
                    {sec.title}
                  </td>
                </tr>
                {sec.lines.length === 0 && (
                  <tr>
                    <td className={TD + ' text-center text-ink-500'} colSpan={7}>本大項無項目</td>
                  </tr>
                )}
                {sec.lines.map((l, li) => {
                  const tone = l.is_custom ? ' text-warn' : ''
                  return (
                    <tr key={l.key}>
                      <td className={TD + ' text-center' + tone}>
                        {l.is_custom ? '★' : ''}{li + 1}
                      </td>
                      <td className={TD + tone}>
                        {l.name}
                        {l.spec && (
                          <span className={l.is_custom ? 'text-warn/70' : 'text-ink-500'}>　{l.spec}</span>
                        )}
                      </td>
                      <td className={TD + ' text-center' + tone}>{l.unit}</td>
                      <td className={TD + ' num' + tone}>{l.qty}</td>
                      <td className={TD + ' num' + tone}>{money(l.unit_price)}</td>
                      <td className={TD + ' num' + tone}>{money(lineAmount(l.unit_price, l.qty))}</td>
                      <td className={TD_MUTED + (l.is_custom ? ' text-warn' : '')}>
                        {l.is_custom ? l.reason : l.note}
                      </td>
                    </tr>
                  )
                })}
                <tr>
                  <td
                    className={TD + ' border-t-deep text-right font-bold text-ink-700'}
                    colSpan={5}
                  >
                    小計
                  </td>
                  <td className={TD + ' num border-t-deep font-bold'}>{money(subtotal)}</td>
                  <td className={TD + ' border-t-deep'} />
                </tr>
              </tbody>
            </table>
          </Sheet>
        )
      })}

      {/* ── 工率分析：一筆工率都對不到就整區不渲染 ── */}
      {prodRows.length > 0 && (
        <Sheet {...sheetProps} page={totalPages}>
          <h2 className="mt-4 border-b-2 border-deep pb-1 text-[14px] font-bold tracking-wide text-deep">
            工率分析（單價合理性說明）
          </h2>
          <table className="mt-3 w-full border-collapse">
            <thead>
              <tr>
                <th className={TH}>工項</th>
                <th className={TH + ' w-[6%]'}>單位</th>
                <th className={TH + ' w-[7%]'}>數量</th>
                <th className={TH + ' w-[12%]'}>工率（每工日產出）</th>
                <th className={TH + ' w-[8%]'}>所需工數</th>
                {/* 不印工資成本——這份文件要交給醫院採購，
                    把自家成本結構與利潤率印在上面等於邀請對方往成本押 */}
                <th className={TH + ' w-[12%]'}>工資單價</th>
                <th className={TH + ' w-[13%]'}>應攤工資</th>
                <th className={TH + ' w-[24%]'}>依據</th>
              </tr>
            </thead>
            <tbody>
              {prodRows.map((r) => {
                const conf = CONF_TAG[r.confidence]
                return (
                  <tr key={r.id}>
                    <td className={TD}>{r.work_item}</td>
                    <td className={TD + ' text-center'}>{r.unit}</td>
                    <td className={TD + ' num'}>{trim2(r.qty)}</td>
                    <td className={TD + ' num'}>{trim2(r.output)} {r.unit} / 工日</td>
                    <td className={TD + ' num'}>{r.manDays.toFixed(2)}</td>
                    <td className={TD + ' num'}>{money(r.unitQuote)}</td>
                    <td className={TD + ' num'}>{money(r.wage)}</td>
                    <td className={TD_MUTED}>
                      <span className="inline-flex flex-wrap items-center gap-1">
                        <span>{BASIS_LABEL[r.basis] ?? '—'}</span>
                        {conf && (
                          <span className={'rounded-sm border px-1 py-[1px] text-[10px] ' + conf.cls}>
                            {conf.label}
                          </span>
                        )}
                      </span>
                      {r.basis === 'estimate' && (
                        <span className="text-alert">（估計值，待實績校正）</span>
                      )}
                    </td>
                  </tr>
                )
              })}
              <tr>
                <td className={TD + ' border-t-deep text-right font-bold text-ink-700'} colSpan={7}>
                  應攤工資合計
                </td>
                <td className={TD + ' num border-t-deep font-bold'}>
                  {money(prodRows.reduce((a, r) => a + r.wage, 0))}
                </td>
                <td className={TD + ' border-t-deep'} />
              </tr>
            </tbody>
          </table>
          <p className="mt-3 text-[10.5px] leading-relaxed text-ink-500">
            工率係一名技術工於正常工時（8 小時）之產出基準，工資單價 = 技術工日薪 ÷ 工率。
            日薪水準參照臺北市政府工程預算參考單價之技術工單價，並以勞動部基本工資
            （時薪 196 元 × 8 小時 = 1,568 元）為法定下限，另含勞保、健保、勞退雇主提繳等法定負擔。
            夜間、休息日及例假日施作之加成依勞動基準法第 24、39 條計算。
          </p>
        </Sheet>
      )}
    </div>
  )
}
