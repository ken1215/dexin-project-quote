import type { QuoteStatus, Role } from '../types'

export type QuoteTab = 'todo' | 'active' | 'done' | 'all'
export type SortKey = 'quote_no' | 'quote_date' | 'total'

export interface QuoteRowLike {
  id: string
  quote_no: string
  quote_date: string
  status: QuoteStatus
  created_by: string
  total: number
}

/** 還沒走完簽核的單 */
const ACTIVE: QuoteStatus[] = ['draft', 'submitted', 'approved_l1', 'rejected']
/** 已核定之後的單（含議價與定案） */
const DONE: QuoteStatus[] = ['approved', 'negotiating', 'closed']

/**
 * 「待我處理」＝ 這張單此刻卡在誰身上。
 * 同仁是「還沒送出的」與「被退回要改的」；處長是第一關；核決層是第二關，
 * 越級時第一關也算他的（處長請假不卡單）。
 * header 徽章與清單分頁共用這一份定義，不要各算各的。
 */
export function pendingStatusesFor(role: Role): QuoteStatus[] {
  switch (role) {
    case 'staff': return ['draft', 'rejected']
    case 'dept_head': return ['submitted']
    case 'manager':
    case 'admin_head': return ['submitted', 'approved_l1']
    default: return []
  }
}

export function isTodo(row: QuoteRowLike, role: Role, userId: string): boolean {
  if (!pendingStatusesFor(role).includes(row.status)) return false
  // 同仁只看自己的；主管的待辦是整個處室的單，不分建立者
  if (role === 'staff') return row.created_by === userId
  return true
}

export function matchesTab(
  row: QuoteRowLike, tab: QuoteTab, role: Role, userId: string,
): boolean {
  switch (tab) {
    case 'todo': return isTodo(row, role, userId)
    case 'active': return ACTIVE.includes(row.status)
    case 'done': return DONE.includes(row.status)
    case 'all': return true
  }
}

/** 回傳新陣列，不就地改動輸入（呼叫端常把原陣列拿去做別的事） */
export function sortQuotes<T extends QuoteRowLike>(
  rows: T[], key: SortKey, dir: 'asc' | 'desc',
): T[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    if (key === 'total') return (a.total - b.total) * sign
    return a[key].localeCompare(b[key]) * sign
  })
}
