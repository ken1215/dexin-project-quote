/**
 * 清單分頁與排序的自我檢查。
 * 執行：node --experimental-strip-types src/lib/quoteFilters.test.ts
 */
import assert from 'node:assert/strict'
import {
  canReviewStatus, isOwnerEditable, isTodo, matchesTab, pendingStatusesFor, sortQuotes,
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

// ── 5. 停用帳號沒有待辦（進單後也沒有審核按鈕，兩邊口徑要一致）────
assert.deepEqual(pendingStatusesFor('dept_head', false), [])
assert.deepEqual(pendingStatusesFor('manager', false), [])
assert.deepEqual(pendingStatusesFor('staff', false), [])
assert.equal(isTodo(row({ status: 'submitted' }), 'dept_head', 'me', false), false)
assert.equal(matchesTab(row({ status: 'submitted' }), 'todo', 'dept_head', 'me', false), false)
assert.equal(matchesTab(row({ status: 'submitted' }), 'active', 'dept_head', 'me', false), true)

// ── 6. 輪到誰簽：清單「審查」鈕與單據頁共用 ──────────────────────
{
  const head = { isDeptHead: true, isAdmin: false }
  const vp = { isDeptHead: false, isAdmin: true }
  const staff = { isDeptHead: false, isAdmin: false }
  assert.equal(canReviewStatus('submitted', head), true)
  assert.equal(canReviewStatus('approved_l1', head), false, '處長不能簽第二關')
  assert.equal(canReviewStatus('submitted', vp), true, '副部長可代核或越級')
  assert.equal(canReviewStatus('approved_l1', vp), true)
  for (const s of ALL) {
    assert.equal(canReviewStatus(s, staff), false, `同仁不能簽 ${s}`)
    if (s !== 'submitted' && s !== 'approved_l1') {
      assert.equal(canReviewStatus(s, vp), false, `${s} 沒有可簽的關卡`)
    }
    // 有人能簽的狀態，在啟用的核決層一定也算待辦——徽章與按鈕不得分岔
    if (canReviewStatus(s, vp)) assert.equal(pendingStatusesFor('manager').includes(s), true)
    if (canReviewStatus(s, head)) assert.equal(pendingStatusesFor('dept_head').includes(s), true)
  }
  assert.deepEqual(ALL.filter(isOwnerEditable), ['draft', 'rejected'])
}

console.log('quoteFilters.ts 自我檢查全數通過')
