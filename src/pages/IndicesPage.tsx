import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useRefData } from '../context/RefDataContext'
import { laborListPrice, laborPrice, money } from '../lib/calc'
import type { LaborRate, MaterialIndex } from '../types'

type ProductivityBasis = 'history' | 'standard' | 'estimate'
type ProductivityConfidence = 'high' | 'medium' | 'low'

/** labor_productivity：一名技術工於正常工時（8 小時）之產出基準 */
interface LaborProductivity {
  id: string
  trade: string
  work_item: string
  unit: string
  /** 工率＝每工日產出量；工資單價 = 技術工日薪 ÷ 工率 */
  output_per_manday: number
  crew: string
  basis: ProductivityBasis
  source: string
  confidence: ProductivityConfidence
  note: string
  active: boolean
  sort: number
}

const BASIS_LABEL: Record<ProductivityBasis, string> = {
  history: '自家歷史成交',
  standard: '官方工料分析',
  estimate: '業界經驗估計',
}

const CONFIDENCE_LABEL: Record<ProductivityConfidence, string> = {
  high: '高',
  medium: '中',
  low: '低',
}

const CONFIDENCE_CLASS: Record<ProductivityConfidence, string> = {
  high: 'border-green text-green',
  medium: 'border-ink-500 text-ink-500',
  low: 'border-alert text-alert',
}

/** 折後單價低於此值多半是工率被誤打成 10 倍，會讓報價嚴重偏低 */
const LOW_UNIT_PRICE = 50

/** 折數寫成國人習慣的「幾折」：0.9 → 「9 折」、0.85 → 「8.5 折」；未打折（≧1）回傳 null */
function discountLabel(d: number): string | null {
  const n = Number(d)
  if (!Number.isFinite(n) || n >= 1) return null
  return `${Math.round(n * 1000) / 100} 折`
}

/** (現值/基準值 − 1) × 100，保留一位小數字串（含正負號） */
function pctChange(index: MaterialIndex): number {
  const base = Number(index.base_value)
  if (!base) return 0
  return (Number(index.value) / base - 1) * 100
}

function pctClass(pct: number): string {
  if (pct > 0) return 'text-warn'
  if (pct < 0) return 'text-green'
  return 'text-ink-700'
}

function fmtDateTime(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-TW', { hour12: false })
}

/** 工率必須大於 0：0 或負數會讓「日薪 ÷ 工率」變成無限大或負值 */
function validOutput(output: number): boolean {
  return Number.isFinite(Number(output)) && Number(output) > 0
}

/** 每單位工資牌價 = 技術工日薪牌價 ÷ 工率 */
function unitListPrice(baseDaily: number, output: number): number {
  if (!validOutput(output)) return 0
  return Math.round((Number(baseDaily) || 0) / Number(output))
}

/** 每單位折後單價 = 技術工日薪牌價 × 物業合約折數 ÷ 工率 */
function unitNetPrice(baseDaily: number, discount: number, output: number): number {
  if (!validOutput(output)) return 0
  return Math.round(((Number(baseDaily) || 0) * (Number(discount) || 1)) / Number(output))
}

