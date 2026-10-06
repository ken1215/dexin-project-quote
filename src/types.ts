/**
 * dept_head = 工務處長（簽核第一關 ＋ 單價庫維護，不能管帳號、不能議價定案）
 * manager   = 行政管理部副部長（最終核決，可越級核定）
 * admin_head = 行政管理部長（權限等同副部長，但單價維護只能讀不能改）
 * procurement = 醫院採購（2026-10-06 下線，僅供顯示既有帳號；不可再建立）
 */
export type Role = 'staff' | 'dept_head' | 'manager' | 'admin_head' | 'procurement'
export type CostType = 'material' | 'consumable' | 'labor' | 'other'
export type QuoteStatus =
  | 'draft' | 'submitted' | 'approved_l1' | 'approved'
  | 'negotiating' | 'closed' | 'rejected'
export type NegoResponse = 'accept' | 'partial' | 'hold' | 'discount'
export type EvidenceKind = 'index' | 'law' | 'market' | 'history'

export interface Profile {
  id: string
  full_name: string
  role: Role
  active: boolean
  /** 主管發出的初始／重設密碼還沒被本人換掉。為 true 時資料庫層會關掉所有業務資料 */
  must_change_password: boolean
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
  /** 大類底下的子分類（同質品項收在一起）；空字串＝該大類不分組 */
  subgroup: string
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
  /** 整單折讓（取整抹零，含稅元、正數）；只有定案 RPC 寫得進去，未定案恆為 0 */
  round_off: number
  created_by: string
  /** 第一關：工務處長核可（戳記由資料庫 trigger 蓋，前端不寫） */
  approved_l1_by: string | null
  approved_l1_at: string | null
  /** 第二關：行政管理部副部長核定 */
  approved_by: string | null
  approved_at: string | null
  /** 副部長越過第一關直接核定 */
  l1_skipped: boolean
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
  /** 定案改價前的原報價（db/29）；沒議價改過價、或改版前定案的單為 null */
  orig_price: number | null
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
  /** 院方還價。舊歷程會有值；2026-10 起採購角色下線，前端不再寫入 */
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
  /** 定案時副部長寫入的整單折讓（取整抹零）；草稿恆為 0 */
  round_off?: number
  /** 定案前的原報價單價，key = 明細 id；只收有被議價改過的列 */
  orig_prices?: Record<string, number>
  sections: DraftSection[]
}

export const ROLE_LABEL: Record<Role, string> = {
  staff: '同仁',
  dept_head: '工務處長',
  manager: '行政管理部副部長',
  admin_head: '行政管理部長',
  // 角色已下線；保留字面值是因為資料庫既有列仍是這個 role，前端載到舊帳號不能炸
  procurement: '醫院採購（已停用）',
}

export const STATUS_LABEL: Record<QuoteStatus, string> = {
  draft: '草稿',
  submitted: '待處長核可',
  approved_l1: '待副部長核定',
  approved: '已核定',
  // 流程已不再進入此狀態（2026-10-06 起已核定直接定案），留著顯示舊單
  negotiating: '議價中',
  closed: '已定案',
  rejected: '已退回',
}

/** 議價歷程的回應代碼；新流程一律記 discount，其餘三種只會出現在舊歷程 */
export const RESPONSE_LABEL: Record<NegoResponse, string> = {
  accept: '接受',
  partial: '部分讓步',
  hold: '堅持原價',
  discount: '協議折價',
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
