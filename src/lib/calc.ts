import type { DraftQuote, DraftSection, LaborRate, MaterialIndex, PriceItem } from '../types'

/** 單行複價 */
export function lineAmount(unitPrice: number, qty: number): number {
  return Math.round((Number(unitPrice) || 0) * (Number(qty) || 0))
}

export interface Totals {
  sections: { key: string; title: string; subtotal: number }[]
  works: number   // 工程小計（各大項加總，未含管理費）
  mgmt: number    // 工程管理費
  sub: number     // 小計（工程小計 + 管理費）
  tax: number     // 營業稅
  total: number   // 合計
}

/**
 * 報價單金額計算 — 全系統唯一的一份公式。
 * 工程小計 → +管理費 → 小計 → +營業稅 → 合計，每層都四捨五入到元。
 */
export function calcTotals(
  sections: DraftSection[],
  mgmtFeeRate: number,
  taxRate: number,
): Totals {
  const secs = sections.map((s) => ({
    key: s.key,
    title: s.title,
    subtotal: s.lines.reduce((a, l) => a + lineAmount(l.unit_price, l.qty), 0),
  }))
  const works = secs.reduce((a, s) => a + s.subtotal, 0)
  const mgmt = Math.round(works * (Number(mgmtFeeRate) || 0))
  const sub = works + mgmt
  const tax = Math.round(sub * (Number(taxRate) || 0))
  return { sections: secs, works, mgmt, sub, tax, total: sub + tax }
}

/**
 * 工資項的實際報價單價 = 牌價 × 物業合約折數 × 勞基法時段係數。
 *
 * 牌價 3,000 元/工 對齊臺北市政府工程預算參考單價之技術工單價（375 元/時 × 8 小時）。
 * 因院方已訂有物業管理合約、該批人力的薪資已由月費支應，故按牌價 9 折計價，
 * 避免對同一客戶就同一段工時收第二次錢（與德新「自行承攬不得再收管理費」同一界線）。
 * 折數由主管在「物價指數」頁維護。
 */
export function laborPrice(baseDaily: number, rate?: LaborRate | null, discount = 1): number {
  return Math.round(baseDaily * (Number(discount) || 1) * (rate ? Number(rate.multiplier) : 1))
}

/** 工資牌價（未打折），與報價並列可讓院方看到物管合約折讓了多少 */
export function laborListPrice(baseDaily: number, rate?: LaborRate | null): number {
  return Math.round(baseDaily * (rate ? Number(rate.multiplier) : 1))
}

/**
 * 原物料指數連動的建議單價。
 * 建議價 = 標準價 × (1 + (現值/基準值 − 1) × 連動係數)
 * 係數代表該品項成本中受此指數影響的比例，指數缺漏時原價回傳。
 */
export function indexedPrice(item: PriceItem, index?: MaterialIndex | null): number {
  if (!index || !item.index_id || !item.index_coeff) return item.std_price
  const base = Number(index.base_value)
  if (!base) return item.std_price
  const delta = Number(index.value) / base - 1
  return Math.round(item.std_price * (1 + delta * Number(item.index_coeff)))
}

/** 報價單上要印給醫院採購看的佐證句 */
export function evidenceSentence(
  item: PriceItem,
  index?: MaterialIndex | null,
  sourceName?: string,
): string {
  const parts: string[] = []
  if (item.evidence_note) parts.push(item.evidence_note)
  if (index && item.index_coeff) {
    const base = Number(index.base_value)
    const pct = base ? ((Number(index.value) / base - 1) * 100) : 0
    parts.push(
      `${sourceName || index.name} ${index.period} 為 ${index.value}${index.unit}` +
      `（基準 ${index.base_period} ${index.base_value}），較基準 ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` +
      `，連動係數 ${(Number(item.index_coeff) * 100).toFixed(0)}%`,
    )
  }
  return parts.join('；')
}

/** 議價讓步幅度（相對原報價的百分比，正數代表讓價） */
export function concessionPct(original: number, final: number): number {
  if (!original) return 0
  return ((original - final) / original) * 100
}

export const money = (n: number): string =>
  (Math.round(Number(n)) || 0).toLocaleString('en-US')

/** 送審前的把關；回傳空陣列代表可以送 */
export function validateQuote(draft: DraftQuote): string[] {
  const bad: string[] = []
  const CN = ['壹', '貳', '參', '肆', '伍', '陸', '柒', '捌', '玖', '拾']
  if (!draft.project.trim()) bad.push('工程地點／案名未填')
  if (!draft.sections.some((s) => s.lines.length)) bad.push('尚未加入任何項目')
  draft.sections.forEach((s, si) => {
    if (s.lines.length && !s.title.trim()) bad.push(`第 ${si + 1} 個大項未命名`)
    s.lines.forEach((l, li) => {
      const at = `${CN[si] || si + 1}、第 ${li + 1} 項`
      if (!(Number(l.qty) > 0)) bad.push(`${at} 數量必須大於 0`)
      if (l.is_custom) {
        if (!l.name.trim()) bad.push(`${at} 臨時項目未填品名`)
        if (!(Number(l.unit_price) > 0)) bad.push(`${at} 臨時項目未填單價`)
        if (!l.reason.trim()) bad.push(`${at} 臨時項目必須填寫理由`)
      }
    })
  })
  return bad
}
