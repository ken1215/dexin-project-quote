export type Role = 'staff' | 'manager'
export type CostType = 'material' | 'consumable' | 'labor' | 'other'
export type QuoteStatus =
  | 'draft' | 'submitted' | 'approved' | 'negotiating' | 'closed' | 'rejected'
export type NegoResponse = 'accept' | 'partial' | 'hold'
export type EvidenceKind = 'index' | 'law' | 'market' | 'history'

export interface Profile {
  id: string
  full_name: string
  role: Role
  active: boolean
}

export interface Category {
  id: string
  name: string
  /** 加入該分類品項時自動帶入的工程大項名稱 */
  section_title: string
  sort: number
}

export interface EvidenceSource {
  id: string
  kind: EvidenceKind
  name: string
  publisher: string
  url: string
  note: string
}

export interface MaterialIndex {
  id: string
  name: string
  source_id: string | null
  unit: string
  base_period: string
  base_value: number
  period: string
  value: number
  updated_at: string
}

export interface PriceItem {
  id: string
  category_id: string
  name: string
  spec: string
  unit: string
  cost_type: CostType
  std_price: number
  evidence_id: string | null
  evidence_note: string
  index_id: string | null
  index_coeff: number
  price_min: number | null
  price_max: number | null
  price_median: number | null
  samples: number
  last_seen: string
  last_price: number | null
  /** 裝修類：歷史以「式」報價、應改以 m² 計價，待主管轉換 */
  needs_area: boolean
  active: boolean
  sort: number
}

export interface PriceFloor {
  item_id: string
  floor_price: number
  note: string
}

export interface PriceHistoryRow {
  id: number
  item_id: string
  old_price: number | null
  new_price: number
  reason: string
  changed_by: string | null
  changed_at: string
}

export interface LaborRate {
  id: string
  name: string
  multiplier: number
  legal_basis: string
  sort: number
  active: boolean
}

export interface Quote {
  id: string
  quote_no: string
  project: string
  dept: string
  contact: string
  quote_date: string
  status: QuoteStatus
  mgmt_fee_rate: number
  tax_rate: number
  created_by: string
  approved_by: string | null
  approved_at: string | null
  review_note: string
  created_at: string
  updated_at: string
}

export interface QuoteSection {
  id: string
  quote_id: string
  title: string
  sort: number
}

export interface QuoteLine {
  id: string
  quote_id: string
  section_id: string
  item_id: string | null
  labor_rate_id: string | null
  name: string
  spec: string
  unit: string
  unit_price: number
  qty: number
  is_custom: boolean
  /** 臨時項目必填，資料庫層有 check constraint */
  reason: string
  note: string
  sort: number
}

export interface Negotiation {
  id: string
  quote_id: string
  line_id: string | null
  round: number
  client_offer: number | null
  response: NegoResponse | null
  final_price: number | null
  rationale: string
  responded_by: string | null
  responded_at: string
}

/** 前端編輯中的單據（尚未落庫的形狀，與 DB 分開避免耦合） */
export interface DraftLine {
  key: string
  item_id: string | null
  labor_rate_id: string | null
  name: string
  spec: string
  unit: string
  unit_price: number
  qty: number
  is_custom: boolean
  reason: string
  note: string
}

export interface DraftSection {
  key: string
  title: string
  lines: DraftLine[]
}

export interface DraftQuote {
  id?: string
  quote_no?: string
  project: string
  dept: string
  contact: string
  quote_date: string
  status: QuoteStatus
  sections: DraftSection[]
}

export const STATUS_LABEL: Record<QuoteStatus, string> = {
  draft: '草稿',
  submitted: '待主管核可',
  approved: '已核可',
  negotiating: '議價中',
  closed: '已定案',
  rejected: '已退回',
}

export const COST_LABEL: Record<CostType, string> = {
  material: '材料',
  consumable: '耗材',
  labor: '工資',
  other: '其他',
}

export const EVIDENCE_LABEL: Record<EvidenceKind, string> = {
  index: '官方指數',
  law: '法規',
  market: '市場行情',
  history: '歷史成交',
}
