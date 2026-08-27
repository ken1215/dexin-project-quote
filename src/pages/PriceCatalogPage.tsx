import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useRefData } from '../context/RefDataContext'
import { indexedPrice, money } from '../lib/calc'
import {
  COST_LABEL, EVIDENCE_LABEL,
  type CostType, type EvidenceKind, type PriceFloor, type PriceHistoryRow, type PriceItem,
} from '../types'

/** 佐證種類的色票（index 藍／law 綠／market 橘／history 灰） */
const EVIDENCE_TAG: Record<EvidenceKind, string> = {
  index: 'bg-light text-deep',
  law: 'bg-green/15 text-green',
  market: 'bg-alert/15 text-alert',
  history: 'bg-ink-200 text-ink-700',
}

/** 一列可就地編輯的欄位（單價用字串承接輸入中的中間狀態） */
interface RowEdit {
  name: string
  spec: string
  unit: string
  std_price: string
  evidence_id: string
  evidence_note: string
  active: boolean
}

interface NewItemForm {
  category_id: string
  name: string
  spec: string
  unit: string
  cost_type: CostType
  std_price: string
  evidence_id: string
  evidence_note: string
}

const EMPTY_NEW: NewItemForm = {
  category_id: '', name: '', spec: '', unit: '', cost_type: 'material',
  std_price: '', evidence_id: '', evidence_note: '',
}

/** item_usage RPC 的回傳形狀：這個品項被幾張報價單、幾行明細用過 */
interface ItemUsage {
  quote_count: number
  line_count: number
}

/** 批次刪除面板用：單一品項被引用的報價單數與明細行數 */
interface BulkUsage {
  quotes: number
  lines: number
}

/** 批次刪除單次上限——太長的 in 清單會塞爆網址，超過就請主管分批 */
const MAX_BULK_DELETE = 200

/** 單價表的欄數——群組標題列與所有展開面板都靠它跨滿整列 */
const COL_COUNT = 13

/** 一個工程大類的分組結果（統計一律以「目前篩選後可見的列」為母體） */
interface CatGroup {
  id: string
  name: string
  rows: PriceItem[]
  active: number
  inactive: number
  /** 有佐證的 active 品項 ÷ active 品項；該組沒有啟用品項時為 null */
  coverage: number | null
  needsArea: number
}

/** 佐證覆蓋率的燈號：< 30% 紅、< 60% 橘、其餘灰 */
const coverageClass = (cov: number | null): string => {
  if (cov === null) return 'text-ink-500'
  if (cov < 30) return 'text-warn'
  if (cov < 60) return 'text-alert'
  return 'text-ink-500'
}

const baseEdit = (it: PriceItem): RowEdit => ({
  name: it.name,
  spec: it.spec,
  unit: it.unit,
  std_price: String(it.std_price),
  evidence_id: it.evidence_id ?? '',
  evidence_note: it.evidence_note,
  active: it.active,
})

/** 只挑出 price_items 的欄位送出，避免把 updated_at 之類的欄位一起蓋回去 */
const toRow = (it: PriceItem, over: Partial<PriceItem>): PriceItem => ({
  id: it.id,
  category_id: it.category_id,
  name: it.name,
  spec: it.spec,
  unit: it.unit,
  cost_type: it.cost_type,
  std_price: it.std_price,
  evidence_id: it.evidence_id,
  evidence_note: it.evidence_note,
  index_id: it.index_id,
  index_coeff: it.index_coeff,
  price_min: it.price_min,
  price_max: it.price_max,
  price_median: it.price_median,
  samples: it.samples,
  last_seen: it.last_seen,
  last_price: it.last_price,
  needs_area: it.needs_area,
  active: it.active,
  sort: it.sort,
  // upsert 是整列寫回，漏掉哪一欄就會被還原成預設值——子分類會全部清空
  subgroup: it.subgroup,
  ...over,
})

const m = (n: number | null): string => (n === null || n === undefined ? '—' : money(n))

function Stat({ label, value, sub, alert }: {
  label: string; value: string; sub?: string; alert?: boolean
}) {
  return (
    <div className={'rounded-lg border px-4 py-3 ' + (alert ? 'border-alert/40 bg-alert/10' : 'border-ink-200 bg-white')}>
      <div className="text-xs text-ink-500">{label}</div>
      <div className={'num text-[22px] leading-tight font-semibold ' + (alert ? 'text-alert' : 'text-deep')}>{value}</div>
      {sub && <div className="text-[11px] text-ink-500">{sub}</div>}
    </div>
  )
}