export default function IndicesPage() {
  const refData = useRefData()
  const {
    indices, evidence, laborRates, laborBase, laborDiscount, evidenceOf, loading, error, reload,
  } = refData

  const [rows, setRows] = useState<MaterialIndex[]>([])
  const [laborRows, setLaborRows] = useState<LaborRate[]>([])
  const [baseDaily, setBaseDaily] = useState<number>(laborBase)
  const [discount, setDiscount] = useState<number>(laborDiscount)

  const [savingIdx, setSavingIdx] = useState(false)
  const [idxError, setIdxError] = useState<string | null>(null)
  const [idxSaved, setIdxSaved] = useState(false)

  const [savingLabor, setSavingLabor] = useState(false)
  const [laborError, setLaborError] = useState<string | null>(null)
  const [laborSaved, setLaborSaved] = useState(false)

  // labor_productivity 沒收在 useRefData() 裡，本頁自己撈自己維護
  const [prodOrig, setProdOrig] = useState<LaborProductivity[]>([])
  const [prodRows, setProdRows] = useState<LaborProductivity[]>([])
  const [prodLoading, setProdLoading] = useState(true)
  const [savingProd, setSavingProd] = useState(false)
  const [prodError, setProdError] = useState<string | null>(null)
  const [prodSaved, setProdSaved] = useState(false)

  const loadProductivity = useCallback(async () => {
    setProdLoading(true)
    setProdError(null)
    const { data, error: pErr } = await supabase
      .from('labor_productivity')
      .select('*')
      .order('sort')
    if (pErr) {
      setProdError(pErr.message)
      setProdLoading(false)
      return
    }
    const list = (data ?? []) as LaborProductivity[]
    setProdOrig(list)
    setProdRows(list.map((r) => ({ ...r })))
    setProdLoading(false)
  }, [])

  useEffect(() => { void loadProductivity() }, [loadProductivity])

  useEffect(() => { setRows(indices.map((i) => ({ ...i }))) }, [indices])
  useEffect(() => { setLaborRows(laborRates.map((r) => ({ ...r }))) }, [laborRates])
  useEffect(() => { setBaseDaily(laborBase) }, [laborBase])
  useEffect(() => { setDiscount(laborDiscount) }, [laborDiscount])

  const linkedSourceIds = Array.from(new Set(indices.map((i) => i.source_id).filter((id): id is string => !!id)))
  const linkedSources = evidence.filter((e) => linkedSourceIds.includes(e.id))

  function updateRow(id: string, patch: Partial<Pick<MaterialIndex, 'period' | 'value'>>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    setIdxSaved(false)
  }

  function updateLaborRow(id: string, multiplier: number) {
    setLaborRows((prev) => prev.map((r) => (r.id === id ? { ...r, multiplier } : r)))
    setLaborSaved(false)
  }

  function updateProdRow(id: string, patch: Partial<Pick<LaborProductivity, 'output_per_manday' | 'active'>>) {
    setProdRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    setProdSaved(false)
  }

  async function saveIndices() {
    const changed = rows.filter((r) => {
      const orig = indices.find((i) => i.id === r.id)
      return orig && (orig.period !== r.period || Number(orig.value) !== Number(r.value))
    })
    if (!changed.length) return
    setSavingIdx(true)
    setIdxError(null)
    setIdxSaved(false)
    // 必須送整列。PostgREST 的 upsert 是 INSERT…ON CONFLICT，
    // Postgres 在解衝突「之前」就會驗 NOT NULL——只送 {id, value} 會因為
    // name 是 not null 無 default 而整批失敗（實測過，錯誤是
    // "null value in column name violates not-null constraint"）。
    const { error: upErr } = await supabase.from('material_indices').upsert(
      changed.map((r) => ({
        ...r,
        value: Number(r.value) || 0,
        updated_at: new Date().toISOString(),
      })),
    )
    if (upErr) {
      setIdxError(upErr.message)
      setSavingIdx(false)
      return
    }
    await reload()
    setSavingIdx(false)
    setIdxSaved(true)
  }

  async function saveLabor() {
    const changedRates = laborRows.filter((r) => {
      const orig = laborRates.find((x) => x.id === r.id)
      return orig && Number(orig.multiplier) !== Number(r.multiplier)
    })
    const baseChanged = Number(baseDaily) !== Number(laborBase)
    const discountChanged = Number(discount) !== Number(laborDiscount)
    if (!changedRates.length && !baseChanged && !discountChanged) return
    setSavingLabor(true)
    setLaborError(null)
    setLaborSaved(false)

    if (changedRates.length) {
      // 同上，name 是 not null 無 default，只送 {id, multiplier} 會整批失敗
      const { error: upErr } = await supabase.from('labor_rates').upsert(
        changedRates.map((r) => ({ ...r, multiplier: Number(r.multiplier) || 0 })),
      )
      if (upErr) {
        setLaborError(upErr.message)
        setSavingLabor(false)
        return
      }
    }
    if (baseChanged) {
      const { error: upErr } = await supabase
        .from('settings')
        .upsert({ key: 'labor_base_daily', value: Number(baseDaily) || 0 }, { onConflict: 'key' })
      if (upErr) {
        setLaborError(upErr.message)
        setSavingLabor(false)
        return
      }
    }
    if (discountChanged) {
      const { error: upErr } = await supabase
        .from('settings')
        .upsert({ key: 'labor_discount', value: Number(discount) || 1 }, { onConflict: 'key' })
      if (upErr) {
        setLaborError(upErr.message)
        setSavingLabor(false)
        return
      }
    }
    await reload()
    setSavingLabor(false)
    setLaborSaved(true)
  }

  /** 只送有改的列（工率或啟用狀態） */
  function changedProdRows(): LaborProductivity[] {
    return prodRows.filter((r) => {
      const orig = prodOrig.find((x) => x.id === r.id)
      return orig
        && (Number(orig.output_per_manday) !== Number(r.output_per_manday) || orig.active !== r.active)
    })
  }

  async function saveProductivity() {
    // 護欄：任何一列工率不合法就整批不送出，避免只擋畫面卻讓資料落庫
    const bad = prodRows.filter((r) => !validOutput(r.output_per_manday))
    if (bad.length) {
      setProdError(`有 ${bad.length} 列工率不大於 0，請修正後再儲存`)
      return
    }
    const changed = changedProdRows()
    if (!changed.length) return
    setSavingProd(true)
    setProdError(null)
    setProdSaved(false)
    // upsert 走 INSERT…ON CONFLICT，Postgres 會先驗 NOT NULL 再解衝突，
    // 所以 trade／work_item／unit（not null 且無 default）必須一併帶上，
    // 只送 {id, output_per_manday} 會被擋在 null value violates not-null。
    const { error: upErr } = await supabase.from('labor_productivity').upsert(
      changed.map((r) => ({
        ...r,
        output_per_manday: Number(r.output_per_manday),
        updated_at: new Date().toISOString(),
      })),
    )
    if (upErr) {
      setProdError(upErr.message)
      setSavingProd(false)
      return
    }
    await loadProductivity()
    setSavingProd(false)
    setProdSaved(true)
  }

  const idxDirty = rows.some((r) => {
    const orig = indices.find((i) => i.id === r.id)
    return orig && (orig.period !== r.period || Number(orig.value) !== Number(r.value))
  })
  const laborDirty =
    laborRows.some((r) => {
      const orig = laborRates.find((x) => x.id === r.id)
      return orig && Number(orig.multiplier) !== Number(r.multiplier)
    })
    || Number(baseDaily) !== Number(laborBase)
    || Number(discount) !== Number(laborDiscount)

  const prodDirty = changedProdRows().length > 0
  const prodBadCount = prodRows.filter((r) => !validOutput(r.output_per_manday)).length

  // 依 trade 分組，組內維持 sort 順序（同工種即使不相鄰也收進同一組）
  const prodGroups = useMemo(() => {
    const groups: { trade: string; rows: LaborProductivity[] }[] = []
    for (const r of prodRows) {
      const g = groups.find((x) => x.trade === r.trade)
      if (g) g.rows.push(r)
      else groups.push({ trade: r.trade, rows: [r] })
    }
    return groups
  }, [prodRows])

  if (loading) return <div className="p-6 text-ink-500">載入中…</div>

  return (
    // 手機縮小外距，把寬度讓給表格內容；sm 以上維持原本的 p-6
    <div className="space-y-4 p-3 sm:space-y-6 sm:p-6">
      <div className="card">
        <div className="card-title">物價指數維護</div>
        <p className="mb-3 text-sm text-ink-700">
          本頁數值為報價單佐證之依據，建議每月初更新一次；更新後全系統以此指數連動計算之建議單價與佐證句將立即套用最新數字。
        </p>
        {linkedSources.length > 0 && (
          <div className="text-sm text-ink-700">
            <div className="mb-1 text-xs text-ink-500">官方查詢連結</div>
            <ul className="list-disc space-y-1 pl-5">
              {linkedSources.map((s) => (
                // 手機：網址沒有空白可斷行，必須 break-all 才不會把版面撐出橫捲
                <li key={s.id} className="break-words">
                  {s.name}（{s.publisher}）
                  {s.url ? (
                    <>
                      {' — '}
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noreferrer"
                        className="break-all text-bright underline hover:text-deep"
                      >
                        {s.url}
                      </a>
                    </>
                  ) : (
                    <span className="text-ink-500">（未提供連結）</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && <div className="mt-3 text-sm text-warn">讀取失敗：{error}</div>}
      </div>

      <div className="card">
        {/* 手機：標題與儲存區直排，儲存鈕整列寬（好按）；sm 以上恢復左右分置 */}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="card-title mb-0 border-0 pb-0">指數清單</div>
          <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
            {idxSaved && !idxDirty && <span className="text-sm text-green">已儲存</span>}
            {idxError && <span className="break-words text-sm text-warn">{idxError}</span>}
            <button
              type="button"
              className="btn btn-primary w-full sm:w-auto"
              disabled={!idxDirty || savingIdx}
              onClick={() => void saveIndices()}
            >
              {savingIdx ? '儲存中…' : '儲存'}
            </button>
          </div>
        </div>

        {/* 手機：本表以唯讀欄位為主（只有兩格可輸入），走 .rwd-table 卡片化 */}
        <div className="table-scroll">
          <table className="rwd-table w-full border-collapse">
            <thead>
              <tr>
                <th className="th text-left">指數名稱</th>
                <th className="th text-left">單位</th>
                <th className="th text-left">基準期別</th>
                <th className="th num">基準值</th>
                <th className="th text-left">現值期別</th>
                <th className="th num">現值</th>
                <th className="th num">較基準變動%</th>
                <th className="th text-left">來源</th>
                <th className="th text-left">最後更新時間</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td className="td text-center text-ink-500" colSpan={9}>目前沒有物價指數資料</td>
                </tr>
              )}
              {rows.map((r) => {
                const pct = pctChange(r)
                const src = evidenceOf(r.source_id)
                return (
                  <tr key={r.id}>
                    <td className="td break-words font-medium">{r.name}</td>
                    <td className="td" data-label="單位">{r.unit}</td>
                    <td className="td" data-label="基準期別">{r.base_period}</td>
                    <td className="td num" data-label="基準值">{r.base_value}</td>
                    <td className="td" data-label="現值期別">
                      <input
                        className="field"
                        value={r.period}
                        onChange={(e) => updateRow(r.id, { period: e.target.value })}
                      />
                    </td>
                    <td className="td" data-label="現值">
                      <input
                        type="number"
                        step="0.01"
                        className="field num"
                        value={r.value}
                        onChange={(e) => updateRow(r.id, { value: Number(e.target.value) })}
                      />
                    </td>
                    <td className={`td num ${pctClass(pct)}`} data-label="較基準變動%">
                      {pct >= 0 ? '+' : ''}{pct.toFixed(1)}%
                    </td>
                    <td className="td break-words" data-label="來源">
                      {src ? (
                        src.url ? (
                          <a
                            href={src.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-bright underline hover:text-deep"
                          >
                            {src.name}／{src.publisher}
                          </a>
                        ) : (
                          <span>{src.name}／{src.publisher}</span>
                        )
                      ) : (
                        <span className="text-ink-500">—</span>
                      )}
                    </td>
                    <td className="td" data-label="最後更新">{fmtDateTime(r.updated_at)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        {/* 手機：標題與儲存區直排，儲存鈕整列寬（好按）；sm 以上恢復左右分置 */}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="card-title mb-0 border-0 pb-0">工資時段加成表</div>
          <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
            {laborSaved && !laborDirty && <span className="text-sm text-green">已儲存</span>}
            {laborError && <span className="break-words text-sm text-warn">{laborError}</span>}
            <button
              type="button"
              className="btn btn-primary w-full sm:w-auto"
              disabled={!laborDirty || savingLabor}
              onClick={() => void saveLabor()}
            >
              {savingLabor ? '儲存中…' : '儲存'}
            </button>
          </div>
        </div>

        {/* 手機單欄、sm 以上雙欄；輸入框手機整列寬，避免被長標籤擠成細條 */}
        <div className="mb-4 grid grid-cols-1 items-start gap-4 sm:grid-cols-2 sm:gap-6">
          <div className="min-w-0">
            <label className="label">技術工日薪牌價（元／日，來自 settings.labor_base_daily）</label>
            <input
              type="number"
              step="1"
              className="field num w-full sm:w-40"
              value={baseDaily}
              onChange={(e) => { setBaseDaily(Number(e.target.value)); setLaborSaved(false) }}
            />
          </div>
          <div className="min-w-0">
            <label className="label">物業管理合約優惠折數（來自 settings.labor_discount）</label>
            <input
              type="number"
              step="0.01"
              min={0.5}
              max={1}
              className="field num w-full sm:w-40"
              value={discount}
              onChange={(e) => { setDiscount(Number(e.target.value)); setLaborSaved(false) }}
            />
            <div className="mt-1 break-words text-xs text-ink-500">
              牌價 {money(baseDaily)} 元／工，
              {discountLabel(discount)
                ? `因院方已訂有物業管理合約，按 ${discountLabel(discount)} 計價`
                : '目前未設折扣（逕以牌價計價）'}
              {' = '}
              {money(laborPrice(Number(baseDaily) || 0, null, discount))} 元／工
            </div>
          </div>
        </div>

        {/* 手機：僅「倍率」可輸入，其餘唯讀 → 卡片化 */}
        <div className="table-scroll">
          <table className="rwd-table w-full border-collapse">
            <thead>
              <tr>
                <th className="th text-left">名稱</th>
                <th className="th num">倍率</th>
                <th className="th text-left">法源依據</th>
                <th className="th num">牌價</th>
                <th className="th num">折後報價</th>
              </tr>
            </thead>
            <tbody>
              {laborRows.length === 0 && (
                <tr>
                  <td className="td text-center text-ink-500" colSpan={5}>目前沒有工資時段加成資料</td>
                </tr>
              )}
              {laborRows.map((r) => (
                <tr key={r.id}>
                  <td className="td break-words font-medium">{r.name}</td>
                  <td className="td" data-label="倍率">
                    <input
                      type="number"
                      step="0.01"
                      className="field num"
                      value={r.multiplier}
                      onChange={(e) => updateLaborRow(r.id, Number(e.target.value))}
                    />
                  </td>
                  <td className="td break-words" data-label="法源依據">{r.legal_basis}</td>
                  <td className="td num text-ink-500" data-label="牌價">{money(laborListPrice(Number(baseDaily) || 0, r))}</td>
                  <td className="td num text-deep" data-label="折後報價">
                    {money(laborPrice(Number(baseDaily) || 0, r, discount))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 調整折數前的對照參考——唯讀，只列數字不做計算 */}
        <div className="mt-4 rounded-md border border-ink-200 bg-ink-50 p-3 text-xs text-ink-500">
          <div className="mb-2 font-semibold text-ink-700">折數對照參考（唯讀）</div>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              直轄市工程預算參考單價：技術工 375 元／時 × 8 小時 = 3,000 元／工（本系統牌價依據；
              桃園市無等同之年度參考單價，市府價格庫最新訪價停在 110 年 9 月，故不指名縣市）
            </li>
            <li>
              立德新歷史成交：260528 6L 電子紙 3,000 元／工；260520 透析大樓 5,000 元／工；
              20260515 L6F 5,000 元／工
            </li>
            <li>
              勞動部基本工資（115／1／1 起）：時薪 196 元 × 8 小時 = 1,568 元／工（法定下限）
            </li>
          </ul>
          <div className="mt-2">
            折數調整前請確認折後單價仍高於法定下限，且與物業管理合約的服務範圍界線一致。
          </div>
        </div>
      </div>

      <div className="card">
        {/* 手機：標題與儲存區直排，儲存鈕整列寬（好按）；sm 以上恢復左右分置 */}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="card-title mb-0 border-0 pb-0">工率基準</div>
          <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
            {prodSaved && !prodDirty && <span className="text-sm text-green">已儲存</span>}
            {prodError && <span className="break-words text-sm text-warn">{prodError}</span>}
            {prodBadCount > 0 && (
              <span className="break-words text-sm text-warn">有 {prodBadCount} 列工率不大於 0，無法儲存</span>
            )}
            <button
              type="button"
              className="btn btn-primary w-full sm:w-auto"
              disabled={!prodDirty || savingProd || prodBadCount > 0}
              onClick={() => void saveProductivity()}
            >
              {savingProd ? '儲存中…' : '儲存工率'}
            </button>
          </div>
        </div>

        <p className="mb-3 text-xs text-ink-500">
          工率係一名技術工於正常工時（8 小時）之產出基準，用於報價單的工率分析頁向院方說明工資組成。
          調整工率會直接改變該工項的應攤工資：<span className="font-semibold">工率調高＝單價變低</span>。
        </p>

        {/* 手機：八欄橫捲太寬，且每列僅工率與啟用可改 → 卡片化 */}
        <div className="table-scroll">
          <table className="rwd-table w-full border-collapse">
            <thead>
              <tr>
                <th className="th text-left">工項</th>
                <th className="th text-left">單位</th>
                <th className="th num">工率（每工日產出）</th>
                <th className="th num">工資牌價／單位</th>
                <th className="th num">折後單價／單位</th>
                <th className="th text-left">依據</th>
                <th className="th text-left">可信度</th>
                <th className="th text-left">啟用</th>
              </tr>
            </thead>
            <tbody>
              {prodLoading && (
                <tr>
                  <td className="td text-center text-ink-500" colSpan={8}>載入中…</td>
                </tr>
              )}
              {!prodLoading && prodGroups.length === 0 && (
                <tr>
                  <td className="td text-center text-ink-500" colSpan={8}>目前沒有工率基準資料</td>
                </tr>
              )}
              {prodGroups.map((g) => (
                <Fragment key={g.trade}>
                  <tr>
                    <td className="td bg-light/60 font-semibold text-deep" colSpan={8}>
                      {g.trade}
                      <span className="ml-2 font-normal text-ink-500">（{g.rows.length} 項）</span>
                    </td>
                  </tr>
                  {g.rows.map((r) => {
                    const ok = validOutput(r.output_per_manday)
                    const list = unitListPrice(laborBase, r.output_per_manday)
                    const net = unitNetPrice(laborBase, laborDiscount, r.output_per_manday)
                    const tooLow = ok && net < LOW_UNIT_PRICE
                    return (
                      <tr key={r.id} className={ok ? undefined : 'bg-warn-bg'}>
                        {/* 手機卡片化後同一格內的多個元素會變成橫排，故一律包成單一子元素；
                            另外 .rwd-table 的卡片會給 tr 白底，列級 bg-warn-bg 在手機會被蓋掉，
                            所以異常列的底色補在首格（桌機同色不影響觀感） */}
                        <td className={`td${ok ? '' : ' bg-warn-bg'}`}>
                          <div className="min-w-0 break-words">
                            <div className="font-medium">{r.work_item}</div>
                            {r.note && <div className="text-[11px] text-ink-500">{r.note}</div>}
                          </div>
                        </td>
                        <td className="td" data-label="單位">{r.unit}</td>
                        <td className="td" data-label="工率（每工日產出）">
                          <div className="min-w-0 flex-1">
                            <input
                              type="number"
                              step="0.1"
                              min={0.1}
                              className={`field num ${ok ? '' : 'border-warn text-warn'}`}
                              value={r.output_per_manday}
                              onChange={(e) => updateProdRow(r.id, {
                                output_per_manday: Number(e.target.value),
                              })}
                            />
                            {!ok && <div className="mt-1 text-[11px] text-warn">工率必須大於 0</div>}
                            {tooLow && (
                              <div className="mt-1 text-[11px] text-alert">工率偏高，請確認</div>
                            )}
                          </div>
                        </td>
                        <td className="td num text-ink-500" data-label="工資牌價／單位">{ok ? money(list) : '—'}</td>
                        <td className={`td num ${tooLow ? 'text-alert' : 'text-deep'}`} data-label="折後單價／單位">
                          {ok ? money(net) : '—'}
                        </td>
                        <td className="td break-words" data-label="依據" title={r.source || undefined}>
                          {BASIS_LABEL[r.basis] || r.basis}
                        </td>
                        <td className="td" data-label="可信度">
                          <span
                            className={
                              'inline-block rounded-full border px-2 py-0.5 text-[11px] '
                              + (CONFIDENCE_CLASS[r.confidence] || 'border-ink-500 text-ink-500')
                            }
                          >
                            {CONFIDENCE_LABEL[r.confidence] || r.confidence}
                          </span>
                        </td>
                        <td className="td" data-label="啟用">
                          <input
                            type="checkbox"
                            checked={r.active}
                            onChange={(e) => updateProdRow(r.id, { active: e.target.checked })}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-3 text-xs text-ink-500">
          單價依技術工日薪牌價 {money(laborBase)} 元／工
          {discountLabel(laborDiscount) ? `、物業合約 ${discountLabel(laborDiscount)}` : ''}
          換算；折後單價低於 {LOW_UNIT_PRICE} 元／單位者以橘色標示，多半是工率誤打成 10 倍。
        </div>
      </div>
    </div>
  )
}
