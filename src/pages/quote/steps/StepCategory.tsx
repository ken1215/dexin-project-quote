import { useMemo, useState } from 'react'
import ConfirmPanel from '../../../components/ui/ConfirmPanel'
import EmptyState from '../../../components/ui/EmptyState'
import { useRefData } from '../../../context/RefDataContext'
import type { StepCategoryProps } from '../QuoteWizard'

/**
 * ② 大項：「這次是哪一類工程？可以複選」。
 *
 * 大類只是 ③ 的篩選條件，**不寫進 draft、更不預建 DraftSection**——
 * 大項一律由 addItem 依 Category.section_title 自動長出。
 * 預建的空大項會被 persist 寫成「工程項目 N」並印進 A4 標單（紅線 3）。
 * 本檔只呼叫 onSelect／onUnselect 回報勾選狀態，完全不碰 draft。
 *
 * 取消勾選時若該大類已有明細（lineCountOf > 0），先用 ui/ConfirmPanel 二次確認再移除。
 *
 * 「可用品項數」不在 StepCategoryProps 裡（契約已定版、本次不得改），
 * 所以直接向 RefDataContext 取 items 自行統計——這是唯讀的共用參考資料，
 * QuoteWizard 自己也是從同一個 context 拿，不會有第二份真相。
 *
 * ── 與本次指派說明的偏離（同 StepSite，契約逼出來的）──
 * 步驟說明句與底部「上一步」「下一步：挑細項」＋停用原因，QuoteWizard 已統一持有
 * （STEP_HINT[1]／NEXT_LABEL[1]／BLOCK_REASON[1]）；StepCategoryProps 沒有
 * onNext／onPrev，要加就得改 QuoteWizard 契約（本次嚴禁），且會讓同一顆按鈕
 * 在手機釘底列與步驟內各出現一次（規格紅線）。故這裡不重複。
 */
export default function StepCategory(
  { categories, selectedIds, lineCountOf, onSelect, onUnselect }: StepCategoryProps,
) {
  const { items } = useRefData()
  const [pendingId, setPendingId] = useState<string | null>(null)

  /** 每個大類底下「現在挑得到」的品項數＝active 的才算，停用品項不會出現在 ③ */
  const itemCountOf = useMemo(() => {
    const m = new Map<string, number>()
    for (const i of items) {
      if (!i.active) continue
      m.set(i.category_id, (m.get(i.category_id) ?? 0) + 1)
    }
    return m
  }, [items])

  /**
   * 待確認的大類在 **render 當下**推導：pendingId 指到的大類若已經不在勾選集合裡
   * （例如在別處被移除、或套用了暫存草稿），確認卡自然消失，不需要 useEffect 清 state
   * （effect 內 setState 會新增 react(set-state-in-effect) 警告）。
   */
  const pending = pendingId !== null && selectedIds.includes(pendingId)
    ? (categories.find((c) => c.id === pendingId) ?? null)
    : null

  const toggle = (id: string) => {
    if (!selectedIds.includes(id)) {
      setPendingId(null)
      onSelect(id)
      return
    }
    // 已經有明細的大類，取消勾選＝連明細一起刪，先問過再動
    if (lineCountOf(id) > 0) { setPendingId(id); return }
    setPendingId(null)
    onUnselect(id)
  }

  const pickable = selectedIds.reduce((a, id) => a + (itemCountOf.get(id) ?? 0), 0)

  return (
    <div className="card">
      <div className="card-title">② 大項分類</div>

      {categories.length === 0 ? (
        <EmptyState
          title="沒有可選的工程大類"
          hint="單價庫還沒有分類資料，請先請工務處長維護單價庫。"
        />
      ) : (
        <>
          <div className="mb-3 text-sm text-ink-500">
            可以複選。拆除、水電、空調同一張單也沒問題，挑到的類別會決定下一步看得到哪些項目。
          </div>

          <div className="flex flex-wrap gap-2">
            {categories.map((c) => {
              const on = selectedIds.includes(c.id)
              const avail = itemCountOf.get(c.id) ?? 0
              const used = lineCountOf(c.id)
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`chip ${on ? 'chip-on' : ''}`}
                  aria-pressed={on}
                  onClick={() => toggle(c.id)}
                >
                  <span>{c.name}</span>
                  <span className={`ml-1.5 text-xs ${on ? 'text-white/75' : 'text-ink-500'}`}>
                    {avail} 項{used > 0 ? ` · 已加 ${used}` : ''}
                  </span>
                </button>
              )
            })}
          </div>

          <div className="mt-3 text-sm text-ink-700">
            {selectedIds.length === 0
              ? '還沒選任何大類。'
              : `已選 ${selectedIds.length} 類，下一步可以挑 ${pickable} 項。`}
          </div>

          {/* 確認卡就放在 chip 那一排下面，觸發的地方跟確認的地方在同一處 */}
          {pending && (
            <div className="mt-3">
              <ConfirmPanel
                tone="danger"
                title={`取消「${pending.name}」會一併刪掉已加入的明細`}
                confirmLabel={`刪掉 ${lineCountOf(pending.id)} 項明細並取消勾選`}
                onConfirm={() => { onUnselect(pending.id); setPendingId(null) }}
                onCancel={() => setPendingId(null)}
              >
                這個大類底下已經有 {lineCountOf(pending.id)} 項明細。
                取消勾選會把這些明細一起刪掉，刪掉之後救不回來。
                只是想少報幾項的話，回第 3 步逐項刪比較安全。
              </ConfirmPanel>
            </div>
          )}
        </>
      )}
    </div>
  )
}
