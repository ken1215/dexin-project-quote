/**
 * 金額邏輯自我檢查 — 錢的路徑不能只靠肉眼看。
 * 執行：node --experimental-strip-types src/lib/calc.test.ts
 */
import assert from 'node:assert/strict'
import {
  calcTotals, concessionPct, indexedPrice, laborCost, laborPrice, lineAmount, validateQuote,
} from './calc.ts'
import type { DraftQuote, DraftSection, LaborRate, MaterialIndex, PriceItem } from '../types.ts'

const line = (o: Partial<DraftSection['lines'][0]> = {}) => ({
  key: 'k', item_id: null, labor_rate_id: null, name: '測試', spec: '', unit: '式',
  unit_price: 0, qty: 1, is_custom: false, reason: '', note: '', ...o,
})

// ── 1. 單行複價 ────────────────────────────────────────────────
assert.equal(lineAmount(101, 20), 2020)
assert.equal(lineAmount(0, 20), 0)
assert.equal(lineAmount(100.4, 3), 301, '小數應四捨五入到元')

// ── 2. 金額鏈：工程小計 → 管理費 9% → 小計 → 稅 5% → 合計 ──────
{
  const secs: DraftSection[] = [
    { key: 'a', title: '配電工程', lines: [line({ unit_price: 134, qty: 20 })] }, // 2,680
  ]
  const t = calcTotals(secs, 0.09, 0.05)
  assert.equal(t.works, 2680)
  assert.equal(t.mgmt, 241)          // 2680 × 0.09 = 241.2 → 241
  assert.equal(t.sub, 2921)
  assert.equal(t.tax, 146)           // 2921 × 0.05 = 146.05 → 146
  assert.equal(t.total, 3067)
}

// 對照歷史報價單實例（260825 神經醫學中心，原件用 10%）
{
  const secs: DraftSection[] = [
    { key: 'a', title: '配電工程', lines: [line({ unit_price: 6620, qty: 1 })] },
  ]
  const t = calcTotals(secs, 0.1, 0.05)
  assert.equal(t.mgmt, 662, '對得上原始報價單的管理費')
  assert.equal(t.sub, 7282)
  assert.equal(t.tax, 364)
  assert.equal(t.total, 7646, '對得上原始報價單的合計')
}

// 多大項（進、排氣工程那種案子）
{
  const secs: DraftSection[] = [
    { key: 'a', title: '進氣工程', lines: [line({ unit_price: 1000, qty: 3 })] },
    { key: 'b', title: '排氣工程', lines: [line({ unit_price: 500, qty: 4 })] },
  ]
  const t = calcTotals(secs, 0.09, 0.05)
  assert.equal(t.sections.length, 2)
  assert.equal(t.sections[0].subtotal, 3000)
  assert.equal(t.sections[1].subtotal, 2000)
  assert.equal(t.works, 5000)
}

// 空單不應該爆
assert.equal(calcTotals([], 0.09, 0.05).total, 0)

// ── 3. 工資：2,800 × 勞基法時段係數 ────────────────────────────
const rate = (id: string, m: number): LaborRate =>
  ({ id, name: id, multiplier: m, legal_basis: '', sort: 0, active: true })

// 成本（未加成）：2,800 × 時段係數
assert.equal(laborCost(2800, rate('weekday', 1)), 2800)
assert.equal(laborCost(2800, rate('overtime', 1.34)), 3752)
assert.equal(laborCost(2800, rate('restday', 1.67)), 4676)
assert.equal(laborCost(2800, rate('holiday', 2)), 5600)
assert.equal(laborCost(2800, null), 2800, '沒選時段就用基準日薪')

// 報價 = 成本 × 加成係數 × 時段係數。2,800 是成本基準，不是報價值。
assert.equal(laborPrice(2800, rate('weekday', 1), 1.15), 3220)
assert.equal(laborPrice(2800, rate('holiday', 2), 1.15), 6440)
assert.equal(laborPrice(2800, null, 1.15), 3220)
assert.equal(laborPrice(2800, rate('weekday', 1)), 2800, '沒給係數時退回成本，不可意外加成')

