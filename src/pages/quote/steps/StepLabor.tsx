import { useState } from 'react'
import Alert from '../../../components/ui/Alert'
import EmptyState from '../../../components/ui/EmptyState'
import Stat from '../../../components/ui/Stat'
import { discountLabel } from '../../../hooks/useQuoteDraft'
import { laborListPrice, laborPrice, lineAmount, money } from '../../../lib/calc'
import type { DraftLine } from '../../../types'
import type { StepLaborProps } from '../QuoteWizard'

/**
 * ④ 工資：「要派幾個人、做幾天？什麼時段？」——本次改版的重點。
 *
 * 現行單價庫只剩 `lb-tech-day 技術工日薪` 一個 active 的按「工」計價品項，
 * 而 addItem 對同一 item_id 是「數量 +1 合併」，一張單表達不出「3 工平日＋2 工休息日」。
 * 所以這一步不挑品項，改用試算面板直接產生明細列（呼叫 useQuoteDraft.addLaborLine）。
 *
 * 幾條不能破的規則：
 * - **即時試算**：打字就重算，沒有「按計算」鈕（那正是引導不足的症狀）。
 *   所有數字都在 render 當下由輸入值推導，不在 effect 內 setState
 *   （effect 內 setState 會新增 react(set-state-in-effect) 警告）。
 * - 金額一律呼叫 calc.ts 的 laborPrice／laborListPrice／lineAmount，這裡不另寫公式。
 * - **牌價與折讓要顯示**（那是給院方的好處、是賣點）；
 *   **工資成本與加成係數一律不顯示**——本元件的 props 也刻意拿不到成本。
 *   時段係數（multiplier）同樣不上畫面：chip 只寫時段名稱，單價差異由試算卡的
 *   「每工報價」直接講金額，同仁不必自己換算係數。
 * - ④ 的完成判定恆真（在 QuoteWizard），不是每張單都有純工資項，不得擋人。
 */

/** 面板預設值：工項說明「技術工」、1 人、1 天；時段預設取 laborRates 第一檔（依 sort ＝ 平日） */
const DEFAULT_NAME = '技術工'
const DEFAULT_HEADCOUNT = '1'
const DEFAULT_DAYS = '1'

/** 顯示用數字：3 → 「3」、1.5 → 「1.5」；截到小數第二位，避免浮點尾數 */
const fmt = (n: number): string => String(Math.round(n * 100) / 100)

/**
 * 回填重算的來源是 addLaborLine 寫進去的 spec（`N 人 × M 天`）。
 * 這是本系統自己產生的機器格式、不是使用者輸入的自由文字，所以可以直接比對；
 * 解析不出來（例如舊單被手改過）就退回「1 人 × 該列工數 天」，工數不會跑掉。
 */
const SPEC_RE = /^(\d+(?:\.\d+)?)\s*人\s*×\s*(\d+(?:\.\d+)?)\s*天$/