export default function PriceCatalogPage() {
  const {
    categories, items, evidence, loading, reload, categoryOf, indexOf, evidenceOf,
  } = useRefData()

  // ── 就地編輯 ────────────────────────────────────────────────
  const [edits, setEdits] = useState<Record<string, RowEdit>>({})
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  // ── 篩選 ────────────────────────────────────────────────────
  const [filterCat, setFilterCat] = useState('')
  const [search, setSearch] = useState('')
  const [onlyNoEvidence, setOnlyNoEvidence] = useState(false)
  const [onlyNeedsArea, setOnlyNeedsArea] = useState(false)
  const [onlyFewSamples, setOnlyFewSamples] = useState(false)

  // ── 分類分組的展開狀態（預設全收合；有篩選時自動展開命中的組） ──
  const [openCats, setOpenCats] = useState<Set<string>>(new Set())
  // 記住「這次的 openCats 變動是使用者手動觸發的」，避免被下方 effect 立刻蓋回去
  const userTouchedRef = useRef(false)
  // 上一次 effect 實際套用的篩選簽章，用來分辨「篩選真的變了」與「只是重繪」
  const lastFilterSigRef = useRef<string | null>(null)

  // ── 底價（RLS 只有主管讀得到） ──────────────────────────────
  const [floors, setFloors] = useState<Record<string, PriceFloor>>({})
  const [floorEdits, setFloorEdits] = useState<Record<string, string>>({})
  const [floorErr, setFloorErr] = useState<string | null>(null)
  const [floorBusy, setFloorBusy] = useState<string | null>(null)

  // ── 展開面板 ────────────────────────────────────────────────
  const [evOpen, setEvOpen] = useState<string | null>(null)
  const [histOpen, setHistOpen] = useState<string | null>(null)
  const [hist, setHist] = useState<PriceHistoryRow[]>([])
  const [histNames, setHistNames] = useState<Record<string, string>>({})
  const [histLoading, setHistLoading] = useState(false)
  const [histErr, setHistErr] = useState<string | null>(null)

  // ── 批次調整 ────────────────────────────────────────────────
  const [batchCat, setBatchCat] = useState('')
  const [batchPct, setBatchPct] = useState('')
  const [batchAsk, setBatchAsk] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)

  // ── 新增品項 ────────────────────────────────────────────────
  const [showNew, setShowNew] = useState(false)
  const [newItem, setNewItem] = useState<NewItemForm>(EMPTY_NEW)
  const [newBusy, setNewBusy] = useState(false)

  // ── 刪除品項（RLS 只有主管刪得掉，同仁會刪到 0 筆） ────────
  const [delAsk, setDelAsk] = useState<string | null>(null)
  const [delUsage, setDelUsage] = useState<ItemUsage | null>(null)
  const [delUsageLoading, setDelUsageLoading] = useState(false)
  const [delBusy, setDelBusy] = useState(false)
  const [delErr, setDelErr] = useState<string | null>(null)

  // ── 批次刪除 ────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkAsk, setBulkAsk] = useState(false)
  const [bulkUsage, setBulkUsage] = useState<Record<string, BulkUsage> | null>(null)
  const [bulkUsageLoading, setBulkUsageLoading] = useState(false)
  const [bulkUsageOpen, setBulkUsageOpen] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)

  const loadFloors = useCallback(async () => {
    const { data, error } = await supabase.from('price_floors').select('item_id,floor_price,note')
    if (error) { setFloorErr(`底價讀取失敗：${error.message}`); return }
    setFloorErr(null)
    const rows = (data ?? []) as PriceFloor[]
    setFloors(Object.fromEntries(rows.map((r) => [r.item_id, r])))
  }, [])

  useEffect(() => { void loadFloors() }, [loadFloors])

  // ── 統計 ────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const act = items.filter((i) => i.active)
    const withEv = act.filter((i) => i.evidence_id).length
    return {
      total: items.length,
      active: act.length,
      coverage: act.length ? Math.round((withEv / act.length) * 100) : 0,
      withEv,
      needsArea: act.filter((i) => i.needs_area).length,
    }
  }, [items])

  const shown = useMemo(() => {
    const kw = search.trim().toLowerCase()
    return items.filter((i) => {
      if (filterCat && i.category_id !== filterCat) return false
      if (onlyNoEvidence && i.evidence_id) return false
      if (onlyNeedsArea && !i.needs_area) return false
      if (onlyFewSamples && i.samples >= 3) return false
      if (kw) {
        const hay = `${i.name} ${i.spec} ${i.unit} ${i.id}`.toLowerCase()
        if (!hay.includes(kw)) return false
      }
      return true
    })
  }, [items, filterCat, search, onlyNoEvidence, onlyNeedsArea, onlyFewSamples])

  /** 有沒有任何作用中的篩選條件——決定群組要不要自動展開 */
  const filterActive = Boolean(filterCat) || search.trim() !== ''
    || onlyNoEvidence || onlyNeedsArea || onlyFewSamples

  // ── 依工程大類分組（順序照 categories 的 sort，空的分類不渲染）──
  const groups = useMemo<CatGroup[]>(() => {
    const bucket = new Map<string, PriceItem[]>()
    shown.forEach((i) => {
      const list = bucket.get(i.category_id)
      if (list) list.push(i)
      else bucket.set(i.category_id, [i])
    })
    const build = (id: string, name: string, rows: PriceItem[]): CatGroup => {
      const act = rows.filter((i) => i.active)
      const withEv = act.filter((i) => i.evidence_id).length
      return {
        id,
        name,
        rows,
        active: act.length,
        inactive: rows.length - act.length,
        coverage: act.length ? Math.round((withEv / act.length) * 100) : null,
        needsArea: rows.filter((i) => i.needs_area).length,
      }
    }
    // categories 已由 RefDataContext 依 sort 排序
    const out = categories
      .filter((c) => bucket.has(c.id))
      .map((c) => build(c.id, c.name, bucket.get(c.id) ?? []))
    // 分類表查不到的 category_id（資料異常）也要露出來，不能靜默漏掉品項
    const known = new Set(categories.map((c) => c.id))
    bucket.forEach((rows, id) => {
      if (!known.has(id)) out.push(build(id, `未知分類（${id}）`, rows))
    })
    return out
  }, [shown, categories])

  /** 只用分類 id 清單當 effect 的依賴，reload 造成的物件換身分不會誤觸發展開／收合 */
  const groupKey = useMemo(() => groups.map((g) => g.id).join('|'), [groups])

  // 篩選條件一變：有篩選就展開所有命中的組，篩選清空就全部收合。
  // 「篩選簽章」沒變卻又跑進來（例如使用者剛手動摺疊造成的重繪），就放過使用者的操作不覆寫；
  // 簽章真的變了才重算，所以手動摺疊不會吃掉下一次真正的篩選變化。
  useEffect(() => {
    const sig = `${filterActive ? '1' : '0'}｜${groupKey}`
    if (userTouchedRef.current && sig === lastFilterSigRef.current) {
      userTouchedRef.current = false
      return
    }
    userTouchedRef.current = false
    lastFilterSigRef.current = sig
    const ids = groupKey ? groupKey.split('|') : []
    setOpenCats((prev) => {
      const next = filterActive ? new Set(ids) : new Set<string>()
      let same = prev.size === next.size
      next.forEach((id) => { if (!prev.has(id)) same = false })
      return same ? prev : next
    })
  }, [filterActive, groupKey])

  const toggleCat = (id: string) => {
    userTouchedRef.current = true
    setOpenCats((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const expandAllCats = () => {
    userTouchedRef.current = true
    setOpenCats(new Set(groups.map((g) => g.id)))
  }

  const collapseAllCats = () => {
    userTouchedRef.current = true
    setOpenCats(new Set())
  }

  // ── 選取（批次刪除用）──────────────────────────────────────
  // 以 items 反查，reload 後已消失的品項會自動退出選取集合
  const selectedItems = useMemo(() => items.filter((i) => selected.has(i.id)), [items, selected])
  const selectedIds = useMemo(() => selectedItems.map((i) => i.id), [selectedItems])
  const usedSelected = useMemo(
    () => (bulkUsage ? selectedItems.filter((i) => bulkUsage[i.id]) : []),
    [bulkUsage, selectedItems],
  )
  const allShownSelected = shown.length > 0 && shown.every((i) => selected.has(i.id))
  const someShownSelected = shown.some((i) => selected.has(i.id))
  const overBulkLimit = selectedIds.length > MAX_BULK_DELETE

  const editOf = (it: PriceItem): RowEdit => edits[it.id] ?? baseEdit(it)

  const patch = (it: PriceItem, p: Partial<RowEdit>) => {
    setEdits((prev) => ({ ...prev, [it.id]: { ...(prev[it.id] ?? baseEdit(it)), ...p } }))
    setMsg(null)
  }

  const isDirty = useCallback((it: PriceItem): boolean => {
    const e = edits[it.id]
    if (!e) return false
    const b = baseEdit(it)
    return Number(e.std_price) !== Number(b.std_price)
      || e.name !== b.name
      || e.spec !== b.spec
      || e.unit !== b.unit
      || e.evidence_id !== b.evidence_id
      || e.evidence_note !== b.evidence_note
      || e.active !== b.active
  }, [edits])

  const dirtyItems = useMemo(() => items.filter(isDirty), [items, isDirty])

  // ── 儲存變更 ────────────────────────────────────────────────
  const save = async () => {
    if (!dirtyItems.length) return
    const bad = dirtyItems.find((it) => {
      const v = Number(editOf(it).std_price)
      return !Number.isFinite(v) || v < 0
    })
    if (bad) { setErr(`「${bad.name}」的標準單價不是有效數字（不可為負）`); return }

    // 品名與單位空白會讓報價單上出現沒有名字、沒有單位的一行，
    // 送到醫院採購手上很難看，在這裡先擋掉
    const blank = dirtyItems.find((it) => {
      const e = editOf(it)
      return !e.name.trim() || !e.unit.trim()
    })
    if (blank) { setErr(`「${blank.name}」的品名與單位不可空白`); return }

    setSaving(true); setErr(null); setMsg(null)
    const rows = dirtyItems.map((it) => {
      const e = editOf(it)
      return toRow(it, {
        name: e.name.trim(),
        spec: e.spec.trim(),
        unit: e.unit.trim(),
        std_price: Math.round(Number(e.std_price)),
        evidence_id: e.evidence_id || null,
        evidence_note: e.evidence_note,
        active: e.active,
      })
    })
    const { error } = await supabase.from('price_items').upsert(rows)
    setSaving(false)
    if (error) { setErr(`儲存失敗：${error.message}`); return }
    setEdits({})
    await reload()
    setMsg(`已儲存 ${rows.length} 筆品項變更`)
  }

  // ── 底價 upsert（離開欄位時寫入） ──────────────────────────
  const saveFloor = async (it: PriceItem) => {
    const raw = floorEdits[it.id]
    if (raw === undefined) return
    const cur = floors[it.id]
    const txt = raw.trim()

    if (txt === '') {
      if (!cur) { setFloorEdits((p) => { const n = { ...p }; delete n[it.id]; return n }); return }
      setFloorBusy(it.id); setFloorErr(null)
      const { error } = await supabase.from('price_floors').delete().eq('item_id', it.id)
      setFloorBusy(null)
      if (error) { setFloorErr(`底價刪除失敗：${error.message}`); return }
      setFloors((p) => { const n = { ...p }; delete n[it.id]; return n })
      setFloorEdits((p) => { const n = { ...p }; delete n[it.id]; return n })
      return
    }

    const v = Number(txt)
    if (!Number.isFinite(v) || v < 0) { setFloorErr(`「${it.name}」底價不是有效數字`); return }
    if (cur && Number(cur.floor_price) === v) {
      setFloorEdits((p) => { const n = { ...p }; delete n[it.id]; return n }); return
    }
    setFloorBusy(it.id); setFloorErr(null)
    const row: PriceFloor = { item_id: it.id, floor_price: Math.round(v), note: cur?.note ?? '' }
    const { error } = await supabase.from('price_floors').upsert(row)
    setFloorBusy(null)
    if (error) { setFloorErr(`底價儲存失敗：${error.message}`); return }
    setFloors((p) => ({ ...p, [it.id]: row }))
    setFloorEdits((p) => { const n = { ...p }; delete n[it.id]; return n })
  }

  // ── 調價軌跡 ────────────────────────────────────────────────
  const openHistory = async (it: PriceItem) => {
    if (histOpen === it.id) { setHistOpen(null); return }
    setHistOpen(it.id); setHist([]); setHistErr(null); setHistLoading(true)
    const { data, error } = await supabase
      .from('price_history').select('*')
      .eq('item_id', it.id).order('changed_at', { ascending: false }).limit(20)
    if (error) { setHistErr(`軌跡讀取失敗：${error.message}`); setHistLoading(false); return }
    const rows = (data ?? []) as PriceHistoryRow[]
    setHist(rows)
    const ids = Array.from(new Set(rows.map((r) => r.changed_by).filter((x): x is string => Boolean(x))))
    if (ids.length) {
      const p = await supabase.from('profiles').select('id,full_name').in('id', ids)
      if (p.error) setHistErr(`異動人讀取失敗：${p.error.message}`)
      else {
        const list = (p.data ?? []) as { id: string; full_name: string }[]
        setHistNames(Object.fromEntries(list.map((r) => [r.id, r.full_name])))
      }
    }
    setHistLoading(false)
  }

  // ── 批次調整 ────────────────────────────────────────────────
  const batchTargets = useMemo(
    () => (batchCat ? items.filter((i) => i.category_id === batchCat) : []),
    [items, batchCat],
  )
  const batchPctNum = Number(batchPct)
  const batchValid = Boolean(batchCat) && batchPct.trim() !== ''
    && Number.isFinite(batchPctNum) && batchPctNum !== 0 && batchTargets.length > 0

  const runBatch = async () => {
    if (!batchValid) return
    setBatchBusy(true); setErr(null); setMsg(null)
    const rows = batchTargets.map((it) =>
      toRow(it, { std_price: Math.max(0, Math.round(it.std_price * (1 + batchPctNum / 100))) }))
    const { error } = await supabase.from('price_items').upsert(rows)
    setBatchBusy(false); setBatchAsk(false)
    if (error) { setErr(`批次調整失敗：${error.message}`); return }
    setEdits({})
    await reload()
    setMsg(`已將「${categoryOf(batchCat)?.name ?? batchCat}」共 ${rows.length} 項調整 ${batchPctNum > 0 ? '+' : ''}${batchPctNum}%`)
    setBatchPct('')
  }

  // ── 新增品項 ────────────────────────────────────────────────
  const addItem = async () => {
    const n = newItem
    if (!n.category_id) { setErr('新增品項：請選擇分類'); return }
    if (!n.name.trim()) { setErr('新增品項：請填品名'); return }
    if (!n.unit.trim()) { setErr('新增品項：請填單位'); return }
    const price = Number(n.std_price)
    if (!Number.isFinite(price) || price < 0) { setErr('新增品項：標準單價不是有效數字'); return }

    setNewBusy(true); setErr(null); setMsg(null)
    const id = `${n.category_id}-new-${Date.now()}`
    const maxSort = items.filter((i) => i.category_id === n.category_id)
      .reduce((a, i) => Math.max(a, i.sort), 0)
    const { error } = await supabase.from('price_items').insert({
      id,
      category_id: n.category_id,
      name: n.name.trim(),
      spec: n.spec.trim(),
      unit: n.unit.trim(),
      cost_type: n.cost_type,
      std_price: Math.round(price),
      evidence_id: n.evidence_id || null,
      evidence_note: n.evidence_note.trim(),
      sort: maxSort + 1,
    })
    setNewBusy(false)
    if (error) { setErr(`新增失敗：${error.message}`); return }
    setNewItem(EMPTY_NEW)
    setShowNew(false)
    await reload()
    setMsg(`已新增品項 ${id}`)
  }

  // ── 勾選 ────────────────────────────────────────────────────
  const toggleOne = (id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
    setBulkAsk(false)
  }

  /** 群組全選只作用在該組目前可見的列；跨群組的勾選會累積不互相清掉 */
  const toggleGroup = (g: CatGroup, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      g.rows.forEach((i) => { if (on) next.add(i.id); else next.delete(i.id) })
      return next
    })
    setBulkAsk(false)
  }

  /** 表頭全選只作用在「目前篩選後可見」的列，不會掃到被篩掉的品項 */
  const toggleAllShown = (on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      shown.forEach((i) => { if (on) next.add(i.id); else next.delete(i.id) })
      return next
    })
    setBulkAsk(false)
  }

  // ── 單筆刪除 ────────────────────────────────────────────────
  const openDelete = async (it: PriceItem) => {
    if (delAsk === it.id) { setDelAsk(null); setDelUsage(null); return }
    setDelAsk(it.id); setDelUsage(null); setDelErr(null); setDelUsageLoading(true)
    const { data, error } = await supabase.rpc('item_usage', { p_item_id: it.id })
    setDelUsageLoading(false)
    if (error) { setDelErr(`「${it.name}」使用情形查詢失敗：${error.message}`); return }
    // count 是 bigint，PostgREST 可能給字串，一律 Number() 正規化
    const row = ((data ?? []) as ItemUsage[])[0]
    setDelUsage({
      quote_count: Number(row?.quote_count ?? 0),
      line_count: Number(row?.line_count ?? 0),
    })
  }

  const runDelete = async (it: PriceItem) => {
    setDelBusy(true); setDelErr(null); setErr(null); setMsg(null)
    const { data, error } = await supabase.from('price_items').delete().eq('id', it.id).select('id')
    setDelBusy(false)
    if (error) { setDelErr(`刪除失敗：${error.message}`); return }
    // RLS 擋下時不會報錯，只會回 0 筆——這裡要講清楚，不能靜默當成成功
    const removed = ((data ?? []) as { id: string }[]).length
    if (removed === 0) {
      setDelErr(`「${it.name}」沒有被刪除（回傳 0 筆）——只有主管能刪除品項，請確認權限後再試。`)
      return
    }
    setDelAsk(null); setDelUsage(null)
    setEdits((prev) => { const n = { ...prev }; delete n[it.id]; return n })
    setSelected((prev) => { const n = new Set(prev); n.delete(it.id); return n })
    await reload()
    setMsg(`已刪除品項「${it.name}」（${it.id}）`)
  }

  // ── 批次刪除 ────────────────────────────────────────────────
  const openBulkDelete = async () => {
    if (bulkAsk) { setBulkAsk(false); return }
    if (!selectedIds.length) return
    setBulkAsk(true); setBulkUsage(null); setBulkUsageOpen(false); setDelErr(null)
    if (selectedIds.length > MAX_BULK_DELETE) return
    setBulkUsageLoading(true)
    // 一次把所有選取品項的引用撈回來、在前端分組，省下 N-1 次 item_usage 往返
    const { data, error } = await supabase
      .from('quote_lines').select('item_id,quote_id').in('item_id', selectedIds)
    setBulkUsageLoading(false)
    if (error) { setDelErr(`使用情形查詢失敗：${error.message}`); return }
    const rows = (data ?? []) as { item_id: string | null; quote_id: string }[]
    const seen: Record<string, Set<string>> = {}
    const acc: Record<string, BulkUsage> = {}
    rows.forEach((r) => {
      if (!r.item_id) return
      const q = seen[r.item_id] ?? new Set<string>()
      q.add(r.quote_id)
      seen[r.item_id] = q
      const cur = acc[r.item_id] ?? { quotes: 0, lines: 0 }
      acc[r.item_id] = { quotes: q.size, lines: cur.lines + 1 }
    })
    setBulkUsage(acc)
  }

  const runBulkDelete = async () => {
    const ids = selectedIds
    if (!ids.length || ids.length > MAX_BULK_DELETE) return
    setBulkBusy(true); setDelErr(null); setErr(null); setMsg(null)
    const { data, error } = await supabase.from('price_items').delete().in('id', ids).select('id')
    setBulkBusy(false)
    if (error) { setDelErr(`批次刪除失敗：${error.message}`); return }
    const removed = ((data ?? []) as { id: string }[]).length
    setBulkAsk(false); setBulkUsage(null); setBulkUsageOpen(false)
    setDelAsk(null); setDelUsage(null)
    setSelected(new Set())
    setEdits({})
    await reload()
    if (removed < ids.length) {
      setDelErr(`只刪掉 ${removed} / ${ids.length} 項，其餘 ${ids.length - removed} 項未被刪除`
        + '——通常是沒有主管權限或被資料庫約束擋下，請確認後再試一次。')
    }
    setMsg(`已刪除 ${removed} 項品項`)
  }

  if (loading) {
    return <div className="p-10 text-center text-ink-500">單價庫載入中…</div>
  }

  return (
    <div className="space-y-4">
      {/* ── 統計 ───────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="品項總數" value={String(stats.total)} />
        <Stat label="啟用中" value={String(stats.active)} sub={`停用 ${stats.total - stats.active} 項`} />
        <Stat
          label="佐證覆蓋率"
          value={`${stats.coverage}%`}
          sub={`${stats.withEv} / ${stats.active} 項有佐證`}
          alert={stats.coverage < 60}
        />
        <Stat label="待轉 m² 的裝修項" value={String(stats.needsArea)} sub="歷史以「式」報價" />
      </div>

      {(err || floorErr || delErr) && (
        <div className="rounded-md border border-warn/30 bg-warn-bg px-3 py-2 text-sm text-warn">
          {[err, floorErr, delErr].filter((t) => Boolean(t)).join('　')}
        </div>
      )}
      {msg && (
        <div className="rounded-md border border-green/30 bg-green/10 px-3 py-2 text-sm text-green">{msg}</div>
      )}

      {/* ── 篩選 ───────────────────────────────────────────── */}
      <div className="card">
        <div className="card-title">篩選與合理化待辦</div>
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <div className="w-full sm:w-48">
            <label className="label" htmlFor="f-cat">分類</label>
            <select id="f-cat" className="field" value={filterCat} onChange={(e) => setFilterCat(e.target.value)}>
              <option value="">全部分類</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="w-full sm:w-64">
            <label className="label" htmlFor="f-kw">搜尋（品名／規格／代碼）</label>
            <input id="f-kw" className="field" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="例：電纜、風管、PVC" />
          </div>
          <label className="flex items-center gap-1.5 py-1 text-sm text-ink-700 sm:pb-1.5">
            <input type="checkbox" checked={onlyNoEvidence} onChange={(e) => setOnlyNoEvidence(e.target.checked)} />
            只看無佐證
          </label>
          <label className="flex items-center gap-1.5 py-1 text-sm text-ink-700 sm:pb-1.5">
            <input type="checkbox" checked={onlyNeedsArea} onChange={(e) => setOnlyNeedsArea(e.target.checked)} />
            只看待轉 m²
          </label>
          <label className="flex items-center gap-1.5 py-1 text-sm text-ink-700 sm:pb-1.5">
            <input type="checkbox" checked={onlyFewSamples} onChange={(e) => setOnlyFewSamples(e.target.checked)} />
            只看樣本數 &lt; 3
          </label>
          <div className="w-full text-sm text-ink-500 sm:ml-auto sm:w-auto sm:pb-1.5">
            顯示 <span className="num">{shown.length}</span> / {items.length} 項
          </div>
        </div>
      </div>

      {/* ── 批次調整 ───────────────────────────────────────── */}
      <div className="card">
        <div className="card-title">批次調整</div>
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <div className="w-full sm:w-56">
            <label className="label" htmlFor="b-cat">分類</label>
            <select
              id="b-cat" className="field" value={batchCat}
              onChange={(e) => { setBatchCat(e.target.value); setBatchAsk(false) }}
            >
              <option value="">請選擇分類</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="w-full sm:w-36">
            <label className="label" htmlFor="b-pct">調整百分比 (%)</label>
            <input
              id="b-pct" type="number" step="0.1" className="field num" value={batchPct}
              onChange={(e) => { setBatchPct(e.target.value); setBatchAsk(false) }}
              placeholder="例 3 或 -2.5"
            />
          </div>
          <button className="btn w-full sm:mb-0.5 sm:w-auto" disabled={!batchValid || batchBusy} onClick={() => setBatchAsk(true)}>
            批次調整
          </button>
          <div className="w-full text-xs text-ink-500 sm:mb-1.5 sm:w-auto">
            對該分類全部品項 std_price × (1 + %/100) 後四捨五入，直接寫入單價庫。
          </div>
        </div>

        {batchAsk && batchValid && (
          <div className="mt-3 rounded-md border border-alert/40 bg-alert/10 px-3 py-2.5 text-sm">
            <div className="text-ink-900">
              確認要把「{categoryOf(batchCat)?.name ?? batchCat}」的
              <span className="num mx-1 font-semibold">{batchTargets.length}</span>
              項品項單價一次調整
              <span className="num mx-1 font-semibold text-alert">
                {batchPctNum > 0 ? '+' : ''}{batchPctNum}%
              </span>
              嗎？此動作會立即寫入資料庫並留下調價軌跡。
            </div>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <button className="btn btn-primary" disabled={batchBusy} onClick={() => void runBatch()}>
                {batchBusy ? '調整中…' : '確認調整'}
              </button>
              <button className="btn" disabled={batchBusy} onClick={() => setBatchAsk(false)}>取消</button>
            </div>
          </div>
        )}
      </div>

      {/* ── 新增品項 ───────────────────────────────────────── */}
      <div className="card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-200 pb-2">
          <div className="text-[15px] font-semibold text-deep">新增品項</div>
          <button className="btn" onClick={() => { setShowNew((v) => !v); setErr(null) }}>
            {showNew ? '收合' : '＋ 新增品項'}
          </button>
        </div>
        {showNew && (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4">
            <div>
              <label className="label" htmlFor="n-cat">分類</label>
              <select id="n-cat" className="field" value={newItem.category_id}
                onChange={(e) => setNewItem((p) => ({ ...p, category_id: e.target.value }))}>
                <option value="">請選擇</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="n-name">品名</label>
              <input id="n-name" className="field" value={newItem.name}
                onChange={(e) => setNewItem((p) => ({ ...p, name: e.target.value }))} />
            </div>
            <div>
              <label className="label" htmlFor="n-spec">規格</label>
              <input id="n-spec" className="field" value={newItem.spec}
                onChange={(e) => setNewItem((p) => ({ ...p, spec: e.target.value }))} />
            </div>
            <div>
              <label className="label" htmlFor="n-unit">單位</label>
              <input id="n-unit" className="field" value={newItem.unit} placeholder="m／m²／組／式"
                onChange={(e) => setNewItem((p) => ({ ...p, unit: e.target.value }))} />
            </div>
            <div>
              <label className="label" htmlFor="n-cost">性質</label>
              <select id="n-cost" className="field" value={newItem.cost_type}
                onChange={(e) => setNewItem((p) => ({ ...p, cost_type: e.target.value as CostType }))}>
                {(Object.keys(COST_LABEL) as CostType[]).map((k) => (
                  <option key={k} value={k}>{COST_LABEL[k]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="n-price">標準單價</label>
              <input id="n-price" type="number" className="field num" value={newItem.std_price}
                onChange={(e) => setNewItem((p) => ({ ...p, std_price: e.target.value }))} />
            </div>
            <div>
              <label className="label" htmlFor="n-ev">佐證來源</label>
              <select id="n-ev" className="field" value={newItem.evidence_id}
                onChange={(e) => setNewItem((p) => ({ ...p, evidence_id: e.target.value }))}>
                <option value="">（暫無）</option>
                {evidence.map((s) => (
                  <option key={s.id} value={s.id}>{EVIDENCE_LABEL[s.kind]}｜{s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="n-note">佐證說明</label>
              <input id="n-note" className="field" value={newItem.evidence_note}
                onChange={(e) => setNewItem((p) => ({ ...p, evidence_note: e.target.value }))} />
            </div>
            <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row sm:items-center md:col-span-4">
              <button className="btn btn-primary w-full sm:w-auto" disabled={newBusy} onClick={() => void addItem()}>
                {newBusy ? '新增中…' : '確認新增'}
              </button>
              <span className="text-xs break-words text-ink-500 sm:ml-3">
                代碼將自動產生為 {newItem.category_id || '(分類)'}-new-流水號
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ── 單價表 ─────────────────────────────────────────── */}
      <div className="card">
        <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-ink-200 pb-2 sm:gap-3">
          <div className="text-[15px] font-semibold text-deep">標準單價維護</div>
          <span className="text-xs text-ink-500">底價欄僅主管可見</span>
          <button
            className="btn px-2 py-0.5 text-[11px]"
            disabled={groups.length === 0}
            onClick={expandAllCats}
          >
            全部展開
          </button>
          <button
            className="btn px-2 py-0.5 text-[11px]"
            disabled={groups.length === 0}
            onClick={collapseAllCats}
          >
            全部收合
          </button>
          <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto sm:gap-3">
            {selectedIds.length > 0 && (
              <>
                <span className="w-full text-sm text-ink-500 sm:w-auto">已選取 {selectedIds.length} 項</span>
                <button
                  className="btn flex-1 sm:flex-none" disabled={bulkBusy || delBusy}
                  onClick={() => { setSelected(new Set()); setBulkAsk(false) }}
                >
                  清除選取
                </button>
                <button
                  className="btn btn-danger flex-1 sm:flex-none" disabled={bulkBusy || delBusy}
                  onClick={() => void openBulkDelete()}
                >
                  刪除選取的 {selectedIds.length} 項
                </button>
              </>
            )}
            {dirtyItems.length > 0 && (
              <span className="w-full text-sm text-alert sm:w-auto">尚有 {dirtyItems.length} 筆未儲存</span>
            )}
            {dirtyItems.length > 0 && (
              <button className="btn flex-1 sm:flex-none" disabled={saving} onClick={() => { setEdits({}); setMsg(null) }}>
                放棄變更
              </button>
            )}
            <button className="btn btn-primary w-full sm:w-auto" disabled={saving || !dirtyItems.length} onClick={() => void save()}>
              {saving ? '儲存中…' : '儲存變更'}
            </button>
          </div>
        </div>

        {bulkAsk && selectedIds.length > 0 && (
          <div className="mb-3 rounded-md border border-warn/40 bg-warn-bg px-3 py-2.5 text-sm">
            <div className="font-semibold text-warn">
              確認要刪除選取的 <span className="num">{selectedIds.length}</span> 項品項嗎？
            </div>

            {overBulkLimit ? (
              <div className="mt-2 text-ink-900">
                一次最多刪除 <span className="num">{MAX_BULK_DELETE}</span> 項，目前選取
                <span className="num mx-1">{selectedIds.length}</span>
                項，請先縮小篩選範圍分批處理。
              </div>
            ) : (
              <>
                {bulkUsageLoading && <div className="mt-2 text-ink-500">使用情形查詢中…</div>}
                {!bulkUsageLoading && bulkUsage && (
                  <div className="mt-2 text-ink-900">
                    {usedSelected.length === 0 ? (
                      <>這 <span className="num">{selectedIds.length}</span> 項都尚未被任何報價單使用，可安全刪除。</>
                    ) : (
                      <>
                        其中 <span className="num font-semibold">{usedSelected.length}</span> 項已被報價單使用。
                        刪除<span className="font-semibold">不會</span>更動那些報價單的內容與金額
                        （單價已存為快照），只會失去與單價庫的連結。
                        <button
                          type="button" className="ml-2 text-bright underline"
                          onClick={() => setBulkUsageOpen((v) => !v)}
                        >
                          {bulkUsageOpen ? '收合明細' : '看是哪幾項'}
                        </button>
                      </>
                    )}
                  </div>
                )}
                {bulkUsageOpen && usedSelected.length > 0 && (
                  <ul className="mt-2 max-h-48 overflow-y-auto rounded border border-ink-200 bg-white px-3 py-2 text-[13px] break-words text-ink-700">
                    {usedSelected.map((i) => {
                      const u = bulkUsage?.[i.id]
                      return (
                        <li key={i.id}>
                          {i.name}{i.spec ? `／${i.spec}` : ''}
                          <span className="num ml-2 text-ink-500">
                            {u?.quotes ?? 0} 張報價單・{u?.lines ?? 0} 行明細
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                )}
                <div className="mt-2 text-ink-700">若只是暫時不用，建議改用「停用」而不是刪除。</div>
              </>
            )}

            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <button
                className="btn btn-danger"
                disabled={bulkBusy || bulkUsageLoading || overBulkLimit}
                onClick={() => void runBulkDelete()}
              >
                {bulkBusy ? '刪除中…' : `確認刪除 ${selectedIds.length} 項`}
              </button>
              <button className="btn" disabled={bulkBusy} onClick={() => setBulkAsk(false)}>取消</button>
            </div>
          </div>
        )}

        {/* 每格幾乎都是輸入框的密集編輯表格——手機轉卡片反而更難用，改用 .table-scroll 橫捲。
            .field 是 w-full，欄位本身沒有最小內容寬度，不給 min-w 會在窄螢幕被壓成一條線，
            所以表格與幾個文字欄一併設下最小寬度。 */}
        <div className="table-scroll">
          <table className="w-full min-w-[60rem] border-collapse">
            <thead>
              <tr>
                <th className="th w-8">
                  <input
                    type="checkbox"
                    aria-label="全選目前篩選結果"
                    checked={allShownSelected}
                    disabled={shown.length === 0}
                    ref={(el) => { if (el) el.indeterminate = !allShownSelected && someShownSelected }}
                    onChange={(ev) => toggleAllShown(ev.target.checked)}
                  />
                </th>
                <th className="th min-w-[9rem] text-left">品名</th>
                <th className="th min-w-[9rem] text-left">規格</th>
                <th className="th">單位</th>
                <th className="th">性質</th>
                <th className="th num">標準單價</th>
                <th className="th num">底價</th>
                <th className="th min-w-[13rem] text-left">歷史參考</th>
                <th className="th min-w-[8rem] text-left">指數連動</th>
                <th className="th text-left">佐證</th>
                <th className="th">啟用</th>
                <th className="th">軌跡</th>
                <th className="th">刪除</th>
              </tr>
            </thead>
            {groups.length === 0 && (
              <tbody>
                <tr>
                  <td className="td text-center text-ink-500" colSpan={COL_COUNT}>沒有符合條件的品項</td>
                </tr>
              </tbody>
            )}
            {groups.map((g) => {
              const open = openCats.has(g.id)
              // 全選狀態只看該組目前可見的列——別組已勾的品項不會被算進來也不會被清掉
              const allSel = g.rows.length > 0 && g.rows.every((i) => selected.has(i.id))
              const someSel = g.rows.some((i) => selected.has(i.id))
              return (
                <tbody key={g.id}>
                  <tr
                    className="cursor-pointer bg-light/60 hover:bg-light"
                    tabIndex={0}
                    aria-expanded={open}
                    onClick={() => toggleCat(g.id)}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleCat(g.id) }
                    }}
                  >
                    <td className="td" colSpan={COL_COUNT}>
                      {/* 這一列跨滿 60rem 的表格寬度；手機把內容釘在可視區左緣，
                          否則右側的群組全選勾選框要橫捲到底才點得到。 */}
                      <div className="sticky left-0 flex max-w-[calc(100vw-4rem)] flex-wrap items-center gap-x-3 gap-y-1 sm:static sm:max-w-none">
                        <span className="text-deep" aria-hidden="true">{open ? '▾' : '▸'}</span>
                        <span className="text-[14px] font-semibold text-deep">{g.name}</span>
                        <span className="text-xs text-ink-700">
                          品項 <span className="num">{g.rows.length}</span>
                        </span>
                        <span className="text-xs text-ink-700">
                          啟用 <span className="num">{g.active}</span>
                        </span>
                        {g.inactive > 0 && (
                          <span className="text-xs text-ink-500">
                            停用 <span className="num">{g.inactive}</span>
                          </span>
                        )}
                        <span
                          className={'text-xs ' + coverageClass(g.coverage)}
                          title="該分類目前顯示範圍內：有佐證的啟用品項 ÷ 啟用品項"
                        >
                          佐證 <span className="num">{g.coverage === null ? '—' : `${g.coverage}%`}</span>
                        </span>
                        {g.needsArea > 0 && (
                          <span className="tag bg-alert/15 text-alert">
                            待轉 m² <span className="num">{g.needsArea}</span>
                          </span>
                        )}
                        <input
                          type="checkbox"
                          className="ml-auto"
                          aria-label={`全選「${g.name}」目前顯示的 ${g.rows.length} 項`}
                          checked={allSel}
                          ref={(el) => { if (el) el.indeterminate = !allSel && someSel }}
                          onClick={(ev) => ev.stopPropagation()}
                          onChange={(ev) => toggleGroup(g, ev.target.checked)}
                        />
                      </div>
                    </td>
                  </tr>
                  {open && g.rows.map((it, ri) => {
                    // rows 已依 sort 排好，子分類必為連續區塊——變了就插一列標題
                    const newSub = it.subgroup && it.subgroup !== g.rows[ri - 1]?.subgroup
                    const e = editOf(it)
                    const dirty = isDirty(it)
                    const idx = indexOf(it.index_id)
                    const suggested = it.index_id ? indexedPrice(it, idx) : null
                    const cur = Number(e.std_price)
                    const src = evidenceOf(e.evidence_id || null)
                    const floor = floors[it.id]
                    const floorVal = floorEdits[it.id] ?? (floor ? String(floor.floor_price) : '')
                    return (
                      <Fragment key={it.id}>
                        {newSub && (
                          <tr>
                            <td
                              className="border border-ink-200 bg-light/70 px-2 py-1 text-[12px] font-semibold text-deep"
                              colSpan={COL_COUNT}
                            >
                              {it.subgroup}
                            </td>
                          </tr>
                        )}
                        <tr className={dirty ? 'bg-light/40' : undefined}>
                          <td className="td text-center">
                            <input
                              type="checkbox"
                              aria-label={`選取 ${it.name}`}
                              checked={selected.has(it.id)}
                              onChange={(ev) => toggleOne(it.id, ev.target.checked)}
                            />
                          </td>
                          <td className="td">
                            <input
                              className="field px-1.5 py-1" value={e.name}
                              aria-label={`${it.name} 品名`}
                              onChange={(ev) => patch(it, { name: ev.target.value })}
                            />
                            <div className="mt-0.5 text-[11px] break-words text-ink-500">
                              {categoryOf(it.category_id)?.name ?? it.category_id}
                              {it.needs_area && <span className="ml-1 text-alert">・待轉 m²</span>}
                            </div>
                          </td>
                          <td className="td">
                            <input
                              className="field px-1.5 py-1" value={e.spec}
                              placeholder="規格／說明"
                              aria-label={`${it.name} 規格`}
                              onChange={(ev) => patch(it, { spec: ev.target.value })}
                            />
                          </td>
                          <td className="td">
                            {/* 改單位等於改變單價的意義（米 → m² 價格就不是同一回事），
                                所以標成警示色提醒主管改完要順手確認單價 */}
                            <input
                              className={'field w-16 px-1.5 py-1 text-center '
                                + (e.unit !== it.unit ? 'border-alert text-alert' : '')}
                              value={e.unit}
                              aria-label={`${it.name} 單位`}
                              onChange={(ev) => patch(it, { unit: ev.target.value })}
                            />
                          </td>
                          <td className="td text-center text-ink-700">{COST_LABEL[it.cost_type]}</td>
                          <td className="td num">
                            <input
                              type="number" className="field num w-24 px-1.5 py-1" value={e.std_price}
                              aria-label={`${it.name} 標準單價`}
                              onChange={(ev) => patch(it, { std_price: ev.target.value })}
                            />
                          </td>
                          <td className="td num">
                            <input
                              type="number" className="field num w-24 px-1.5 py-1" value={floorVal}
                              aria-label={`${it.name} 底價`}
                              disabled={floorBusy === it.id}
                              onChange={(ev) => setFloorEdits((p) => ({ ...p, [it.id]: ev.target.value }))}
                              onBlur={() => void saveFloor(it)}
                            />
                          </td>
                          <td className="td text-[11px] text-ink-500">
                            {it.samples === 0 ? '無歷史資料' : (
                              <>
                                {m(it.price_min)}–{m(it.price_max)}　中位 {m(it.price_median)}
                                　最近 {it.last_seen || '—'} 報 {m(it.last_price)}　({it.samples} 筆)
                              </>
                            )}
                          </td>
                          <td className="td text-[11px]">
                            {!it.index_id ? <span className="text-ink-500">—</span> : (
                              <>
                                <div className="text-ink-700">
                                  {idx?.name ?? it.index_id}
                                  <span className="num ml-1">×{(Number(it.index_coeff) * 100).toFixed(0)}%</span>
                                </div>
                                {suggested !== null && suggested !== cur && (
                                  <button
                                    type="button"
                                    className="mt-0.5 rounded border border-bright px-1.5 py-0.5 text-[11px] text-bright hover:bg-bright hover:text-white"
                                    onClick={() => patch(it, { std_price: String(suggested) })}
                                  >
                                    建議 {money(suggested)} {suggested > cur ? '↑' : '↓'}
                                  </button>
                                )}
                              </>
                            )}
                          </td>
                          <td className="td">
                            <button
                              type="button"
                              className="inline-flex min-h-8 items-center"
                              title={e.evidence_note || src?.note || '點擊編輯佐證'}
                              onClick={() => setEvOpen((v) => (v === it.id ? null : it.id))}
                            >
                              {src
                                ? <span className={`tag ${EVIDENCE_TAG[src.kind]}`}>{EVIDENCE_LABEL[src.kind]}</span>
                                : <span className="tag bg-warn-bg text-warn">待補</span>}
                            </button>
                          </td>
                          <td className="td text-center">
                            <input
                              type="checkbox" checked={e.active}
                              aria-label={`${it.name} 啟用`}
                              onChange={(ev) => patch(it, { active: ev.target.checked })}
                            />
                          </td>
                          <td className="td text-center">
                            <button type="button" className="btn px-2 py-0.5 text-[11px]" onClick={() => void openHistory(it)}>
                              軌跡
                            </button>
                          </td>
                          <td className="td text-center">
                            <button
                              type="button"
                              className="btn btn-danger px-2 py-0.5 text-[11px]"
                              disabled={delBusy || bulkBusy}
                              onClick={() => void openDelete(it)}
                            >
                              刪除
                            </button>
                          </td>
                        </tr>

                        {delAsk === it.id && (
                          <tr className="bg-warn-bg">
                            <td className="td" colSpan={COL_COUNT}>
                              {/* 跨欄面板同樣釘在可視區左緣，手機不必橫捲就能讀完並按到按鈕 */}
                              <div className="sticky left-0 max-w-[calc(100vw-4rem)] sm:static sm:max-w-none">
                              <div className="text-sm font-semibold text-warn">確認刪除此品項？</div>
                              <div className="mt-1 grid grid-cols-1 gap-x-4 gap-y-0.5 text-[13px] break-words text-ink-900 sm:grid-cols-2 md:grid-cols-4">
                                <div>品名：{it.name}</div>
                                <div>規格：{it.spec || '—'}</div>
                                <div>單位：{it.unit}</div>
                                <div>目前標準單價：<span className="num">{money(it.std_price)}</span></div>
                              </div>
                              <div className="mt-2 text-[13px] text-ink-900">
                                {delUsageLoading && <span className="text-ink-500">使用情形查詢中…</span>}
                                {!delUsageLoading && delUsage && (
                                  delUsage.line_count === 0 && delUsage.quote_count === 0
                                    ? <>此品項尚未被任何報價單使用，可安全刪除。</>
                                    : (
                                      <>
                                        此品項已被 <span className="num font-semibold">{delUsage.quote_count}</span> 張報價單、
                                        <span className="num font-semibold">{delUsage.line_count}</span> 行明細使用。
                                        刪除<span className="font-semibold">不會</span>更動那些報價單的內容與金額
                                        （單價已存為快照），只會失去與單價庫的連結。
                                      </>
                                    )
                                )}
                              </div>
                              <div className="mt-1 text-[13px] text-ink-700">
                                若只是暫時不用，建議改用「停用」而不是刪除。
                              </div>
                              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                                <button
                                  className="btn btn-danger"
                                  disabled={delBusy || delUsageLoading}
                                  onClick={() => void runDelete(it)}
                                >
                                  {delBusy ? '刪除中…' : '確認刪除'}
                                </button>
                                <button
                                  className="btn" disabled={delBusy}
                                  onClick={() => { setDelAsk(null); setDelUsage(null) }}
                                >
                                  取消
                                </button>
                              </div>
                              </div>
                            </td>
                          </tr>
                        )}

                        {evOpen === it.id && (
                          <tr className="bg-ink-50">
                            <td className="td" colSpan={COL_COUNT}>
                              {/* 同上：釘左，避免 textarea 被拉成整個表格寬 */}
                              <div className="sticky left-0 max-w-[calc(100vw-4rem)] sm:static sm:max-w-none">
                              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                                <div>
                                  <label className="label" htmlFor={`ev-${it.id}`}>佐證來源</label>
                                  <select
                                    id={`ev-${it.id}`} className="field" value={e.evidence_id}
                                    onChange={(ev) => patch(it, { evidence_id: ev.target.value })}
                                  >
                                    <option value="">（無佐證）</option>
                                    {evidence.map((s) => (
                                      <option key={s.id} value={s.id}>{EVIDENCE_LABEL[s.kind]}｜{s.name}</option>
                                    ))}
                                  </select>
                                  {src && (
                                    <div className="mt-1 text-[11px] text-ink-500">
                                      發布機關：{src.publisher || '—'}
                                      {src.url && (
                                        <>
                                          {'　'}
                                          <a className="text-bright underline" href={src.url} target="_blank" rel="noreferrer">
                                            來源連結
                                          </a>
                                        </>
                                      )}
                                    </div>
                                  )}
                                </div>
                                <div className="md:col-span-2">
                                  <label className="label" htmlFor={`evn-${it.id}`}>佐證說明（會印在報價單佐證欄）</label>
                                  <textarea
                                    id={`evn-${it.id}`} className="field h-20" value={e.evidence_note}
                                    onChange={(ev) => patch(it, { evidence_note: ev.target.value })}
                                  />
                                </div>
                              </div>
                              <div className="mt-2 text-[11px] text-ink-500">
                                修改後請按上方「儲存變更」寫入資料庫。
                              </div>
                              </div>
                            </td>
                          </tr>
                        )}

                        {histOpen === it.id && (
                          <tr className="bg-ink-50">
                            <td className="td" colSpan={COL_COUNT}>
                              {/* 同上：釘左；內層軌跡表自己再包一層橫捲容器 */}
                              <div className="sticky left-0 max-w-[calc(100vw-4rem)] sm:static sm:max-w-none">
                              <div className="mb-1 text-xs font-semibold text-deep">調價軌跡（最近 20 筆）</div>
                              {histErr && <div className="text-xs text-warn">{histErr}</div>}
                              {histLoading && <div className="text-xs text-ink-500">載入中…</div>}
                              {!histLoading && !hist.length && !histErr && (
                                <div className="text-xs text-ink-500">尚無調價紀錄</div>
                              )}
                              {!histLoading && hist.length > 0 && (
                                <div className="table-scroll">
                                <table className="w-full min-w-[36rem] border-collapse">
                                  <thead>
                                    <tr>
                                      <th className="th num">舊價</th>
                                      <th className="th num">新價</th>
                                      <th className="th num">幅度</th>
                                      <th className="th text-left">時間</th>
                                      <th className="th text-left">異動人</th>
                                      <th className="th text-left">說明</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {hist.map((h) => {
                                      const old = h.old_price === null ? null : Number(h.old_price)
                                      const pct = old ? ((Number(h.new_price) - old) / old) * 100 : null
                                      return (
                                        <tr key={h.id}>
                                          <td className="td num">{m(old)}</td>
                                          <td className="td num">{money(Number(h.new_price))}</td>
                                          <td className={'td num ' + (pct !== null && pct > 0 ? 'text-alert' : 'text-ink-700')}>
                                            {pct === null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`}
                                          </td>
                                          <td className="td">{new Date(h.changed_at).toLocaleString('zh-TW')}</td>
                                          <td className="td">{(h.changed_by && histNames[h.changed_by]) || '—'}</td>
                                          <td className="td">{h.reason || '—'}</td>
                                        </tr>
                                      )
                                    })}
                                  </tbody>
                                </table>
                                </div>
                              )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              )
            })}
          </table>
        </div>
      </div>
    </div>
  )
}