// 加成後的平日報價要站得住：不低於法定下限，也不低於官方技術工參考單價
assert.ok(laborPrice(2800, rate('weekday', 1), 1.15) >= 196 * 8, '高於法定下限 1,568')
assert.ok(laborPrice(2800, rate('weekday', 1), 1.15) >= 3000,
  '不低於臺北市 112 年度參考單價之技術工 3,000 元/工——低於這個數字就是自己砍自己')

// ── 4. 指數連動建議價 ──────────────────────────────────────────
const item = (o: Partial<PriceItem> = {}): PriceItem => ({
  id: 'x', category_id: 'power', name: '電纜線', spec: '', unit: '米',
  cost_type: 'material', std_price: 100, evidence_id: null, evidence_note: '',
  index_id: null, index_coeff: 0, price_min: null, price_max: null, price_median: null,
  samples: 0, last_seen: '', last_price: null, needs_area: false, active: true, sort: 0, ...o,
})
const idx = (base: number, val: number): MaterialIndex => ({
  id: 'copper', name: '銅價', source_id: null, unit: '', base_period: '', base_value: base,
  period: '', value: val, updated_at: '',
})
// 指數漲 20%、連動係數 55% → 100 × (1 + 0.2×0.55) = 111
assert.equal(indexedPrice(item({ index_id: 'copper', index_coeff: 0.55 }), idx(100, 120)), 111)
// 指數跌 10%、係數 50% → 100 × (1 − 0.05) = 95
assert.equal(indexedPrice(item({ index_id: 'copper', index_coeff: 0.5 }), idx(100, 90)), 95)
// 沒掛指數 / 沒有指數資料 / 基準值為 0 → 一律回原價，不能算出 NaN 或 Infinity
assert.equal(indexedPrice(item(), idx(100, 200)), 100)
assert.equal(indexedPrice(item({ index_id: 'copper', index_coeff: 0.5 }), null), 100)
assert.equal(indexedPrice(item({ index_id: 'copper', index_coeff: 0.5 }), idx(0, 200)), 100)

// ── 5. 議價讓步幅度 ────────────────────────────────────────────
assert.equal(concessionPct(1000, 900), 10)
assert.equal(concessionPct(1000, 1000), 0)
assert.equal(concessionPct(0, 100), 0, '原價為 0 不能除以零')
assert.ok(concessionPct(1000, 1100) < 0, '漲價回傳負數')

// ── 6. 送審把關 ────────────────────────────────────────────────
const draft = (secs: DraftSection[], project = '測試案'): DraftQuote => ({
  project, dept: '', contact: '', quote_date: '2026-08-25', status: 'draft', sections: secs,
})
assert.deepEqual(
  validateQuote(draft([{ key: 'a', title: '配電工程', lines: [line({ unit_price: 100, qty: 1 })] }])),
  [], '正常單應該可以送審',
)
assert.ok(validateQuote(draft([], '')).some((m) => m.includes('案名')), '沒填案名要擋')
assert.ok(validateQuote(draft([])).some((m) => m.includes('尚未加入')), '空單要擋')
assert.ok(
  validateQuote(draft([{ key: 'a', title: 'X', lines: [line({ unit_price: 100, qty: 0 })] }]))
    .some((m) => m.includes('數量')),
  '數量 0 要擋',
)
{
  // 臨時項目三個必填欄位各缺一個都要擋
  const custom = (o: Record<string, unknown>) =>
    validateQuote(draft([{ key: 'a', title: 'X', lines: [line({ is_custom: true, ...o })] }]))
  assert.ok(custom({ name: '', unit_price: 100, reason: 'r' }).some((m) => m.includes('品名')))
  assert.ok(custom({ name: 'n', unit_price: 0, reason: 'r' }).some((m) => m.includes('單價')))
  assert.ok(custom({ name: 'n', unit_price: 100, reason: '' }).some((m) => m.includes('理由')))
  assert.deepEqual(custom({ name: 'n', unit_price: 100, reason: '無標準品項' }), [])
}

console.log('calc.ts 自我檢查全數通過')
