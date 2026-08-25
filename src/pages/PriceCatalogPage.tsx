import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
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

const baseEdit = (it: PriceItem): RowEdit => ({
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

    setSaving(true); setErr(null); setMsg(null)
    const rows = dirtyItems.map((it) => {
      const e = editOf(it)
      return toRow(it, {
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

      {(err || floorErr) && (
        <div className="rounded-md border border-warn/30 bg-warn-bg px-3 py-2 text-sm text-warn">
          {err}{err && floorErr ? '　' : ''}{floorErr}
        </div>
      )}
      {msg && (
        <div className="rounded-md border border-green/30 bg-green/10 px-3 py-2 text-sm text-green">{msg}</div>
      )}

      {/* ── 篩選 ───────────────────────────────────────────── */}
      <div className="card">
        <div className="card-title">篩選與合理化待辦</div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-48">
            <label className="label" htmlFor="f-cat">分類</label>
            <select id="f-cat" className="field" value={filterCat} onChange={(e) => setFilterCat(e.target.value)}>
              <option value="">全部分類</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="w-64">
            <label className="label" htmlFor="f-kw">搜尋（品名／規格／代碼）</label>
            <input id="f-kw" className="field" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="例：電纜、風管、PVC" />
          </div>
          <label className="flex items-center gap-1.5 pb-1.5 text-sm text-ink-700">
            <input type="checkbox" checked={onlyNoEvidence} onChange={(e) => setOnlyNoEvidence(e.target.checked)} />
            只看無佐證
          </label>
          <label className="flex items-center gap-1.5 pb-1.5 text-sm text-ink-700">
            <input type="checkbox" checked={onlyNeedsArea} onChange={(e) => setOnlyNeedsArea(e.target.checked)} />
            只看待轉 m²
          </label>
          <label className="flex items-center gap-1.5 pb-1.5 text-sm text-ink-700">
            <input type="checkbox" checked={onlyFewSamples} onChange={(e) => setOnlyFewSamples(e.target.checked)} />
            只看樣本數 &lt; 3
          </label>
          <div className="ml-auto pb-1.5 text-sm text-ink-500">
            顯示 <span className="num">{shown.length}</span> / {items.length} 項
          </div>
        </div>
      </div>

      {/* ── 批次調整 ───────────────────────────────────────── */}
      <div className="card">
        <div className="card-title">批次調整</div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-56">
            <label className="label" htmlFor="b-cat">分類</label>
            <select
              id="b-cat" className="field" value={batchCat}
              onChange={(e) => { setBatchCat(e.target.value); setBatchAsk(false) }}
            >
              <option value="">請選擇分類</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="w-36">
            <label className="label" htmlFor="b-pct">調整百分比 (%)</label>
            <input
              id="b-pct" type="number" step="0.1" className="field num" value={batchPct}
              onChange={(e) => { setBatchPct(e.target.value); setBatchAsk(false) }}
              placeholder="例 3 或 -2.5"
            />
          </div>
          <button className="btn mb-0.5" disabled={!batchValid || batchBusy} onClick={() => setBatchAsk(true)}>
            批次調整
          </button>
          <div className="mb-1.5 text-xs text-ink-500">
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
            <div className="mt-2 flex gap-2">
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
        <div className="flex items-center justify-between border-b border-ink-200 pb-2">
          <div className="text-[15px] font-semibold text-deep">新增品項</div>
          <button className="btn" onClick={() => { setShowNew((v) => !v); setErr(null) }}>
            {showNew ? '收合' : '＋ 新增品項'}
          </button>
        </div>
        {showNew && (
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
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
            <div className="col-span-2 md:col-span-4">
              <button className="btn btn-primary" disabled={newBusy} onClick={() => void addItem()}>
                {newBusy ? '新增中…' : '確認新增'}
              </button>
              <span className="ml-3 text-xs text-ink-500">
                代碼將自動產生為 {newItem.category_id || '(分類)'}-new-流水號
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ── 單價表 ─────────────────────────────────────────── */}
      <div className="card">
        <div className="mb-3 flex flex-wrap items-center gap-3 border-b border-ink-200 pb-2">
          <div className="text-[15px] font-semibold text-deep">標準單價維護</div>
          <span className="text-xs text-ink-500">底價欄僅主管可見</span>
          <div className="ml-auto flex items-center gap-3">
            {dirtyItems.length > 0 && (
              <span className="text-sm text-alert">尚有 {dirtyItems.length} 筆未儲存</span>
            )}
            {dirtyItems.length > 0 && (
              <button className="btn" disabled={saving} onClick={() => { setEdits({}); setMsg(null) }}>
                放棄變更
              </button>
            )}
            <button className="btn btn-primary" disabled={saving || !dirtyItems.length} onClick={() => void save()}>
              {saving ? '儲存中…' : '儲存變更'}
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="th text-left">品名</th>
                <th className="th text-left">規格</th>
                <th className="th">單位</th>
                <th className="th">性質</th>
                <th className="th num">標準單價</th>
                <th className="th num">底價</th>
                <th className="th text-left">歷史參考</th>
                <th className="th text-left">指數連動</th>
                <th className="th text-left">佐證</th>
                <th className="th">啟用</th>
                <th className="th">軌跡</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr><td className="td text-center text-ink-500" colSpan={11}>沒有符合條件的品項</td></tr>
              )}
              {shown.map((it) => {
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
                    <tr className={dirty ? 'bg-light/40' : undefined}>
                      <td className="td">
                        <div className="text-ink-900">{it.name}</div>
                        <div className="text-[11px] text-ink-500">
                          {categoryOf(it.category_id)?.name ?? it.category_id}
                          {it.needs_area && <span className="ml-1 text-alert">・待轉 m²</span>}
                        </div>
                      </td>
                      <td className="td text-ink-700">{it.spec || '—'}</td>
                      <td className="td text-center">{it.unit}</td>
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
                    </tr>

                    {evOpen === it.id && (
                      <tr className="bg-ink-50">
                        <td className="td" colSpan={11}>
                          <div className="grid gap-3 md:grid-cols-3">
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
                        </td>
                      </tr>
                    )}

                    {histOpen === it.id && (
                      <tr className="bg-ink-50">
                        <td className="td" colSpan={11}>
                          <div className="mb-1 text-xs font-semibold text-deep">調價軌跡（最近 20 筆）</div>
                          {histErr && <div className="text-xs text-warn">{histErr}</div>}
                          {histLoading && <div className="text-xs text-ink-500">載入中…</div>}
                          {!histLoading && !hist.length && !histErr && (
                            <div className="text-xs text-ink-500">尚無調價紀錄</div>
                          )}
                          {!histLoading && hist.length > 0 && (
                            <table className="w-full border-collapse">
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
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
