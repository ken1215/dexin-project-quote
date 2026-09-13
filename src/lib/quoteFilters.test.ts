/**
 * 清單分頁與排序的自我檢查。
 * 執行：node --experimental-strip-types src/lib/quoteFilters.test.ts
 */
import assert from 'node:assert/strict'
import {
  isTodo, matchesTab, pendingStatusesFor, sortQuotes,
  type QuoteRowLike,
} from './quoteFilters.ts'
import type { QuoteStatus } from '../types.ts'

const row = (o: Partial<QuoteRowLike> = {}): QuoteRowLike => ({
  id: 'i', quote_no: 'Q26-0001', quote_date: '2026-09-01',
  status: 'draft' as QuoteStatus, created_by: 'me', total: 1000, ...o,
})

// ── 1. 各角色的「待我處理」定義 ────────────────────────────────
assert.deepEqual(pendingStatusesFor('staff'), ['draft', 'rejected'])
assert.deepEqual(pendingStatusesFor('dept_head'), ['submitted'])
assert.deepEqual(pendingStatusesFor('manager'), ['submitted', 'approved_l1'])
assert.deepEqual(pendingStatusesFor('admin_head'), ['submitted', 'approved_l1'])
assert.deepEqual(pendingStatusesFor('procurement'), [])

// ── 2. 同仁的待辦只算自己的單 ──────────────────────────────────
assert.equal(isTodo(row({ status: 'draft', created_by: 'me' }), 'staff', 'me'), true)
assert.equal(
  isTodo(row({ status: 'draft', created_by: 'other' }), 'staff', 'me'), false,
  '別人的草稿不是我的待辦',
)
// 主管的待辦不分建立者——第一關等他就是等他
assert.equal(
  isTodo(row({ status: 'submitted', created_by: 'other' }), 'dept_head', 'me'), true,
)
assert.equal(isTodo(row({ status: 'approved_l1' }), 'dept_head', 'me'), false)
assert.equal(isTodo(row({ status: 'approved_l1' }), 'manager', 'me'), true)

// ── 3. 分頁歸屬：每張單在 active/done 恰好落在一邊 ──────────────
const ALL: QuoteStatus[] = [
  'draft', 'submitted', 'approved_l1', 'rejected', 'approved', 'negotiating', 'closed',
]
for (const s of ALL) {
  const r = row({ status: s })
  const inActive = matchesTab(r, 'active', 'manager', 'me')
  const inDone = matchesTab(r, 'done', 'manager', 'me')
  assert.equal(inActive !== inDone, true, `${s} 必須恰好落在進行中或已核定其中一邊`)
  assert.equal(matchesTab(r, 'all', 'manager', 'me'), true, '「全部」要收所有狀態')
}
assert.equal(matchesTab(row({ status: 'draft' }), 'active', 'manager', 'me'), true)
assert.equal(matchesTab(row({ status: 'closed' }), 'done', 'manager', 'me'), true)

// ── 4. 排序 ────────────────────────────────────────────────────
{
  const rows = [
    row({ id: 'a', total: 300, quote_date: '2026-09-03', quote_no: 'Q26-0003' }),
    row({ id: 'b', total: 100, quote_date: '2026-09-01', quote_no: 'Q26-0001' }),
    row({ id: 'c', total: 200, quote_date: '2026-09-02', quote_no: 'Q26-0002' }),
  ]
  assert.deepEqual(sortQuotes(rows, 'total', 'asc').map((r) => r.id), ['b', 'c', 'a'])
  assert.deepEqual(sortQuotes(rows, 'total', 'desc').map((r) => r.id), ['a', 'c', 'b'])
  assert.deepEqual(sortQuotes(rows, 'quote_date', 'asc').map((r) => r.id), ['b', 'c', 'a'])
  assert.deepEqual(sortQuotes(rows, 'quote_no', 'desc').map((r) => r.id), ['a', 'c', 'b'])
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b', 'c'], 'sortQuotes 不得就地改動輸入陣列')
}

console.log('quoteFilters.ts 自我檢查全數通過')