export default function StepLabor({
  laborRates, laborBase, laborDiscount, rateById, laborLines, onAdd, onRemoveLaborLine,
}: StepLaborProps) {
  // 數字欄位用字串存：存 number 的話使用者一清空欄位就會被迫塞 0，游標也會跳掉
  const [name, setName] = useState(DEFAULT_NAME)
  const [headcount, setHeadcount] = useState(DEFAULT_HEADCOUNT)
  const [days, setDays] = useState(DEFAULT_DAYS)
  const [pickedRate, setPickedRate] = useState('')
  /** 正在重算的那一列；按下「更新」時連同新列一起處理，同一筆不會變成兩列 */
  const [editingKey, setEditingKey] = useState<string | null>(null)

  /* ── 即時試算：全部在 render 當下推導 ─────────────────────── */
  // 還沒選、或選到的時段已被主管停用時，一律回到第一檔（依 sort ＝ 平日）。
  // 這種「修正非法選擇」的事一旦寫成 useEffect + setState 就會多一條 lint 警告。
  const rateId = pickedRate && rateById.has(pickedRate) ? pickedRate : (laborRates[0]?.id ?? '')
  const rate = rateById.get(rateId)

  const hc = Number.parseInt(headcount, 10)
  const dy = Number(days)
  const nameOk = name.trim() !== ''
  const hcOk = Number.isInteger(hc) && hc >= 1
  const dyOk = Number.isFinite(dy) && dy >= 0.5
  const inputsOk = hcOk && dyOk

  const qty = inputsOk ? hc * dy : 0
  const unitPrice = laborPrice(laborBase, rate, laborDiscount)
  const listUnit = laborListPrice(laborBase, rate)
  const subtotal = lineAmount(unitPrice, qty)
  const listSubtotal = lineAmount(listUnit, qty)
  const saved = listSubtotal - subtotal

  const canAdd = nameOk && inputsOk && Boolean(rate)
  const blockReason = !laborRates.length
    ? '時段資料尚未載入，請重新整理頁面。'
    : !nameOk ? '請填工項說明（例：技術工、拆除工、水電工）'
      : !hcOk ? '人數請填 1 以上的整數'
        : !dyOk ? '天數請填 0.5 以上（半天以 0.5 計）'
          : ''

  /** 白話算式：同仁看得懂的一句話，金額全部取自上面算好的值 */
  const sentence = canAdd && rate
    ? `${fmt(hc)} 人 × ${fmt(dy)} 天 ＝ ${fmt(qty)} 工，${rate.name}每工 ${money(unitPrice)} 元，`
      + `小計 ${money(subtotal)} 元（牌價 ${money(listSubtotal)}，物管合約折讓 ${money(saved)}）`
    : '填好工項、人數與天數，這裡就會自動算出金額，不用按任何計算鈕。'

  const reset = () => {
    setName(DEFAULT_NAME)
    setHeadcount(DEFAULT_HEADCOUNT)
    setDays(DEFAULT_DAYS)
    setPickedRate('')
    setEditingKey(null)
  }

  const submit = () => {
    if (!canAdd) return
    onAdd({ name: name.trim(), headcount: hc, days: dy, rateId })
    // 重算模式：新列加進去之後才刪掉舊列。兩個動作都是 setDraft 的函式型更新，
    // React 會在同一次更新裡依序套用，不會互相蓋掉。
    if (editingKey) onRemoveLaborLine(editingKey)
    reset()
  }

  /** 點已加入的列 → 帶回面板重算；加入後原列會被取代 */
  const refill = (l: DraftLine) => {
    const m = SPEC_RE.exec(l.spec)
    setName(l.name)
    setHeadcount(m ? m[1] : '1')
    setDays(m ? m[2] : String(Number(l.qty) || 0))
    setPickedRate(l.labor_rate_id ?? '')
    setEditingKey(l.key)
    window.scrollTo({ top: 0 })
  }

  return (
    <div className="space-y-4">
      <div className="card max-w-2xl">
        <div className="card-title">④ 工資試算</div>

        <p className="mb-3 text-sm text-ink-700">
          這一步只在「這批人要另外算錢」時才填。多數工料品項的單價裡已經含工率，
          沒有純工資要報就直接按下一步，不影響送審。
        </p>

        {!laborRates.length && (
          <Alert kind="warn" title="沒有可用的時段">
            單價庫裡沒有啟用中的工資時段，請洽主管設定後再回到這一步。
          </Alert>
        )}

        {/* 四個輸入單欄排列：同仁一次只面對一個決定，不並排成一列 */}
        <div className="space-y-3">
          <div>
            <label className="label" htmlFor="labor-name">工項說明</label>
            <input
              id="labor-name"
              className="field"
              value={name}
              placeholder="技術工／拆除工／水電工"
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div>
            <label className="label" htmlFor="labor-headcount">人數（人）</label>
            <input
              id="labor-headcount"
              className="field num"
              type="number"
              min={1}
              step={1}
              value={headcount}
              onChange={(e) => setHeadcount(e.target.value)}
            />
          </div>

          <div>
            <label className="label" htmlFor="labor-days">天數（天，半天以 0.5 計）</label>
            <input
              id="labor-days"
              className="field num"
              type="number"
              min={0.5}
              step="0.5"
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          </div>

          <div>
            <span className="label">時段</span>
            <div className="flex flex-wrap gap-2">
              {laborRates.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`chip ${r.id === rateId ? 'chip-on' : ''}`}
                  aria-pressed={r.id === rateId}
                  onClick={() => setPickedRate(r.id)}
                >{r.name}</button>
              ))}
            </div>
            {rate?.legal_basis && (
              <div className="mt-1 text-[0.6875rem] text-ink-500">{rate.legal_basis}</div>
            )}
          </div>
        </div>

        {/* 試算卡：打字就變。牌價與折讓要顯示，成本與加成係數不顯示 */}
        <div className="mt-4 rounded-md border border-ink-200 bg-ink-50 p-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat
              label="工數"
              value={inputsOk ? `${fmt(qty)} 工` : '—'}
              hint={inputsOk ? `${fmt(hc)} 人 × ${fmt(dy)} 天` : '人數與天數填好才算'}
            />
            <Stat
              label="每工報價"
              value={rate ? money(unitPrice) : '—'}
              hint={rate ? `牌價 ${money(listUnit)}` : undefined}
            />
            <Stat
              label="小計"
              value={inputsOk && rate ? money(subtotal) : '—'}
              hint={inputsOk && rate ? `牌價 ${money(listSubtotal)}` : undefined}
            />
            <Stat
              label="物管合約折讓"
              value={inputsOk && rate ? money(saved) : '—'}
              hint={discountLabel(laborDiscount) ?? '物管合約未設折扣'}
            />
          </div>
          <p className="mt-3 text-sm text-ink-700">{sentence}</p>
        </div>

        {editingKey && (
          <div className="mt-3">
            <Alert kind="info">
              正在重算已加入的那一筆，按下「更新這筆工資」會取代原本那一列。
            </Alert>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canAdd}
            onClick={submit}
          >{editingKey ? '更新這筆工資' : '加入這筆工資'}</button>
          {editingKey && (
            <button type="button" className="btn" onClick={reset}>取消重算</button>
          )}
          {/* 停用原因寫在鈕旁邊，不要只是把鈕灰掉 */}
          {!canAdd && blockReason && (
            <span className="text-sm text-alert">{blockReason}</span>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-title">已加入的工資（{laborLines.length} 筆）</div>
        {laborLines.length === 0 ? (
          <EmptyState
            title="還沒有加入工資"
            hint="填好上面四欄按「加入這筆工資」；可以連續加多筆，例如平日 3 工＋休息日 2 工。"
          />
        ) : (
          <ul className="space-y-2">
            {laborLines.map((l) => {
              const r = l.labor_rate_id ? rateById.get(l.labor_rate_id) : undefined
              return (
                <li
                  key={l.key}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-ink-200 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="break-words text-ink-900">{l.name}</div>
                    <div className="break-words text-[0.6875rem] text-ink-500">
                      {l.spec}
                      {r ? ` · ${r.name}` : ''}
                      {` · ${fmt(Number(l.qty) || 0)} 工 × ${money(l.unit_price)} 元`}
                    </div>
                  </div>
                  <span className="num text-ink-900">{money(lineAmount(l.unit_price, l.qty))}</span>
                  <button type="button" className="btn" onClick={() => refill(l)}>回填重算</button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => onRemoveLaborLine(l.key)}
                  >刪除</button>
                </li>
              )
            })}
          </ul>
        )}
        {/* 第 3 步的明細表才是可編輯的那一份（⑤ 是唯讀預覽），所以改大項一律回 ③。
            把工資列全刪光會留下一個空的「人工費用」大項，persist 會照寫、A4 標單就多一塊
            只有表頭的空區塊；本步驟的 props 只有 onRemoveLaborLine、拿不到 removeSection，
            所以在這裡講清楚該去哪裡收尾，而不是讓同仁自己踩到。 */}
        <p className="mt-3 text-[0.6875rem] text-ink-500">
          這些列會落在「人工費用」這個大項。要移到別的大項、或把工資全刪光之後要移除空的
          「人工費用」大項，都請回第 3 步的明細表處理（空大項會在列印標單上留一塊空白區）。
        </p>
      </div>
    </div>
  )
}
