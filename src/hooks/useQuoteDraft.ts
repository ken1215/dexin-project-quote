import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useRefData } from '../context/RefDataContext'
import { calcTotals, laborPrice, sectionsForPersist, validateQuote } from '../lib/calc'
import type { Totals } from '../lib/calc'
import type {
  DraftLine, DraftQuote, DraftSection, LaborRate,
  PriceItem, Quote, QuoteLine, QuoteSection, QuoteStatus,
} from '../types'

export const CN = ['壹', '貳', '參', '肆', '伍', '陸', '柒', '捌', '玖', '拾']

/**
 * 工資試算列（五步精靈第 ④ 步）固定落在這個分項名稱。
 * 單價庫的 Category.section_title 沒有同名大類，不會與自動長出的大項撞在一起。
 */
export const LABOR_SECTION_TITLE = '人工費用'

const uid = (): string => crypto.randomUUID()

/** 取本機日期（不要用 toISOString，那是 UTC 會差一天） */
/** 申請單位候選：取自歷史報價單「聯絡人」欄實際寫法，依出現次數排序。非清單內的可直接手動輸入 */
export const DEPT_OPTIONS = [
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
export const discountLabel = (d: number): string | null => {
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

export interface UseQuoteDraft {
  draft: DraftQuote; loading: boolean; saving: boolean
  err: string | null; notice: string | null; issues: string[]
  reviewNote: string; l1Skipped: boolean
  locked: boolean; frozen: boolean
  canReviewL1: boolean; canReviewL2: boolean; canReview: boolean
  totals: Totals
  justAdded: { id: string; qty: number } | null
  setReviewNote: (v: string) => void
  setIssues: (v: string[]) => void
  patchDraft: (patch: Partial<DraftQuote>) => void
  patchSection: (sk: string, patch: Partial<DraftSection>) => void
  patchLine: (sk: string, lk: string, patch: Partial<DraftLine>) => void
  removeLine: (sk: string, lk: string) => void
  removeSection: (sk: string) => void
  addSection: () => void
  addCustomLine: (sk: string) => void
  addItem: (item: PriceItem) => void
  /** 工資試算加入一列；分項「人工費用」不存在則自動建立（有列才建，不留空大項） */
  addLaborLine: (input: { name: string; headcount: number; days: number; rateId: string }) => void
  changeLineRate: (sk: string, lk: string, rateId: string) => void
  onSaveDraft: () => Promise<void>
  onSubmit: () => Promise<void>
  onPrint: () => Promise<void>
  onApproveL1: () => Promise<void>
  onApproveFinal: () => Promise<void>
  onReject: () => Promise<void>
}

export function useQuoteDraft(id?: string): UseQuoteDraft {
  const navigate = useNavigate()
  const { isManager, isDeptHead, isAdmin } = useAuth()
  const {
    laborRates, laborBase, laborDiscount, mgmtFeeRate, taxRate, categoryOf,
  } = useRefData()

  const [draft, setDraft] = useState<DraftQuote>(emptyDraft)
  const [loading, setLoading] = useState<boolean>(Boolean(id))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [issues, setIssues] = useState<string[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [reviewNote, setReviewNote] = useState('')
  /** 這張單是否由副部長越過工務處長直接核定（戳記在資料庫，這裡只負責顯示） */
  const [l1Skipped, setL1Skipped] = useState(false)
  /**
   * 剛按下「加入」的品項與加完的累計數量，用來給即時回饋。
   * 手機上明細區在螢幕外，不給回饋的話按了完全看不出有沒有進去；
   * 而且再按一次是「數量 +1」，那個變化更看不到——所以要把數量一起講。
   */
  const [justAdded, setJustAdded] = useState<{ id: string; qty: number } | null>(null)
  const addedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 元件卸載時清掉計時器，否則會對已卸載的元件 setState
  useEffect(() => () => { if (addedTimer.current) clearTimeout(addedTimer.current) }, [])

  /* ── 載入既有單據 ───────────────────────────────────────── */
  useEffect(() => {
    if (!id) { setDraft(emptyDraft()); setReviewNote(''); setL1Skipped(false); setLoading(false); return }
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
      setL1Skipped(quote.l1_skipped)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [id])

  /* ── 權限／唯讀 ─────────────────────────────────────────── */
  // 議價中／已定案的單一律凍結（主管也不例外）：本頁存檔是「整段砍掉重寫」，
  // 明細列會換成新 id，negotiations.line_id 會被 on delete cascade 連帶清光。
  // 這兩種狀態的金額異動只能在議價頁做。
  // 核定(approved)之後金額已由 db/22 A3 在資料庫層鎖死，明細寫不進去；
  // 畫面若還開著「儲存草稿」，使用者按下去只會拿到看不懂的「寫入工程大項失敗」。
  const frozen = draft.status === 'approved'
    || draft.status === 'negotiating' || draft.status === 'closed'
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
  const defaultRate: LaborRate | undefined = useMemo(
    () => [...laborRates].sort((a, b) => Number(a.multiplier) - Number(b.multiplier))[0],
    [laborRates],
  )
  const rateById = useMemo(
    () => new Map<string, LaborRate>(laborRates.map((r) => [r.id, r])),
    [laborRates],
  )

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

  // 大項可以刪到一個都不剩：五步精靈沒有「＋新增工程大項」入口，
  // 大項一律由 addItem／addLaborLine 依需要自動長出（兩者都吃得下 sections 為空）。
  // 原本的 length <= 1 護欄是舊單頁編輯器留下的，在精靈裡只會擋住使用者刪掉空殼大項。
  const removeSection = (sk: string) =>
    setDraft((d) => ({ ...d, sections: d.sections.filter((s) => s.key !== sk) }))

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
    // 加完會是幾件：同一個品項只會落在它所屬分類的那個大項裡，
    // 所以直接跨大項找就夠，不必重跑一次下面的大項歸屬邏輯。
    const nextQty = 1 + Number(
      draft.sections.flatMap((s) => s.lines)
        .find((l) => !l.is_custom && l.item_id === item.id)?.qty ?? 0,
    )
    setJustAdded({ id: item.id, qty: nextQty })
    if (addedTimer.current) clearTimeout(addedTimer.current)
    addedTimer.current = setTimeout(() => setJustAdded(null), 1600)

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

  /**
   * 工資試算加入一列（五步精靈第 ④ 步）。
   *
   * 為什麼不走 addItem：單價庫目前只剩 `lb-tech-day 技術工日薪` 一個按「工」計價的 active 品項，
   * 而 addItem 對同一 item_id 在同大項內是「數量 +1 合併」，一張單表達不出
   * 「3 工平日 ＋ 2 工休息日」。所以 ④ 直接產生明細列，不挑品項。
   *
   * 計算一律呼叫 calc.ts 的 laborPrice（牌價 × 物管合約折數 × 時段係數），這裡不另寫公式；
   * 工數＝人數 × 天數，半天以 0.5 計。
   *
   * rateId 必須取自 laborRates（quote_lines.labor_rate_id 有外鍵），
   * ④ 的時段一律由 laborRates 產生選項，不要自己拼字串。
   */
  const addLaborLine = (
    { name, headcount, days, rateId }:
    { name: string; headcount: number; days: number; rateId: string },
  ) => {
    const rate = rateById.get(rateId)
    const line: DraftLine = {
      key: uid(),
      item_id: null,
      labor_rate_id: rateId,
      name,
      spec: `${headcount} 人 × ${days} 天`,
      unit: '工',
      unit_price: laborPrice(laborBase, rate, laborDiscount),
      qty: (Number(headcount) || 0) * (Number(days) || 0),
      is_custom: false,
      reason: '',
      note: '',
    }
    setDraft((d) => {
      const idx = d.sections.findIndex((s) => s.title.trim() === LABOR_SECTION_TITLE)
      if (idx >= 0) {
        return {
          ...d,
          sections: d.sections.map((s, i) => (i === idx ? { ...s, lines: [...s.lines, line] } : s)),
        }
      }
      // 「人工費用」還不存在：有列才建（絕不預建空大項——persist 會把空大項寫成
      // 「工程項目 N」，列印標單就多出一塊只有表頭的空區塊），且排在所有大項之後。
      // 尾端若是尚未命名的空白大項（新單的初始大項就長這樣），就地改名沿用，
      // 不要在它後面再開一個——那個空白大項會被一起印出來。
      const last = d.sections.length - 1
      const reusable = last >= 0
        && !d.sections[last].title.trim() && d.sections[last].lines.length === 0
      if (reusable) {
        return {
          ...d,
          sections: d.sections.map((s, i) =>
            (i === last ? { ...s, title: LABOR_SECTION_TITLE, lines: [line] } : s)),
        }
      }
      return {
        ...d,
        sections: [...d.sections, { key: uid(), title: LABOR_SECTION_TITLE, lines: [line] }],
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
        // 零元品項的檢查刻意**不放在這裡**：那是「送審」才擋的規則（資料庫端也只掛在
        // draft->submitted 的轉換上），放進 dbGuard 會連草稿存檔與列印都擋掉，
        // 同仁還在填單就存不了。送審路徑走 validateQuote()，訊息與資料庫 raise 一致。
      })
    })
    return bad
  }

  /**
   * 存檔。順序是刻意的，不可為了少一次 round-trip 而合併：
   * 先把單子帶回可寫狀態 → 更新表頭 → 寫明細 → **最後**才改狀態。
   * 反過來（舊寫法：表頭順便帶 status）會讓送審時的零元檢查掃到還沒寫入的空明細而永遠通過，
   * 資料庫端 draft->submitted 的把關就形同虛設。
   */
  const persist = async (nextStatus: QuoteStatus): Promise<string | null> => {
    setErr(null)
    setNotice(null)
    setSaving(true)
    try {
      const isNew = !draft.id
      let quoteId = draft.id ?? ''
      // 表頭不再帶 status——狀態一律留到最後一步單獨改
      const head = {
        project: draft.project.trim(),
        dept: draft.dept.trim(),
        contact: draft.contact.trim(),
        quote_date: draft.quote_date || today(),
      }

      // 已有議價紀錄的單不可在此重寫明細：明細會換新 id，
      // negotiations.line_id 的 on delete cascade 會把議價歷程整批帶走。
      // 這是「一個字都還沒寫」時就該擋下的前置閘門，所以放在所有寫入之前。
      if (quoteId) {
        const ng = await supabase.from('negotiations')
          .select('id', { count: 'exact', head: true }).eq('quote_id', quoteId)
        if (ng.error) { setErr(`議價紀錄檢查失敗：${ng.error.message}`); return null }
        if ((ng.count ?? 0) > 0) {
          setErr('本單已有議價紀錄，於此儲存會清除議價歷程，已擋下；金額異動請至「議價」頁處理。')
          return null
        }
      }

      // ① 新單一律以草稿建立。按「送審」時也不直接寫 submitted，
      //    要等明細落地後才由第 ⑤ 步推上去，零元檢查才掃得到東西。
      if (!quoteId) {
        const no = await supabase.rpc('next_quote_no')
        if (no.error) { setErr(`取得單號失敗：${no.error.message}`); return null }
        const quoteNo = typeof no.data === 'string' ? no.data : ''
        if (!quoteNo) { setErr('取得單號失敗：伺服器未回傳單號。'); return null }

        const ins = await supabase.from('quotes')
          .insert({
            ...head, status: 'draft', quote_no: quoteNo,
            mgmt_fee_rate: mgmtFeeRate, tax_rate: taxRate,
          })
          .select('id').single()
        if (ins.error) { setErr(`建立報價單失敗：${ins.error.message}`); return null }
        quoteId = (ins.data as { id: string }).id
        setDraft((d) => ({ ...d, id: quoteId, quote_no: quoteNo, status: 'draft' }))
      } else if (draft.status === 'rejected') {
        // ② 退回單必須先單獨轉回草稿，不能等表頭更新順便帶：
        //    quotes_update 的 with check 只認 draft／submitted，退回單直接更新表頭會匹配 0 筆，
        //    連帶後面的明細也因子表政策同樣只認這兩個狀態而寫不進去。
        const back = await supabase.from('quotes')
          .update({ status: 'draft', updated_at: new Date().toISOString() })
          .eq('id', quoteId).select('id')
        if (back.error) { setErr(`退回單改回草稿失敗：${back.error.message}`); return null }
        if (!back.data?.length) {
          setErr('退回單改回草稿失敗：目前狀態下您沒有修改此單的權限。')
          return null
        }
        setDraft((d) => ({ ...d, status: 'draft' }))
      }

      // ③ 更新表頭（不帶 status）
      if (!isNew) {
        const upd = await supabase.from('quotes')
          .update({ ...head, updated_at: new Date().toISOString() })
          .eq('id', quoteId)
          .select('id')
        if (upd.error) { setErr(`更新報價單失敗：${upd.error.message}`); return null }
        // RLS 擋下時不會報錯、只會匹配 0 筆——這裡必須擋住，
        // 否則下面會把明細刪掉卻寫不回去（子表寫入會被同一組政策拒絕）
        if (((upd.data ?? []) as { id: string }[]).length === 0) {
          setErr('更新報價單失敗：目前狀態下您沒有修改此單的權限。')
          return null
        }
      }

      // ④ 明細：單據很小，不做 diff，整段砍掉重寫（quote_lines 有 on delete cascade）
      const del = await supabase.from('quote_sections').delete().eq('quote_id', quoteId)
      if (del.error) { setErr(`清除舊明細失敗：${del.error.message}`); return null }

      // 沒有明細的大項一律不落庫。空殼有三個來源：新單的初始空白大項（① 只填位置就存草稿）、
      // ② 取消掉最後一個大類、④ 把工資列刪光後留下的「人工費用」。
      // 它們一旦寫進去就會被補成「工程項目 N」，並在 A4 標單上印出一塊「本大項無項目」的空區塊
      // （PrintPage 是照資料庫印的，validateQuote 不擋空大項，所以 ⑤ 仍會顯示檢查通過）。
      // ⚠️ secRows 與 lineRows 必須派生自同一個 keptSections，兩邊的 si 才對得起來。
      const keptSections = sectionsForPersist(draft.sections)

      const secRows = keptSections.map((s, i) => ({
        id: uid(),
        quote_id: quoteId,
        title: s.title.trim() || `工程項目 ${i + 1}`,
        sort: i,
      }))
      if (secRows.length) {
        const rs = await supabase.from('quote_sections').insert(secRows)
        if (rs.error) { setErr(`寫入工程大項失敗：${rs.error.message}`); return null }
      }

      const lineRows = keptSections.flatMap((s, si) =>
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

      // ⑤ 明細都落地了，才動狀態。走到這裡資料庫裡的狀態必定是：
      //    新單＝draft、退回單＝已在第 ② 步轉成 draft、其餘＝原狀態。
      //    送審就是在這一步觸發資料庫的零元品項檢查——明細要先在，檢查才有東西可掃。
      const statusNow: QuoteStatus =
        isNew || draft.status === 'rejected' ? 'draft' : draft.status
      let statusErr: string | null = null
      if (nextStatus !== statusNow) {
        const st = await supabase.from('quotes')
          .update({ status: nextStatus, updated_at: new Date().toISOString() })
          .eq('id', quoteId).select('id')
        // 明細已經寫進去了，這裡失敗只是狀態沒推上去——訊息要講清楚，
        // 不然使用者會以為整批白存而重打一次
        if (st.error) {
          statusErr = `狀態更新失敗：${st.error.message}（明細已儲存，狀態未變更）`
        } else if (!st.data?.length) {
          statusErr = '狀態更新失敗：權限不足，或此單狀態已被他人變更（明細已儲存，狀態未變更）。'
        } else {
          setDraft((d) => ({ ...d, status: nextStatus }))
        }
      }

      // 新單即使狀態沒推成功也要把網址換過去，否則使用者再按一次會又開一張新單
      if (isNew) navigate(`/quote/${quoteId}`, { replace: true })
      if (statusErr) { setErr(statusErr); return null }
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
  const advance = async (next: QuoteStatus, okMsg: string): Promise<boolean> => {
    if (!draft.id) return false
    setErr(null); setNotice(null); setSaving(true)
    const r = await supabase.from('quotes')
      .update({ status: next, updated_at: new Date().toISOString() })
      .eq('id', draft.id).select('id')
    setSaving(false)
    if (r.error) { setErr(`核可失敗：${r.error.message}`); return false }
    // RLS 擋下時 Supabase 不報錯只回 0 筆，所以要看實際影響筆數
    if (!r.data?.length) { setErr('核可失敗：權限不足，或此單狀態已被他人變更。'); return false }
    patchDraft({ status: next })
    setNotice(okMsg)
    return true
  }

  const onApproveL1 = async () => { await advance('approved_l1', '已核可，送行政管理部副部長核定。') }
  const onApproveFinal = async () => {
    const skipping = draft.status === 'submitted'
    const ok = await advance('approved', skipping
      ? '已越級核定（未經工務處長），系統已留痕。'
      : '已核定，可送醫院採購。')
    // 只有真的成功才點亮越級標記——失敗時畫面不能謊報
    if (ok && skipping) setL1Skipped(true)
  }

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

  return {
    draft, loading, saving,
    err, notice, issues,
    reviewNote, l1Skipped,
    locked, frozen,
    canReviewL1, canReviewL2, canReview,
    totals,
    justAdded,
    setReviewNote,
    setIssues,
    patchDraft,
    patchSection,
    patchLine,
    removeLine,
    removeSection,
    addSection,
    addCustomLine,
    addItem,
    addLaborLine,
    changeLineRate,
    onSaveDraft,
    onSubmit,
    onPrint,
    onApproveL1,
    onApproveFinal,
    onReject,
  }
}
