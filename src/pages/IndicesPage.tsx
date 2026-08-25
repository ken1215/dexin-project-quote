import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useRefData } from '../context/RefDataContext'
import { laborCost, laborPrice, money } from '../lib/calc'
import type { LaborRate, MaterialIndex } from '../types'

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

export default function IndicesPage() {
  const refData = useRefData()
  const {
    indices, evidence, laborRates, laborBase, laborMarkup, evidenceOf, loading, error, reload,
  } = refData

  const [rows, setRows] = useState<MaterialIndex[]>([])
  const [laborRows, setLaborRows] = useState<LaborRate[]>([])
  const [baseDaily, setBaseDaily] = useState<number>(laborBase)
  const [markup, setMarkup] = useState<number>(laborMarkup)

  const [savingIdx, setSavingIdx] = useState(false)
  const [idxError, setIdxError] = useState<string | null>(null)
  const [idxSaved, setIdxSaved] = useState(false)

  const [savingLabor, setSavingLabor] = useState(false)
  const [laborError, setLaborError] = useState<string | null>(null)
  const [laborSaved, setLaborSaved] = useState(false)

  useEffect(() => { setRows(indices.map((i) => ({ ...i }))) }, [indices])
  useEffect(() => { setLaborRows(laborRates.map((r) => ({ ...r }))) }, [laborRates])
  useEffect(() => { setBaseDaily(laborBase) }, [laborBase])
  useEffect(() => { setMarkup(laborMarkup) }, [laborMarkup])

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

  async function saveIndices() {
    const changed = rows.filter((r) => {
      const orig = indices.find((i) => i.id === r.id)
      return orig && (orig.period !== r.period || Number(orig.value) !== Number(r.value))
    })
    if (!changed.length) return
    setSavingIdx(true)
    setIdxError(null)
    setIdxSaved(false)
    const { error: upErr } = await supabase.from('material_indices').upsert(
      changed.map((r) => ({
        id: r.id,
        period: r.period,
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
    const markupChanged = Number(markup) !== Number(laborMarkup)
    if (!changedRates.length && !baseChanged && !markupChanged) return
    setSavingLabor(true)
    setLaborError(null)
    setLaborSaved(false)

    if (changedRates.length) {
      const { error: upErr } = await supabase.from('labor_rates').upsert(
        changedRates.map((r) => ({ id: r.id, multiplier: Number(r.multiplier) || 0 })),
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
    if (markupChanged) {
      const { error: upErr } = await supabase
        .from('settings')
        .upsert({ key: 'labor_markup', value: Number(markup) || 1 }, { onConflict: 'key' })
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
    || Number(markup) !== Number(laborMarkup)

  if (loading) return <div className="p-6 text-ink-500">載入中…</div>

  return (
    <div className="space-y-6 p-6">
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
                <li key={s.id}>
                  {s.name}（{s.publisher}）
                  {s.url ? (
                    <>
                      {' — '}
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-bright underline hover:text-deep"
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
        <div className="mb-3 flex items-center justify-between">
          <div className="card-title mb-0 border-0 pb-0">指數清單</div>
          <div className="flex items-center gap-3">
            {idxSaved && !idxDirty && <span className="text-sm text-green">已儲存</span>}
            {idxError && <span className="text-sm text-warn">{idxError}</span>}
            <button
              type="button"
              className="btn btn-primary"
              disabled={!idxDirty || savingIdx}
              onClick={() => void saveIndices()}
            >
              {savingIdx ? '儲存中…' : '儲存'}
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
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
                    <td className="td">{r.name}</td>
                    <td className="td">{r.unit}</td>
                    <td className="td">{r.base_period}</td>
                    <td className="td num">{r.base_value}</td>
                    <td className="td">
                      <input
                        className="field"
                        value={r.period}
                        onChange={(e) => updateRow(r.id, { period: e.target.value })}
                      />
                    </td>
                    <td className="td">
                      <input
                        type="number"
                        step="0.01"
                        className="field num"
                        value={r.value}
                        onChange={(e) => updateRow(r.id, { value: Number(e.target.value) })}
                      />
                    </td>
                    <td className={`td num ${pctClass(pct)}`}>
                      {pct >= 0 ? '+' : ''}{pct.toFixed(1)}%
                    </td>
                    <td className="td">
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
                    <td className="td">{fmtDateTime(r.updated_at)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="mb-3 flex items-center justify-between">
          <div className="card-title mb-0 border-0 pb-0">工資時段加成表</div>
          <div className="flex items-center gap-3">
            {laborSaved && !laborDirty && <span className="text-sm text-green">已儲存</span>}
            {laborError && <span className="text-sm text-warn">{laborError}</span>}
            <button
              type="button"
              className="btn btn-primary"
              disabled={!laborDirty || savingLabor}
              onClick={() => void saveLabor()}
            >
              {savingLabor ? '儲存中…' : '儲存'}
            </button>
          </div>
        </div>

        <div className="mb-4 flex flex-wrap items-start gap-6">
          <div>
            <label className="label">基準日薪／成本（元／日，來自 settings.labor_base_daily）</label>
            <input
              type="number"
              step="1"
              className="field num"
              style={{ width: '10rem' }}
              value={baseDaily}
              onChange={(e) => { setBaseDaily(Number(e.target.value)); setLaborSaved(false) }}
            />
          </div>
          <div>
            <label className="label">工資加成係數（來自 settings.labor_markup）</label>
            <input
              type="number"
              step="0.01"
              className="field num"
              style={{ width: '10rem' }}
              value={markup}
              onChange={(e) => { setMarkup(Number(e.target.value)); setLaborSaved(false) }}
            />
            <div className="mt-1 text-xs text-ink-500">
              {money(baseDaily)} 為成本基準，報價 = 成本 × 加成係數。
              目前 ×{Number(markup) || 1} = {money(laborPrice(Number(baseDaily) || 0, null, markup))} 元／工
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="th text-left">名稱</th>
                <th className="th num">倍率</th>
                <th className="th text-left">法源依據</th>
                <th className="th num">成本（未加成）</th>
                <th className="th num">報價（含加成）</th>
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
                  <td className="td">{r.name}</td>
                  <td className="td">
                    <input
                      type="number"
                      step="0.01"
                      className="field num"
                      value={r.multiplier}
                      onChange={(e) => updateLaborRow(r.id, Number(e.target.value))}
                    />
                  </td>
                  <td className="td">{r.legal_basis}</td>
                  <td className="td num text-ink-500">{money(laborCost(Number(baseDaily) || 0, r))}</td>
                  <td className="td num text-deep">
                    {money(laborPrice(Number(baseDaily) || 0, r, markup))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 調整加成係數前的對照參考——唯讀，只列數字不做計算 */}
        <div className="mt-4 rounded-md border border-ink-200 bg-ink-50 p-3 text-xs text-ink-500">
          <div className="mb-2 font-semibold text-ink-700">加成係數對照參考（唯讀）</div>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              臺北市政府 112 年度工程預算參考單價：技術工 375 元／時 × 8 小時 = 3,000 元／工；
              普通工 280 元／時 × 8 小時 = 2,240 元／工
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
            調整加成係數前請先對照上列數字，避免報價低於自家歷史成交或官方參考單價。
          </div>
        </div>
      </div>
    </div>
  )
}
