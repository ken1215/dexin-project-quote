/**
 * 簽核關卡顯示模型的自我檢查。
 * 執行：node --experimental-strip-types src/lib/approvalFlow.test.ts
 */
import assert from 'node:assert/strict'
import {
  buildApprovalFlow, compactLine, formatStamp, formatStampDate,
  type FlowInput, type StepState,
} from './approvalFlow.ts'
import type { QuoteStatus } from '../types.ts'

const T_L1 = '2026-11-10T06:30:00Z'   // 台北 11/10 14:30
const T_L2 = '2026-11-11T01:12:00Z'   // 台北 11/11 09:12
const T_UPD = '2026-11-12T08:05:00Z'  // 台北 11/12 16:05
const T_RET = '2026-11-11T02:20:00Z'  // 台北 11/11 10:20

const input = (o: Partial<FlowInput> = {}): FlowInput => ({
  status: 'draft' as QuoteStatus, l1_skipped: false, returned_at: null,
  approved_l1_by: null, approved_l1_at: null, approved_by: null, approved_at: null,
  created_by: 'u-staff', updated_at: T_UPD, review_note: '', ...o,
})
const states = (o: Partial<FlowInput>): StepState[] =>
  buildApprovalFlow(input(o)).steps.map((s) => s.state)
const stamped = { approved_l1_by: 'u-head', approved_l1_at: T_L1, approved_by: 'u-vp', approved_at: T_L2 }

// ── 1. 七個狀態逐關的 state ────────────────────────────────────
assert.deepEqual(states({ status: 'draft' }), ['current', 'todo', 'todo', 'todo'])
assert.deepEqual(states({ status: 'rejected', review_note: '請修正' }), ['rejected', 'todo', 'todo', 'todo'])
assert.deepEqual(states({ status: 'submitted' }), ['done', 'current', 'todo', 'todo'])
assert.deepEqual(states({ status: 'approved_l1', ...stamped }), ['done', 'done', 'current', 'todo'])
assert.deepEqual(states({ status: 'approved', ...stamped }), ['done', 'done', 'done', 'current'])
assert.deepEqual(states({ status: 'negotiating', ...stamped }), ['done', 'done', 'done', 'current'])
assert.deepEqual(states({ status: 'closed', ...stamped }), ['done', 'done', 'done', 'done'])

{
  const f = buildApprovalFlow(input({ status: 'approved', ...stamped }))
  assert.deepEqual(f.steps.map((s) => s.key), ['submit', 'l1', 'l2', 'close'])
  assert.equal(f.steps[0].byId, 'u-staff')
  assert.equal(f.steps[0].at, null, '沒有送審時間欄位，不得拿別的時間冒充')
  assert.equal(f.steps[1].byId, 'u-head')
  assert.equal(f.steps[1].at, T_L1)
  assert.equal(f.steps[2].byId, 'u-vp')
  assert.equal(f.steps[2].at, T_L2)
  assert.equal(f.steps[3].byId, null)
  assert.equal(f.steps[3].at, null, '還沒定案，定案關不得有時間')
  assert.equal(f.summary, '兩關已核定，待議價定案')
  assert.equal(f.legacy, false)
  assert.equal(f.note, null)
}
{
  const f = buildApprovalFlow(input({ status: 'negotiating', ...stamped }))
  assert.equal(f.legacy, true)
  assert.equal(f.steps[3].caption, '議價中（舊制）')
  assert.equal(f.summary, '議價中（舊制）')
}
assert.equal(buildApprovalFlow(input({ status: 'draft' })).summary, '草稿，尚未送審')
assert.equal(buildApprovalFlow(input({ status: 'submitted' })).summary, '待工務處長核可')
assert.equal(buildApprovalFlow(input({ status: 'approved_l1', ...stamped })).summary, '處長已核可，待副部長核定')
assert.equal(buildApprovalFlow(input({ status: 'rejected' })).summary, '已退回開單人，待修正重送')
assert.equal(buildApprovalFlow(input({ status: 'closed', ...stamped })).summary, '已定案')

// ── 2. 越級：處長關是 skipped，不是打勾；殘留的第一關戳記不採用 ──
{
  const f = buildApprovalFlow(input({
    status: 'approved', l1_skipped: true, ...stamped,
  }))
  assert.deepEqual(f.steps.map((s) => s.state), ['done', 'skipped', 'done', 'current'])
  assert.equal(f.steps[1].at, null, '越級時第一關的殘留時間不得採用')
  assert.equal(f.steps[1].byId, null, '越級時第一關的殘留簽核人不得採用')
  assert.equal(f.steps[1].caption, '越級・未經處長')
  assert.equal(f.steps[2].caption, '越級核定')
  assert.equal(f.summary, '副部長越級核定（未經處長），待議價定案')
}
assert.deepEqual(
  states({ status: 'closed', l1_skipped: true, ...stamped }), ['done', 'skipped', 'done', 'done'],
)

// ── 3. 殘留的 l1_skipped：還沒核定的狀態一律忽略 ────────────────
for (const s of ['draft', 'submitted', 'approved_l1', 'rejected'] as QuoteStatus[]) {
  assert.equal(
    states({ status: s, l1_skipped: true, ...stamped }).includes('skipped'), false,
    `${s} 不得出現越級`,
  )
}

// ── 4. 殘留戳記：狀態還沒到，戳記一律當沒有 ─────────────────────
{
  const f = buildApprovalFlow(input({ status: 'submitted', ...stamped }))
  assert.equal(f.steps[1].at, null)
  assert.equal(f.steps[1].byId, null)
  assert.equal(f.steps[2].at, null)
  assert.equal(f.steps[2].byId, null)
  assert.notEqual(f.steps[1].state, 'done')
  assert.notEqual(f.steps[2].state, 'done')
}
{
  // 待副部長核定：第二關的殘留戳記（上一輪核定後被整單退回）不得採用
  const f = buildApprovalFlow(input({ status: 'approved_l1', ...stamped }))
  assert.equal(f.steps[1].at, T_L1)
  assert.equal(f.steps[2].at, null)
  assert.equal(f.steps[2].byId, null)
}

