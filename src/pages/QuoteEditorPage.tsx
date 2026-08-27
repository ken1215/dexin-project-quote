import { Fragment, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useRefData } from '../context/RefDataContext'
import { calcTotals, laborListPrice, laborPrice, lineAmount, money, validateQuote } from '../lib/calc'
import type {
  DraftLine, DraftQuote, DraftSection, LaborRate,
  PriceItem, Quote, QuoteLine, QuoteSection, QuoteStatus,
} from '../types'
import { STATUS_LABEL } from '../types'

const CN = ['壹', '貳', '參', '肆', '伍', '陸', '柒', '捌', '玖', '拾']

const uid = (): string => crypto.randomUUID()

/** 取本機日期（不要用 toISOString，那是 UTC 會差一天） */
/** 申請單位候選：取自歷史報價單「聯絡人」欄實際寫法，依出現次數排序。非清單內的可直接手動輸入 */
const DEPT_OPTIONS = [
  '工務處-黃耀輝',
  '工務處-陳垣興',
  '工務處-劉泳慶',
  '工務處-游文豪',
  '工務處-陳俊育',
  '工務處-游文政',
  '工務處-卓英翰',
  '工務處',
]

const today = (): string => new Date().toLocaleDateString('sv-SE')

/** 折數寫成國人習慣的「幾折」：0.9 → 「9 折」、0.85 → 「8.5 折」；未打折（≧1）回傳 null */
const discountLabel = (d: number): string | null => {
  const n = Number(d)
  if (!Number.isFinite(n) || n >= 1) return null
  return `${Math.round(n * 1000) / 100} 折`
}

const blankSection = (): DraftSection => ({ key: uid(), title: '', lines: [] })

const emptyDraft = (): DraftQuote => ({
  project: '', dept: '', contact: '', quote_date: today(),
  status: 'draft', sections: [blankSection()],
})

const toDraftLine = (l: QuoteLine): DraftLine => ({
  key: l.id,
  item_id: l.item_id,
  labor_rate_id: l.labor_rate_id,
  name: l.name,
  spec: l.spec,
  unit: l.unit,
  unit_price: Number(l.unit_price) || 0,
  qty: Number(l.qty) || 0,
  is_custom: l.is_custom,
  reason: l.reason,
  note: l.note,
})

