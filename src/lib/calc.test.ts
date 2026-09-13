/**
 * 金額邏輯自我檢查 — 錢的路徑不能只靠肉眼看。
 * 執行：node --experimental-strip-types src/lib/calc.test.ts
 */
import assert from 'node:assert/strict'
import {
  calcTotals, concessionPct, indexedPrice, laborListPrice, laborPrice, lineAmount, validateQuote,
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

// 牌價（未折扣）：3,000 × 時段係數
assert.equal(laborListPrice(3000, rate('weekday', 1)), 3000)
assert.equal(laborListPrice(3000, rate('overtime', 1.34)), 4020)
assert.equal(laborListPrice(3000, rate('restday', 1.67)), 5010)
assert.equal(laborListPrice(3000, rate('holiday', 2)), 6000)
assert.equal(laborListPrice(3000, null), 3000, '沒選時段就用牌價日薪')

// 實際報價 = 牌價 × 物業合約 9 折 × 時段係數
assert.equal(laborPrice(3000, rate('weekday', 1), 0.9), 2700)
assert.equal(laborPrice(3000, rate('overtime', 1.34), 0.9), 3618)
assert.equal(laborPrice(3000, rate('restday', 1.67), 0.9), 4509)
assert.equal(laborPrice(3000, rate('holiday', 2), 0.9), 5400)
assert.equal(laborPrice(3000, null, 0.9), 2700)
assert.equal(laborPrice(3000, rate('weekday', 1)), 3000, '沒給折數時等於牌價，不可意外打折')

// 護欄：折後平日工資仍須高於法定下限（基本時薪 196 × 8h = 1,568）
assert.ok(laborPrice(3000, rate('weekday', 1), 0.9) >= 196 * 8, '高於法定下限 1,568')
// 護欄：折數不得低於 0.6，否則折後低於基本工資水準、也不像正常商業折讓
assert.ok(laborPrice(3000, rate('weekday', 1), 0.6) >= 196 * 8, '折到 6 折仍高於法定下限')

// ── 3b. ④ 工資試算：人數 × 天數 × 每工報價 ＝ 明細列小計 ────────
// 五步精靈第 ④ 步（StepLabor 面板 ＋ useQuoteDraft.addLaborLine）產生工資列的規則：
// 工數 ＝ 人數 × 天數（半天以 0.5 計），單價 ＝ laborPrice(牌價, 時段, 物管折數)。
// 這裡把「試算面板上顯示的小計」與「該列進到單子之後 calcTotals 算出的大項小計」
// 釘成同一個數字——兩邊各自算一次的話，同仁按下加入前看到的金額，
// 跟送給處長核可的金額有機會對不起來，而那是肉眼最不容易發現的一種錯。
// 突變測試確認過這段會紅：laborPrice 漏乘折數 → 5,010 !== 4,509；
// lineAmount 改成加法 → 4,512 !== 13,527。
{
  const restday = rate('restday', 1.67)
  const headcount = 2
  const days = 1.5

  const qty = headcount * days
  const unitPrice = laborPrice(3000, restday, 0.9)
  assert.equal(qty, 3, '2 人 × 1.5 天 ＝ 3 工')
  assert.equal(unitPrice, 4509, '休息日每工報價 ＝ 3,000 × 1.67 × 9 折')

  const subtotal = lineAmount(unitPrice, qty)
  assert.equal(subtotal, 13527, '人數 × 天數 × 每工報價 ＝ 該列小計')

  // addLaborLine 寫進 draft 的就是這個形狀（unit「工」、qty ＝ 人數×天數、
  // unit_price ＝ laborPrice），所以大項小計必須等於上面試算出來的小計。
  const secs: DraftSection[] = [{
    key: 'labor',
    title: '人工費用',
    lines: [line({
      labor_rate_id: restday.id, name: '技術工',
      spec: `${headcount} 人 × ${days} 天`, unit: '工',
      unit_price: unitPrice, qty,
    })],
  }]
  const t = calcTotals(secs, 0.09, 0.05)
  assert.equal(t.sections[0].subtotal, 13527, '明細列小計與試算面板算出來的是同一個數字')
  assert.equal(t.works, 13527)

  // 牌價並列是給院方看的好處，折讓金額必須等於「牌價小計 − 報價小計」
  const listSubtotal = lineAmount(laborListPrice(3000, restday), qty)
  assert.equal(listSubtotal, 15030, '牌價小計 ＝ 3 工 × 5,010')
  assert.equal(listSubtotal - subtotal, 1503, '物管合約折讓 ＝ 牌價小計 − 報價小計')

  // 混時段（平日 3 工 ＋ 休息日 2 工）——④ 之所以不走 addItem 的理由：
  // 同一張單要放得下兩種時段，兩列各自算完再加總才是大項小計。
  const weekday = rate('weekday', 1)
  const mixed: DraftSection[] = [{
    key: 'labor', title: '人工費用',
    lines: [
      line({ key: 'w', unit: '工', unit_price: laborPrice(3000, weekday, 0.9), qty: 3 }),
      line({ key: 'r', unit: '工', unit_price: laborPrice(3000, restday, 0.9), qty: 2 }),
    ],
  }]
  assert.equal(
    calcTotals(mixed, 0.09, 0.05).sections[0].subtotal, 17118,
    '平日 3 工（2,700）＋ 休息日 2 工（4,509）＝ 17,118',
  )
}

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
// 零元標準品項：沒註明理由要擋、註明了才放行（與資料庫 draft->submitted 的檢查同一條規則）
assert.ok(
  validateQuote(draft([{ key: 'a', title: 'X', lines: [line({ unit_price: 0, qty: 1 })] }]))
    .some((m) => m.includes('單價 0 元須在理由欄註明')),
  '零元且未註明理由要擋',
)
assert.deepEqual(
  validateQuote(draft([
    { key: 'a', title: 'X', lines: [line({ unit_price: 0, qty: 1, reason: '業主自購' })] },
  ])),
  [], '零元但已註明理由要放行',
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
