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

/** 會蓋報價專用章的狀態——全都是「主管已核可」之後的狀態。
    draft / submitted / rejected 一律不蓋：沒核可的單蓋章是嚴重問題。 */
const STAMPED_STATUS: readonly QuoteStatus[] = ['approved', 'negotiating', 'closed']

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
  /** 每單位工資牌價（未折） */
  unitList: number
  /** 每單位折後工資單價（牌價 × 物管合約折數） */
  unitQuote: number
  /** 應攤工資，用折後值 */
  wage: number
  /** 本列因物管合約折讓的金額（正數） */
  saving: number
  basis: string
  confidence: string
}

/** 折數寫成國人習慣的「幾折」：0.9 → 「9 折」、0.85 → 「8.5 折」；未打折（≧1）回傳 null */
function discountLabel(d: number): string | null {
  const n = Number(d)
  if (!Number.isFinite(n) || n >= 1) return null
  return `${Math.round(n * 1000) / 100} 折`
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

/** ISO 時間戳取日期部分（依本機時區，避免 UTC 直接切字串時差一天）；無法解析回傳空字串 */
function dateOnly(v: string | null): string {
  if (!v) return ''
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
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
          <Field label="現場聯絡窗口" value={quote.contact} />
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

  /**
   * 「返回」要看這頁是怎麼被打開的，否則按了沒反應。
   * 開單頁是用 window.open('#/print/…') 開新分頁，新分頁沒有上一頁，
   * 原本的 navigate(-1) 在那個情境下是完全無作用的（實際回報的災情）。
   *   - 由我方程式開的新分頁（window.opener 有值）→ 關掉這個分頁
   *   - 同一分頁內導覽過來的 → 回上一頁
   *   - 直接貼網址進來的 → 回首頁（Guard 會把採購導到他們的議價頁）
   */
  const openedInNewTab = typeof window !== 'undefined' && Boolean(window.opener)
  const goBack = useCallback(() => {
    if (openedInNewTab && !window.opener?.closed) { window.close(); return }
    if (window.history.length > 1) { navigate(-1); return }
    navigate('/')
  }, [navigate, openedInNewTab])
  const {
    items, settings, evidenceOf, mgmtFeeRate, taxRate, laborBase, laborDiscount,
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
  /** 報價專用章的 data URI；null＝不蓋（未核可、查無此設定、或載入失敗） */
  const [stampSrc, setStampSrc] = useState<string | null>(null)
  /** 列印是否附工率分析頁；預設開，記住上次選擇 */
  const [showProd, setShowProd] = useState(() => localStorage.getItem('print.prod') !== '0')

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

  /* 報價專用章（settings.quote_stamp，約 145KB 的 base64 PNG）。
     RefDataContext 刻意把它排除在共用設定之外，所以在這裡自己抓——
     而且只有「主管已核可之後」的狀態才發這支查詢，其餘狀態一個位元組都不下載。 */
  const needStamp = Boolean(quote && STAMPED_STATUS.includes(quote.status))

  useEffect(() => {
    if (!needStamp) { setStampSrc(null); return }
    let alive = true
    void (async () => {
      const { data, error: stampErr } = await supabase
        .from('settings').select('value').eq('key', 'quote_stamp').maybeSingle()
      if (!alive) return
      // 抓不到就安靜地不蓋章：不設 error、不擋渲染，標單照樣印得出來
      if (stampErr) { setStampSrc(null); return }
      const value = (data as { value?: unknown } | null)?.value
      setStampSrc(
        typeof value === 'string' && value.startsWith('data:image/') ? value : null,
      )
    })()
    return () => { alive = false }
  }, [needStamp])

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

  /**
   * 單價依據：**依來源歸類，一類一行**，不逐項印 evidence_note。
   *
   * evidence_note 是寫給自己看的推導過程（「組價 375 扣除明盒 13」「歷史成交 10 筆 100~150 元」），
   * 逐條印出去有兩個問題：紙面囉嗦，而且把歷史成交低點攤給採購看等於邀請對方往下押。
   * 這裡只講「依據哪個權威來源」與「涵蓋哪些品項」，該講的講清楚，不該給的不給。
   */
  const evidenceNotes = useMemo(() => {
    const byKind = new Map<EvidenceKind, { source: string; names: Set<string> }>()
    for (const l of lines) {
      if (!l.item_id) continue
      const it = items.find((x) => x.id === l.item_id)
      if (!it || !it.evidence_id) continue
      const src = evidenceOf(it.evidence_id)
      if (!src) continue
      const g = byKind.get(src.kind) ?? { source: '', names: new Set<string>() }
      // 同一類若有多個來源，取發布機關較權威者（官方指數／法規優先寫全名）
      if (!g.source) g.source = src.publisher ? `${src.publisher}「${src.name}」` : src.name
      g.names.add(it.name)
      byKind.set(src.kind, g)
    }
    const ORDER: EvidenceKind[] = ['index', 'law', 'market', 'history']
    const LEAD: Record<EvidenceKind, string> = {
      index: '依',
      law: '依',
      market: '參照',
      history: '依',
    }
    return ORDER.filter((k) => byKind.has(k)).map((kind) => {
      const g = byKind.get(kind)!
      const names = [...g.names]
      // 品項多就只列前三項加「等 N 項」，紙面不要被品名淹沒
      const label = names.length <= 3
        ? names.join('、')
        : `${names.slice(0, 3).join('、')} 等 ${names.length} 項`
      return {
        kind,
        text: `${LEAD[kind]}${kind === 'history' ? '本公司歷年供應本院之實績單價' : g.source}計價`,
        items: label,
      }
    })
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
        unitList: Math.round(laborBase / output),
        unitQuote: Math.round((laborBase * laborDiscount) / output),
        wage: Math.round(manDays * laborBase * laborDiscount),
        saving: Math.round(manDays * laborBase * (1 - laborDiscount)),
        basis: p.basis,
        confidence: p.confidence,
      })
    }
    return out
  }, [prods, prodOf, lines, laborBase, laborDiscount])

  /** 物業管理合約替院方折讓掉的工資總額（正數；未設折扣時為 0） */
  const laborSaving = prodRows.reduce((a, r) => a + r.saving, 0)

  const catalogVersion = toText(settings['catalog_version'], '（未設定）')

  if (loading || refLoading) {
    return <div className="p-10 text-center text-ink-500">載入報價單中…</div>
  }
  if (error || !quote) {
    return (
      <div className="p-10 text-center">
        <p className="text-warn">{error ?? '查無此報價單'}</p>
        <button type="button" className="btn mt-4" onClick={goBack}>{openedInNewTab ? '關閉' : '返回'}</button>
      </div>
    )
  }

  const stamp = STAMP[quote.status]
  /** 兩道條件都成立才蓋章：狀態在已核可之後 ＋ 印章圖真的拿到了 */
  const showStamp = needStamp && Boolean(stampSrc)
  const approvedDate = dateOnly(quote.approved_at)
  /** 總表 1 頁 + 各大項明細各 1 頁 + 有工率資料時再 1 頁 */
  const withProd = showProd && prodRows.length > 0
  const totalPages = 1 + draftSections.length + (withProd ? 1 : 0)
  const sheetProps = { quote, stamp, catalogVersion, feeRate, busRate, total: totalPages }

  return (
    <div className="min-h-screen bg-ink-50 py-6 print:bg-white print:py-0">
      {/* ── 螢幕工具列 ── */}
      <div className="no-print mx-auto mb-5 flex w-full max-w-[210mm] flex-wrap items-center gap-2 px-2">
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>
          列印 / 轉 PDF
        </button>
        <button type="button" className="btn" onClick={goBack}>{openedInNewTab ? '關閉此分頁' : '返回'}</button>
        {prodRows.length > 0 && (
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-700">
            <input
              type="checkbox"
              checked={showProd}
              onChange={(e) => {
                setShowProd(e.target.checked)
                localStorage.setItem('print.prod', e.target.checked ? '1' : '0')
              }}
            />
            附工率分析頁
          </label>
        )}
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
                <li key={e.kind} className="flex gap-2 text-[11.5px] leading-relaxed text-ink-700">
                  <span className="num w-4 shrink-0 text-ink-500">{i + 1}.</span>
                  <span
                    className={
                      'shrink-0 self-start rounded-sm border px-1.5 py-[1px] text-[10px] ' +
                      EV_TAG[e.kind]
                    }
                  >
                    {EVIDENCE_LABEL[e.kind]}
                  </span>
                  <span>
                    <span className="text-ink-900">{e.text}</span>
                    <span className="text-ink-500">（{e.items}）</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* ── 簽核欄 ──
            要蓋章時把簽名格加高到 27mm（實體章 34×29.7mm 才容得下），
            印章以 absolute 疊在「工務處主管核可」這一格內，下緣壓過簽名線。 */}
        <div className="mt-10 grid grid-cols-3 gap-8">
          {['製表', '工務處主管核可', '日期'].map((t) => {
            const isApproval = t === '工務處主管核可'
            return (
              <div key={t}>
                <div className="text-[10px] tracking-wide text-ink-500">{t}</div>
                <div
                  className={
                    'relative border-b border-ink-700 ' + (showStamp ? 'h-[27mm]' : 'mt-8')
                  }
                >
                  {isApproval && showStamp && stampSrc && (
                    <img
                      src={stampSrc}
                      alt=""
                      className={
                        'pointer-events-none absolute left-1/2 -bottom-[4mm] w-[34mm] ' +
                        'h-auto -translate-x-1/2 opacity-[0.88]'
                      }
                      onError={() => setStampSrc(null)}
                    />
                  )}
                </div>
                {isApproval && showStamp && approvedDate && (
                  <div className="mt-[7mm] text-center text-[10px] text-ink-500">
                    核可日期：<span className="num">{approvedDate}</span>
                  </div>
                )}
              </div>
            )
          })}
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
      {withProd && (
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
                {/* 牌價與折後單價並列——折讓是給院方看的好處，不是自家底牌，
                    印出來才能讓物業管理合約的價值出現在每一張報價單上 */}
                <th className={TH + ' w-[11%]'}>工資牌價/單位</th>
                <th className={TH + ' w-[11%]'}>折後單價</th>
                <th className={TH + ' w-[12%]'}>應攤工資</th>
                <th className={TH + ' w-[18%]'}>依據</th>
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
                    <td className={TD + ' num text-ink-500'}>{money(r.unitList)}</td>
                    <td className={TD + ' num text-deep'}>{money(r.unitQuote)}</td>
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
              {/* 這一列是整份文件的賣點：物管合約替院方省下多少工資 */}
              {laborSaving > 0 && (
                <tr>
                  <td className={TD + ' text-right font-bold text-green'} colSpan={7}>
                    物業管理合約優惠折讓
                  </td>
                  <td className={TD + ' num font-bold text-green'}>-{money(laborSaving)}</td>
                  <td className={TD} />
                </tr>
              )}
            </tbody>
          </table>
          <p className="mt-3 text-[10.5px] leading-relaxed text-ink-500">
            工率係一名技術工於正常工時（8 小時）之產出基準，工資單價 = 技術工日薪 ÷ 工率。
            技術工日薪牌價 NT${money(laborBase)}／工，係參照臺北市政府工程預算參考單價之技術工單價
            （375 元／時 × 8 小時）；
            {discountLabel(laborDiscount)
              ? `因貴院已訂有物業管理合約，本報價之工資按牌價 ${discountLabel(laborDiscount)} 計價。`
              : '本報價之工資按牌價計價。'}
            法定下限為勞動部基本工資時薪 196 元 × 8 小時 = 1,568 元／工。
            夜間、休息日及例假日之加成依勞動基準法第 24、39 條計算。
          </p>
        </Sheet>
      )}
    </div>
  )
}