export default function QuoteEditorPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { isManager, isDeptHead, isAdmin } = useAuth()
  const {
    categories, items, laborRates, laborBase, laborDiscount, mgmtFeeRate, taxRate,
    categoryOf, loading: refLoading, error: refError,
  } = useRefData()

  const [draft, setDraft] = useState<DraftQuote>(emptyDraft)
  const [loading, setLoading] = useState<boolean>(Boolean(id))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [issues, setIssues] = useState<string[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [reviewNote, setReviewNote] = useState('')
  const [cat, setCat] = useState<string>('all')
  const [kw, setKw] = useState('')

  /* ── 載入既有單據 ───────────────────────────────────────── */
  useEffect(() => {
    if (!id) { setDraft(emptyDraft()); setReviewNote(''); setLoading(false); return }
    let cancelled = false
    setLoading(true)
    setErr(null)
    void (async () => {
      const q = await supabase.from('quotes').select('*').eq('id', id).maybeSingle()
      if (cancelled) return
      if (q.error) { setErr(`讀取報價單失敗：${q.error.message}`); setLoading(false); return }
      const quote = q.data as Quote | null
      if (!quote) { setErr('找不到這張報價單，或您沒有檢視權限。'); setLoading(false); return }

      const [s, l] = await Promise.all([
        supabase.from('quote_sections').select('*').eq('quote_id', id).order('sort'),
        supabase.from('quote_lines').select('*').eq('quote_id', id).order('sort'),
      ])
      if (cancelled) return
      const sub = s.error ?? l.error
      if (sub) { setErr(`讀取單據明細失敗：${sub.message}`); setLoading(false); return }

      const secs = (s.data ?? []) as QuoteSection[]
      const lines = (l.data ?? []) as QuoteLine[]
      setDraft({
        id: quote.id,
        quote_no: quote.quote_no,
        project: quote.project,
        dept: quote.dept,
        contact: quote.contact,
        quote_date: quote.quote_date,
        status: quote.status,
        sections: secs.length
          ? secs.map((sec) => ({
              key: sec.id,
              title: sec.title,
              lines: lines.filter((x) => x.section_id === sec.id).map(toDraftLine),
            }))
          : [blankSection()],
      })
      setReviewNote(quote.review_note)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [id])

  /* ── 權限／唯讀 ─────────────────────────────────────────── */
  // 議價中／已定案的單一律凍結（主管也不例外）：本頁存檔是「整段砍掉重寫」，
  // 明細列會換成新 id，negotiations.line_id 會被 on delete cascade 連帶清光。
  // 這兩種狀態的金額異動只能在議價頁做。
  const frozen = draft.status === 'negotiating' || draft.status === 'closed'
  // 退回(rejected)單開放建立者修改重送（存檔時狀態會改回 draft，見 saveStatus）
  const editableByOwner = draft.status === 'draft' || draft.status === 'rejected'
  const locked = frozen || (!editableByOwner && !isManager)
  /** 第一關：工務處長核可待審單（副部長也看得到這組按鈕，可選擇越級核定） */
  const canReviewL1 = (isDeptHead || isAdmin) && draft.status === 'submitted'
  /** 第二關：副部長核定處長已過的單 */
  const canReviewL2 = isAdmin && draft.status === 'approved_l1'
  const canReview = canReviewL1 || canReviewL2
  /** 存檔時實際寫入的狀態：退回單一經修改存檔即回到草稿 */
  const saveStatus: QuoteStatus = draft.status === 'rejected' ? 'draft' : draft.status

  /* ── 參考資料索引 ───────────────────────────────────────── */
  const itemById = useMemo(
    () => new Map<string, PriceItem>(items.map((i) => [i.id, i])),
    [items],
  )
  const defaultRate: LaborRate | undefined = useMemo(
    () => [...laborRates].sort((a, b) => Number(a.multiplier) - Number(b.multiplier))[0],
    [laborRates],
  )
  const rateById = useMemo(
    () => new Map<string, LaborRate>(laborRates.map((r) => [r.id, r])),
    [laborRates],
  )

  const visibleItems = useMemo(() => {
    const q = kw.trim().toLowerCase()
    return items.filter((i) => {
      if (!i.active) return false
      if (cat !== 'all' && i.category_id !== cat) return false
      if (!q) return true
      return `${i.name} ${i.spec}`.toLowerCase().includes(q)
    })
  }, [items, cat, kw])

  /* ── 草稿變更（一律 immutable，key 用 DraftLine.key） ────── */
  const patchDraft = (patch: Partial<DraftQuote>) => setDraft((d) => ({ ...d, ...patch }))

  const patchSection = (sk: string, patch: Partial<DraftSection>) =>
    setDraft((d) => ({
      ...d,
      sections: d.sections.map((s) => (s.key === sk ? { ...s, ...patch } : s)),
    }))

  const patchLine = (sk: string, lk: string, patch: Partial<DraftLine>) =>
    setDraft((d) => ({
      ...d,
      sections: d.sections.map((s) =>
        s.key === sk
          ? { ...s, lines: s.lines.map((l) => (l.key === lk ? { ...l, ...patch } : l)) }
          : s,
      ),
    }))

  const removeLine = (sk: string, lk: string) =>
    setDraft((d) => ({
      ...d,
      sections: d.sections.map((s) =>
        s.key === sk ? { ...s, lines: s.lines.filter((l) => l.key !== lk) } : s,
      ),
    }))

  const addSection = () =>
    setDraft((d) => ({ ...d, sections: [...d.sections, blankSection()] }))

  const removeSection = (sk: string) =>
    setDraft((d) =>
      d.sections.length <= 1 ? d : { ...d, sections: d.sections.filter((s) => s.key !== sk) },
    )

  const addCustomLine = (sk: string) =>
    setDraft((d) => ({
      ...d,
      sections: d.sections.map((s) =>
        s.key === sk
          ? {
              ...s,
              lines: [...s.lines, {
                key: uid(), item_id: null, labor_rate_id: null,
                name: '', spec: '', unit: '式', unit_price: 0, qty: 1,
                is_custom: true, reason: '', note: '',
              }],
            }
          : s,
      ),
    }))

  /** 加入標準品項：依 category.section_title 自動找／自動開大項 */
  const addItem = (item: PriceItem) => {
    const c = categoryOf(item.category_id)
    const title = (c?.section_title || c?.name || '其他工程').trim()
    // 「牌價 × 物管合約折數 × 時段」只適用於按「工」計價的工資項（技術工日薪）。
    // 單價庫裡許多 cost_type='labor' 的品項是按 台/米/m²/座 的包裝勞務價
    // （例：鷹架 55,000/座、室內機安裝 3,300/台、管路標示 9/米），
    // 這些必須用品項自己的 std_price，套日薪公式會整個報錯價。
    const isLabor = item.cost_type === 'labor' && item.unit === '工'
    const rate = isLabor ? defaultRate : undefined
    // 工資項一律走「牌價 × 物管合約折數 × 時段」，不能拿牌價 laborBase 直接當報價
    const price = isLabor ? laborPrice(laborBase, rate, laborDiscount) : Number(item.std_price) || 0

    setDraft((d) => {
      let sections = d.sections
      let idx = sections.findIndex((s) => s.title.trim() === title)
      if (idx < 0) {
        // 尚未命名且空白的大項就地改名，否則新開一個
        const blank = sections.findIndex((s) => !s.title.trim() && s.lines.length === 0)
        if (blank >= 0) {
          sections = sections.map((s, i) => (i === blank ? { ...s, title } : s))
          idx = blank
        } else {
          sections = [...sections, { key: uid(), title, lines: [] }]
          idx = sections.length - 1
        }
      }
      const target = sections[idx]
      const hit = target.lines.find((l) => !l.is_custom && l.item_id === item.id)
      const lines = hit
        ? target.lines.map((l) => (l.key === hit.key ? { ...l, qty: (Number(l.qty) || 0) + 1 } : l))
        : [...target.lines, {
            key: uid(),
            item_id: item.id,
            labor_rate_id: rate ? rate.id : null,
            name: item.name,
            spec: item.spec,
            unit: item.unit,
            unit_price: price,
            qty: 1,
            is_custom: false,
            reason: '',
            note: '',
          }]
      return {
        ...d,
        sections: sections.map((s, i) => (i === idx ? { ...s, lines } : s)),
      }
    })
  }

  const changeLineRate = (sk: string, lk: string, rateId: string) => {
    const r = rateById.get(rateId)
    patchLine(sk, lk, {
      labor_rate_id: r ? r.id : null,
      unit_price: laborPrice(laborBase, r, laborDiscount),
    })
  }

  /* ── 合計 ───────────────────────────────────────────────── */
  const totals = useMemo(
    () => calcTotals(draft.sections, mgmtFeeRate, taxRate),
    [draft.sections, mgmtFeeRate, taxRate],
  )

  /* ── 存檔 ───────────────────────────────────────────────── */
  /** 資料庫層 check constraint 的前置把關，避免存檔時吃到看不懂的 DB 錯誤 */
  const dbGuard = (): string[] => {
    const bad: string[] = []
    if (!draft.project.trim()) bad.push('工程地點／案名為必填')
    draft.sections.forEach((s, si) => {
      s.lines.forEach((l, li) => {
        const at = `${CN[si] || si + 1}、第 ${li + 1} 項`
        if (!(Number(l.qty) > 0)) bad.push(`${at} 數量必須大於 0`)
        if (!l.name.trim()) bad.push(`${at} 未填品名`)
        if (l.is_custom && !l.reason.trim()) bad.push(`${at} 臨時項目必須填寫理由`)
      })
    })
    return bad
  }

  const persist = async (nextStatus: QuoteStatus): Promise<string | null> => {
    setErr(null)
    setNotice(null)
    setSaving(true)
    try {
      let quoteId = draft.id ?? ''
      const head = {
        project: draft.project.trim(),
        dept: draft.dept.trim(),
        contact: draft.contact.trim(),
        quote_date: draft.quote_date || today(),
        status: nextStatus,
      }

      if (!quoteId) {
        const no = await supabase.rpc('next_quote_no')
        if (no.error) { setErr(`取得單號失敗：${no.error.message}`); return null }
        const quoteNo = typeof no.data === 'string' ? no.data : ''
        if (!quoteNo) { setErr('取得單號失敗：伺服器未回傳單號。'); return null }

        const ins = await supabase.from('quotes')
          .insert({ ...head, quote_no: quoteNo, mgmt_fee_rate: mgmtFeeRate, tax_rate: taxRate })
          .select('id').single()
        if (ins.error) { setErr(`建立報價單失敗：${ins.error.message}`); return null }
        quoteId = (ins.data as { id: string }).id
        setDraft((d) => ({ ...d, id: quoteId, quote_no: quoteNo, status: nextStatus }))
      } else {
        const upd = await supabase.from('quotes')
          .update({ ...head, updated_at: new Date().toISOString() })
          .eq('id', quoteId)
          .select('id')
        if (upd.error) { setErr(`更新報價單失敗：${upd.error.message}`); return null }
        // RLS 擋下時不會報錯、只會匹配 0 筆——這裡必須擋住，
        // 否則下面會把明細刪掉卻寫不回去（母單狀態沒改成功，子表寫入會被政策拒絕）
        if (((upd.data ?? []) as { id: string }[]).length === 0) {
          setErr('更新報價單失敗：目前狀態下您沒有修改此單的權限。')
          return null
        }
        setDraft((d) => ({ ...d, status: nextStatus }))
      }

      // 已有議價紀錄的單不可在此重寫明細：明細會換新 id，
      // negotiations.line_id 的 on delete cascade 會把議價歷程整批帶走。
      const ng = await supabase.from('negotiations')
        .select('id', { count: 'exact', head: true }).eq('quote_id', quoteId)
      if (ng.error) { setErr(`議價紀錄檢查失敗：${ng.error.message}`); return null }
      if ((ng.count ?? 0) > 0) {
        setErr('本單已有議價紀錄，於此儲存會清除議價歷程，已擋下；金額異動請至「議價」頁處理。')
        return null
      }

      // 單據很小，不做 diff：整段砍掉重寫（quote_lines 有 on delete cascade）
      const del = await supabase.from('quote_sections').delete().eq('quote_id', quoteId)
      if (del.error) { setErr(`清除舊明細失敗：${del.error.message}`); return null }

      const secRows = draft.sections.map((s, i) => ({
        id: uid(),
        quote_id: quoteId,
        title: s.title.trim() || `工程項目 ${i + 1}`,
        sort: i,
      }))
      if (secRows.length) {
        const rs = await supabase.from('quote_sections').insert(secRows)
        if (rs.error) { setErr(`寫入工程大項失敗：${rs.error.message}`); return null }
      }

      const lineRows = draft.sections.flatMap((s, si) =>
        s.lines.map((l, li) => ({
          quote_id: quoteId,
          section_id: secRows[si].id,
          item_id: l.item_id,
          labor_rate_id: l.labor_rate_id,
          name: l.name.trim(),
          spec: l.spec,
          unit: l.unit,
          unit_price: Number(l.unit_price) || 0,
          qty: Number(l.qty) || 0,
          is_custom: l.is_custom,
          reason: l.reason.trim(),
          note: l.note,
          sort: li,
        })),
      )
      if (lineRows.length) {
        const rl = await supabase.from('quote_lines').insert(lineRows)
        if (rl.error) { setErr(`寫入明細失敗：${rl.error.message}`); return null }
      }

      if (!draft.id) navigate(`/quote/${quoteId}`, { replace: true })
      return quoteId
    } finally {
      setSaving(false)
    }
  }

  const onSaveDraft = async () => {
    const bad = dbGuard()
    setIssues(bad)
    if (bad.length) return
    const savedId = await persist(saveStatus)
    if (savedId) setNotice(draft.status === 'rejected' ? '已儲存，狀態回到草稿，修改後可重新送審。' : '已儲存。')
  }

  const onSubmit = async () => {
    const bad = validateQuote(draft)
    setIssues(bad)
    if (bad.length) return
    const savedId = await persist('submitted')
    if (savedId) setNotice('已送出，等候工務處長核可。')
  }

  const onPrint = async () => {
    const bad = dbGuard()
    setIssues(bad)
    if (bad.length) return
    const savedId = locked ? draft.id ?? null : await persist(saveStatus)
    if (savedId) window.open(`#/print/${savedId}`)
  }

  /**
   * 簽核往下一關推。approved_by / approved_l1_at 這些戳記一律由資料庫的
   * quotes_transition_guard trigger 蓋，前端不寫——前端寫得進去就代表偽造得了。
   * 合法性也在 trigger 裡擋，這裡送錯狀態會直接收到資料庫的錯誤。
   */
  const advance = async (next: QuoteStatus, okMsg: string) => {
    if (!draft.id) return
    setErr(null); setNotice(null); setSaving(true)
    const r = await supabase.from('quotes')
      .update({ status: next, updated_at: new Date().toISOString() })
      .eq('id', draft.id).select('id')
    setSaving(false)
    if (r.error) { setErr(`核可失敗：${r.error.message}`); return }
    // RLS 擋下時 Supabase 不報錯只回 0 筆，所以要看實際影響筆數
    if (!r.data?.length) { setErr('核可失敗：權限不足，或此單狀態已被他人變更。'); return }
    patchDraft({ status: next })
    setNotice(okMsg)
  }

  const onApproveL1 = () => advance('approved_l1', '已核可，送行政管理部副部長核定。')
  const onApproveFinal = () =>
    advance('approved',
      draft.status === 'submitted'
        ? '已越級核定（未經工務處長），系統已留痕。'
        : '已核定，可送醫院採購。')

  const onReject = async () => {
    if (!draft.id) return
    if (!reviewNote.trim()) { setIssues(['退回時必須填寫退回意見']); return }
    setIssues([]); setErr(null); setNotice(null); setSaving(true)
    const r = await supabase.from('quotes').update({
      status: 'rejected',
      review_note: reviewNote.trim(),
      updated_at: new Date().toISOString(),
    }).eq('id', draft.id).select('id')
    setSaving(false)
    if (r.error) { setErr(`退回失敗：${r.error.message}`); return }
    if (!r.data?.length) { setErr('退回失敗：權限不足，或此單狀態已被他人變更。'); return }
    patchDraft({ status: 'rejected' })
    setNotice('已退回開單人。')
  }

  /* ── 畫面 ───────────────────────────────────────────────── */
  if (loading || refLoading) {
    return <div className="p-10 text-center text-ink-500">載入中…</div>
  }

  return (
    <div className="space-y-4">
      {/* 訊息區 */}
      {(err || refError) && (
        <div className="rounded-md border border-warn/40 bg-warn-bg px-4 py-2.5 text-sm text-warn">
          {err || `參考資料載入失敗：${refError}`}
        </div>
      )}
      {issues.length > 0 && (
        <div className="rounded-md border border-warn/40 bg-warn-bg px-4 py-2.5 text-sm text-warn">
          <div className="mb-1 font-semibold">請先修正以下問題：</div>
          <ul className="list-disc pl-5">
            {issues.map((m) => <li key={m}>{m}</li>)}
          </ul>
        </div>
      )}
      {notice && (
        <div className="rounded-md border border-green/40 bg-green/5 px-4 py-2.5 text-sm text-green">
          {notice}
        </div>
      )}
      {locked && (
        <div className="rounded-md border border-ink-200 bg-ink-50 px-4 py-2.5 text-sm text-ink-500">
          {frozen
            ? '本單已進入議價／定案階段，在此改寫明細會清除議價紀錄，故已鎖定；金額異動請至「議價」頁處理。'
            : '本單已送審，如需修改請洽核決主管退回。'}
        </div>
      )}
      {draft.status === 'rejected' && reviewNote && (
        <div className="rounded-md border border-alert/40 bg-warn-bg px-4 py-2.5 text-sm text-alert">
          退回意見：{reviewNote}
        </div>
      )}

      {/* 表頭 */}
      <div className="card">
        <div className="card-title flex flex-wrap items-center gap-2">
          <span>報價單表頭</span>
          {draft.quote_no && <span className="tag">{draft.quote_no}</span>}
          <span className="tag">{STATUS_LABEL[draft.status]}</span>
        </div>
        {/* 手機單欄、平板兩欄、桌機四欄（mobile-first 疊法，別只給 md 值） */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4">
          <div className="sm:col-span-2">
            <label className="label">工程地點／案名（必填）</label>
            <input
              className="field" value={draft.project} disabled={locked}
              placeholder="例：聯新國際醫院 3F 復健科天花板修繕"
              onChange={(e) => patchDraft({ project: e.target.value })}
            />
          </div>
          <div>
            <label className="label">申請單位</label>
            {/* 上面選常用的、下面直接打，兩個都通。input+datalist 在已有值時會被自己的
                內容濾掉選項、換人要先清空，不直覺，所以拆成兩個控制項。 */}
            <select
              className="field" value="" disabled={locked}
              onChange={(e) => { if (e.target.value) patchDraft({ dept: e.target.value }) }}
            >
              <option value="">— 從常用名單選 —</option>
              {DEPT_OPTIONS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <input
              className="field mt-1" value={draft.dept} disabled={locked}
              placeholder="或直接輸入"
              onChange={(e) => patchDraft({ dept: e.target.value })}
            />
          </div>
          <div>
            <label className="label">工程現場聯絡窗口</label>
            <input
              className="field" value={draft.contact} disabled={locked}
              onChange={(e) => patchDraft({ contact: e.target.value })}
            />
          </div>
          <div>
            <label className="label">報價日期</label>
            <input
              className="field" type="date" value={draft.quote_date} disabled={locked}
              onChange={(e) => patchDraft({ quote_date: e.target.value })}
            />
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        {/* min-w-0 不能省：grid/flex 子項的 min-width 預設是 auto，會被裡面
            min-w-[860px] 的明細表撐開，.table-scroll 的 overflow 就白設了 */}
        <div className="min-w-0 space-y-4">
          {/* 品項挑選。挑選區走亮藍系、明細區走深藍系——兩塊都是白卡片時，
              同仁常把「還在挑」當成「已經加進單子」 */}
          {!locked && (
            <div className="card border-l-4 border-l-bright bg-bright/[0.04]">
              <div className="card-title border-bright/30 text-bright">選擇工料項目</div>
              <div className="mb-2 flex flex-wrap gap-1">
                <button
                  type="button"
                  onClick={() => setCat('all')}
                  className={`btn ${cat === 'all' ? 'btn-primary' : ''}`}
                >全部</button>
                {categories.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setCat(c.id)}
                    className={`btn ${cat === c.id ? 'btn-primary' : ''}`}
                  >{c.name}</button>
                ))}
              </div>
              <input
                className="field mb-2"
                placeholder="搜尋品名或規格…"
                value={kw}
                onChange={(e) => setKw(e.target.value)}
              />
              {/* 挑選區是「顯示＋一顆加入鈕」，手機轉卡片（rwd-table）比橫捲好按 */}
              <div className="max-h-[60vh] overflow-auto rounded-md border border-ink-200 sm:max-h-72">
                <table className="rwd-table w-full border-collapse">
                  <thead className="sticky top-0">
                    <tr>
                      <th className="th text-left">品名／規格</th>
                      <th className="th w-16">單位</th>
                      <th className="th w-24">標準單價</th>
                      <th className="th w-20">加入</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleItems.map((it, ii) => (
                      <Fragment key={it.id}>
                      {/* 清單已依 sort 排好，子分類必為連續區塊——變了就插一列標題 */}
                      {it.subgroup && it.subgroup !== visibleItems[ii - 1]?.subgroup && (
                        <tr>
                          <td
                            className="border border-ink-200 bg-bright/10 px-2 py-1 text-[12px] font-semibold text-bright"
                            colSpan={4}
                          >
                            {it.subgroup}
                          </td>
                        </tr>
                      )}
                      <tr className="hover:bg-light/40">
                        <td className="td">
                          {/* 卡片模式下 td 會變成 flex，內容要包一層才會維持原本的直向堆疊 */}
                          <div className="min-w-0">
                            <span className="break-words text-ink-900">{it.name}</span>
                            {it.needs_area && (
                              <span className="ml-1.5 rounded bg-alert/10 px-1.5 py-0.5 text-[11px] text-alert">
                                待轉 m²
                              </span>
                            )}
                            {it.spec && (
                              <div className="break-words text-[11px] text-ink-500">{it.spec}</div>
                            )}
                          </div>
                        </td>
                        <td className="td text-center" data-label="單位">{it.unit}</td>
                        <td className="td num" data-label="標準單價">{money(it.std_price)}</td>
                        <td className="td text-center">
                          <button
                            type="button"
                            className="btn w-full sm:w-auto"
                            onClick={() => addItem(it)}
                          >加入</button>
                        </td>
                      </tr>
                      </Fragment>
                    ))}
                    {visibleItems.length === 0 && (
                      <tr>
                        <td className="td text-center text-ink-500" colSpan={4}>
                          沒有符合條件的品項。
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 明細 */}
          {draft.sections.map((sec, si) => (
            <div className="card border-l-4 border-l-deep" key={sec.key}>
              <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-ink-200 pb-2">
                <span className="text-[15px] font-semibold text-deep">
                  {CN[si] || si + 1}、
                </span>
                <input
                  className="field w-full sm:max-w-xs"
                  value={sec.title}
                  disabled={locked}
                  placeholder="工程大項名稱"
                  onChange={(e) => patchSection(sec.key, { title: e.target.value })}
                />
                <span className="num ml-auto text-sm text-ink-700">
                  小計 {money(totals.sections[si]?.subtotal ?? 0)}
                </span>
                {!locked && (
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={draft.sections.length <= 1}
                    onClick={() => removeSection(sec.key)}
                  >刪除大項</button>
                )}
              </div>

              {/* 明細列每格都是輸入框，屬密集輸入型：手機用 .table-scroll 橫捲，
                  不轉卡片（轉了反而更難連續輸入數量／單價） */}
              <div className="table-scroll">
                <table className="w-full min-w-[860px] border-collapse">
                  <thead>
                    <tr>
                      <th className="th w-12">項次</th>
                      <th className="th text-left">工程項目及說明</th>
                      <th className="th w-16">單位</th>
                      <th className="th w-20">數量</th>
                      <th className="th w-24">單價</th>
                      <th className="th w-28">複價</th>
                      <th className="th w-48 text-left">備註／理由</th>
                      <th className="th w-14">刪除</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sec.lines.map((l, li) => {
                      const src = l.item_id ? itemById.get(l.item_id) : undefined
                      const isLabor = !l.is_custom
                        && ((src?.cost_type === 'labor' && src.unit === '工') || l.labor_rate_id !== null)
                      const rate = l.labor_rate_id ? rateById.get(l.labor_rate_id) : undefined
                      return (
                        <tr key={l.key} className={l.is_custom ? 'bg-warn-bg' : undefined}>
                          <td className="td text-center">
                            {l.is_custom && <span className="mr-0.5 text-warn">★</span>}
                            {li + 1}
                          </td>
                          <td className="td">
                            {l.is_custom ? (
                              <input
                                className="field"
                                value={l.name}
                                disabled={locked}
                                placeholder="臨時項目品名"
                                onChange={(e) => patchLine(sec.key, l.key, { name: e.target.value })}
                              />
                            ) : (
                              <>
                                <div className="break-words text-ink-900">{l.name}</div>
                                {l.spec && <div className="break-words text-[11px] text-ink-500">{l.spec}</div>}
                              </>
                            )}
                            {isLabor && (
                              <div className="mt-1 flex flex-wrap items-center gap-2">
                                <select
                                  className="field max-w-[9rem]"
                                  value={l.labor_rate_id ?? ''}
                                  disabled={locked}
                                  onChange={(e) => changeLineRate(sec.key, l.key, e.target.value)}
                                >
                                  <option value="">（未選時段）</option>
                                  {laborRates.map((r) => (
                                    <option key={r.id} value={r.id}>
                                      {r.name}（×{r.multiplier}）
                                    </option>
                                  ))}
                                </select>
                                {rate?.legal_basis && (
                                  <span className="text-[11px] text-ink-500">{rate.legal_basis}</span>
                                )}
                                <span className="text-[11px] text-ink-500">
                                  牌價 {money(laborListPrice(laborBase, rate))}
                                  {discountLabel(laborDiscount)
                                    ? ` × 物管合約 ${discountLabel(laborDiscount)}`
                                    : '（物管合約未設折扣）'}
                                </span>
                              </div>
                            )}
                          </td>
                          <td className="td text-center">
                            {l.is_custom ? (
                              <input
                                className="field"
                                value={l.unit}
                                disabled={locked}
                                onChange={(e) => patchLine(sec.key, l.key, { unit: e.target.value })}
                              />
                            ) : l.unit}
                          </td>
                          <td className="td">
                            <input
                              className="field num"
                              type="number"
                              min={0}
                              step="any"
                              value={l.qty}
                              disabled={locked}
                              onChange={(e) => patchLine(sec.key, l.key, { qty: Number(e.target.value) })}
                            />
                          </td>
                          <td className="td">
                            <input
                              className="field num"
                              type="number"
                              min={0}
                              value={l.unit_price}
                              readOnly={!l.is_custom}
                              disabled={locked}
                              title={l.is_custom ? undefined : '標準品項單價由單價庫控管，不可修改'}
                              onChange={(e) => {
                                if (!l.is_custom) return
                                patchLine(sec.key, l.key, { unit_price: Number(e.target.value) })
                              }}
                            />
                          </td>
                          <td className="td num">{money(lineAmount(l.unit_price, l.qty))}</td>
                          <td className="td">
                            <input
                              className="field"
                              value={l.is_custom ? l.reason : l.note}
                              disabled={locked}
                              placeholder={l.is_custom ? '為何需臨時項目（必填）' : '備註'}
                              onChange={(e) =>
                                patchLine(sec.key, l.key,
                                  l.is_custom ? { reason: e.target.value } : { note: e.target.value })
                              }
                            />
                          </td>
                          <td className="td text-center">
                            <button
                              type="button"
                              className="btn btn-danger"
                              disabled={locked}
                              onClick={() => removeLine(sec.key, l.key)}
                            >刪</button>
                          </td>
                        </tr>
                      )
                    })}
                    {sec.lines.length === 0 && (
                      <tr>
                        <td className="td text-center text-ink-500" colSpan={8}>
                          尚無項目，請由上方「選擇工料項目」加入。
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {!locked && (
                <div className="mt-2">
                  <button
                    type="button"
                    className="btn btn-danger w-full sm:w-auto"
                    onClick={() => addCustomLine(sec.key)}
                  >
                    ＋ 臨時項目（非標準品）
                  </button>
                </div>
              )}
            </div>
          ))}

          {!locked && (
            <button type="button" className="btn w-full sm:w-auto" onClick={addSection}>
              ＋ 新增工程大項
            </button>
          )}
        </div>

        {/* 合計與動作 */}
        <div className="space-y-4 lg:sticky lg:top-16 lg:self-start">
          <div className="card">
            <div className="card-title">金額合計</div>
            <table className="w-full">
              <tbody>
                <tr>
                  <td className="py-1 text-ink-700">工程小計</td>
                  <td className="num py-1 text-ink-900">{money(totals.works)}</td>
                </tr>
                <tr>
                  <td className="py-1 text-ink-700">
                    工程管理費 {(mgmtFeeRate * 100).toFixed(1)}%
                  </td>
                  <td className="num py-1 text-ink-900">{money(totals.mgmt)}</td>
                </tr>
                <tr className="border-t border-ink-200">
                  <td className="py-1 text-ink-700">小計</td>
                  <td className="num py-1 text-ink-900">{money(totals.sub)}</td>
                </tr>
                <tr>
                  <td className="py-1 text-ink-700">營業稅 {(taxRate * 100).toFixed(1)}%</td>
                  <td className="num py-1 text-ink-900">{money(totals.tax)}</td>
                </tr>
                <tr className="border-t border-ink-200">
                  <td className="py-1.5 font-semibold text-deep">合計</td>
                  <td className="num py-1.5 text-[16px] font-semibold text-deep">
                    {money(totals.total)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* 手機上「儲存草稿／送核可／兩關核可」這四顆已經在釘底動作列了，
              這裡一律 hidden sm:inline-flex，不要讓同一顆按鈕在一支手機上出現兩次。
              釘底列沒有的（列印預覽、越級核定、退回）才在手機顯示。 */}
          <div className="card space-y-2">
            <div className="card-title hidden sm:block">動作</div>
            {!locked && (
              <>
                <button
                  type="button" className="btn hidden w-full sm:inline-flex" disabled={saving}
                  onClick={() => void onSaveDraft()}
                >{saving ? '儲存中…' : '儲存草稿'}</button>
                {(draft.status === 'draft' || draft.status === 'rejected') && (
                  <button
                    type="button" className="btn btn-primary hidden w-full sm:inline-flex" disabled={saving}
                    onClick={() => void onSubmit()}
                  >{draft.status === 'rejected' ? '修正後重新送審' : '送工務處長核可'}</button>
                )}
              </>
            )}
            <button
              type="button" className="btn w-full" disabled={saving}
              onClick={() => void onPrint()}
            >列印預覽</button>

            {canReview && (
              <div className="space-y-2 border-t border-ink-200 pt-2">
                {canReviewL1 && (
                  <button
                    type="button" className="btn btn-primary hidden w-full sm:inline-flex" disabled={saving}
                    onClick={() => void onApproveL1()}
                  >{isDeptHead ? '核可（第一關）' : '代處長核可（第一關）'}</button>
                )}
                {canReviewL2 && (
                  <button
                    type="button" className="btn btn-primary hidden w-full sm:inline-flex" disabled={saving}
                    onClick={() => void onApproveFinal()}
                  >核定（第二關·可送採購）</button>
                )}
                {/* 處長請假時不要卡單：副部長從待審單直接核定，trigger 會記 l1_skipped */}
                {canReviewL1 && isAdmin && (
                  <button
                    type="button" className="btn w-full" disabled={saving}
                    onClick={() => void onApproveFinal()}
                  >越級直接核定</button>
                )}
                <div>
                  <label className="label">退回意見（退回時必填）</label>
                  <textarea
                    className="field" rows={3} value={reviewNote}
                    onChange={(e) => setReviewNote(e.target.value)}
                  />
                </div>
                <button
                  type="button" className="btn btn-danger w-full" disabled={saving}
                  onClick={() => void onReject()}
                >退回</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 手機專用的釘底動作列：右側「動作」卡在手機會被推到整頁最下面，
          同仁在工地捲到一半想送審得先捲到底。這裡把最主要的兩顆鈕釘在
          畫面底部（sm 以上隱藏，桌機仍只有右側那一組）。
          按鈕與右側卡片共用同一組 handler，僅版面重複、不含任何額外邏輯。 */}
      {(!locked || canReview) && (
        <div className="action-bar no-print sm:hidden">
          {!locked && (
            <button
              type="button" className="btn" disabled={saving}
              onClick={() => void onSaveDraft()}
            >{saving ? '儲存中…' : '儲存草稿'}</button>
          )}
          {!locked && (draft.status === 'draft' || draft.status === 'rejected') && (
            <button
              type="button" className="btn btn-primary" disabled={saving}
              onClick={() => void onSubmit()}
            >{draft.status === 'rejected' ? '重新送審' : '送核可'}</button>
          )}
          {canReviewL1 && (
            <button
              type="button" className="btn btn-primary" disabled={saving}
              onClick={() => void onApproveL1()}
            >{isDeptHead ? '核可' : '代處長核可'}</button>
          )}
          {canReviewL2 && (
            <button
              type="button" className="btn btn-primary" disabled={saving}
              onClick={() => void onApproveFinal()}
            >核定</button>
          )}
        </div>
      )}
    </div>
  )
}