// ── 5. 副部長退回上一層級 ──────────────────────────────────────
{
  const f = buildApprovalFlow(input({
    status: 'approved_l1', returned_at: T_RET, review_note: '工率請再確認', ...stamped,
  }))
  assert.equal(f.steps[2].state, 'current')
  assert.equal(f.steps[2].returned, true)
  assert.equal(f.steps[2].caption, '已退回重審')
  assert.deepEqual(f.note, {
    kind: 'returned', title: '副部長退回上一層級', text: '工率請再確認', at: T_RET,
  })
  assert.equal(f.summary, '副部長退回重審')
}
{
  const f = buildApprovalFlow(input({
    status: 'submitted', returned_at: T_RET, review_note: '請處長補核', l1_skipped: false,
  }))
  assert.equal(f.steps[1].state, 'current')
  assert.equal(f.steps[1].returned, true)
  assert.equal(f.steps[2].returned, false)
  assert.equal(f.note?.kind, 'returned')
  assert.equal(f.summary, '副部長退回，待工務處長核可')
}
// returned_at 殘留在不相干的狀態上不得亂標
assert.equal(
  buildApprovalFlow(input({ status: 'approved', returned_at: T_RET, review_note: 'x', ...stamped }))
    .steps.some((s) => s.returned), false,
)
assert.equal(
  buildApprovalFlow(input({ status: 'approved', returned_at: T_RET, review_note: 'x', ...stamped })).note, null,
)

// ── 6. 整單退回 ────────────────────────────────────────────────
assert.equal(buildApprovalFlow(input({ status: 'rejected', review_note: '' })).note, null)
assert.equal(buildApprovalFlow(input({ status: 'rejected', review_note: '   ' })).note, null)
{
  const f = buildApprovalFlow(input({ status: 'rejected', review_note: '面積請修正' }))
  assert.deepEqual(f.note, { kind: 'rejected', title: '退回意見', text: '面積請修正', at: T_UPD })
  assert.equal(f.steps[0].at, T_UPD)
}
// 草稿殘留上一輪的退回意見：不再顯示
assert.equal(buildApprovalFlow(input({ status: 'draft', review_note: '舊意見' })).note, null)

// ── 7. 定案時間 ────────────────────────────────────────────────
{
  const f = buildApprovalFlow(input({ status: 'closed', ...stamped }))
  assert.equal(f.steps[3].at, T_UPD)
  assert.equal(f.steps[3].byId, null)
}

// ── 8. 時間格式：固定台北時區 ──────────────────────────────────
assert.equal(formatStamp('2026-11-05T06:30:00Z'), '11/05 14:30')
assert.equal(formatStamp('2026-12-31T16:05:00Z'), '01/01 00:05', '跨日要算台北的日期，午夜是 00 不是 24')
assert.equal(formatStamp(null), '')
assert.equal(formatStamp('not-a-date'), '')
assert.equal(formatStampDate('2026-11-05T06:30:00Z'), '11/05')
assert.equal(formatStampDate(null), '')

// ── 9. 任何輸入最多一個 current；rejected 是 0 個 ────────────────
const ALL: QuoteStatus[] = [
  'draft', 'submitted', 'approved_l1', 'approved', 'negotiating', 'closed', 'rejected',
]
for (const status of ALL) {
  for (const l1_skipped of [false, true]) {
    for (const returned_at of [null, T_RET]) {
      for (const st of [{}, stamped]) {
        const f = buildApprovalFlow(input({ status, l1_skipped, returned_at, review_note: 'n', ...st }))
        const cur = f.steps.filter((s) => s.state === 'current').length
        const want = status === 'rejected' || status === 'closed' ? 0 : 1
        assert.equal(cur, want, `${status} 的 current 數應為 ${want}`)
        assert.equal(f.steps.length, 4)
        assert.ok(f.summary.length > 0)
      }
    }
  }
}

// ── 10. 清單精簡版的那一行字 ───────────────────────────────────
const names = { 'u-head': '游大明', 'u-vp': '林小華' }
const line = (o: Partial<FlowInput>, n: Record<string, string> = names) =>
  compactLine(buildApprovalFlow(input(o)), n)
assert.equal(line({ status: 'draft' }), null)
assert.equal(line({ status: 'submitted' }), null)
assert.deepEqual(line({ status: 'approved_l1', ...stamped }), { text: '處長 游大明 11/10 核可', tone: 'normal' })
assert.deepEqual(line({ status: 'approved', ...stamped }), { text: '副部長 林小華 11/11 核定', tone: 'normal' })
assert.deepEqual(
  line({ status: 'approved', l1_skipped: true, ...stamped }),
  { text: '副部長 林小華 11/11 越級核定', tone: 'skipped' },
)
assert.deepEqual(line({ status: 'closed', ...stamped }), { text: '11/12 定案', tone: 'normal' })
assert.deepEqual(line({ status: 'rejected' }), { text: '11/12 退回', tone: 'warn' })
assert.deepEqual(
  line({ status: 'approved_l1', returned_at: T_RET, review_note: 'x', ...stamped }),
  { text: '11/11 副部長退回', tone: 'warn' },
)
// 同仁端查不到姓名（RLS）：只出職稱，不留兩個空白
assert.deepEqual(line({ status: 'approved_l1', ...stamped }, {}), { text: '處長 11/10 核可', tone: 'normal' })

console.log('approvalFlow.ts 自我檢查全數通過')
