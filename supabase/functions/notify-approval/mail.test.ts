/**
 * 簽核通知信的純邏輯自我檢查 — 「誰該收到信」不能只靠肉眼看。
 *
 * 為什麼要有這支測試：收件人規則是使用者 2026-09-14 逐條拍板的（見 mail.ts 檔頭），
 * 而它實際跑的地方是 Supabase Edge Runtime——出錯時只會在 webhook 記錄裡留下一行，
 * 沒有人會發現「處長其實沒收到信」。把規則抽成純函式並在本機驗到綠燈，
 * 是唯一能在部署前就抓到漏寄／誤寄的辦法。尤其「醫院採購一律不寄」是刻意決策，
 * 一旦哪天有人順手把它加回去，這裡要立刻紅燈。
 *
 * 執行：node --experimental-strip-types supabase/functions/notify-approval/mail.test.ts
 */
import assert from 'node:assert/strict'
import { buildMail, resolveRecipients } from './mail.ts'
import type { Profile, QuoteRecord } from './mail.ts'

// ── 共用樣本 ────────────────────────────────────────────────────
// 涵蓋五種角色，外加「停用」「沒填地址」「地址重複」三種邊界狀況。
const P: Profile[] = [
  { id: 'dh1', role: 'dept_head', active: true, notify_email: 'dh1@example.com' },
  { id: 'dh2', role: 'dept_head', active: false, notify_email: 'dh2@example.com' }, // 停用
  { id: 'dh3', role: 'dept_head', active: true, notify_email: '   ' }, // 沒填（空白）
  { id: 'dh4', role: 'dept_head', active: true, notify_email: 'dh1@example.com' }, // 與 dh1 同址
  { id: 'mg1', role: 'manager', active: true, notify_email: 'mg1@example.com' },
  { id: 'ah1', role: 'admin_head', active: true, notify_email: 'ah1@example.com' },
  { id: 'pc1', role: 'procurement', active: true, notify_email: 'pc1@example.com' },
  { id: 'st1', role: 'staff', active: true, notify_email: 'st1@example.com' },
  { id: 'st9', role: 'staff', active: false, notify_email: 'st9@example.com' }, // 停用的開單人
]

const pick = (newStatus: string, oldStatus: string, createdBy: string | null = 'st1') =>
  resolveRecipients({ newStatus, oldStatus, createdBy, profiles: P })

const sorted = (v: string[]) => [...v].sort()

// ── 1. 四種會寄信的狀態，各自的收件人 ───────────────────────────
assert.deepEqual(pick('submitted', 'draft'), ['dh1@example.com'],
  'submitted 寄給啟用中的工務處長')

assert.deepEqual(sorted(pick('approved_l1', 'submitted')),
  ['ah1@example.com', 'mg1@example.com'],
  'approved_l1 要同時寄給副部長（manager）與行政管理部長（admin_head）')

assert.deepEqual(pick('approved', 'approved_l1'), ['st1@example.com'],
  'approved 只寄給開單人')

assert.deepEqual(pick('rejected', 'submitted'), ['st1@example.com'],
  'rejected 只寄給開單人')

// ── 2. 兩條非典型轉換（規劃者點名要測）─────────────────────────
// 副部長越級核定（l1_skipped）：submitted 直接跳到 approved，照 new status 判收件人。
assert.deepEqual(pick('approved', 'submitted'), ['st1@example.com'],
  '越級核定仍然只通知開單人')
// 已核定後又被退回：一樣看 new status。
assert.deepEqual(pick('rejected', 'approved'), ['st1@example.com'],
  '已核定改退回仍然只通知開單人')

// ── 3. 不寄信的狀態 ─────────────────────────────────────────────
assert.deepEqual(pick('draft', 'submitted'), [], 'draft 不寄')
assert.deepEqual(pick('negotiating', 'approved'), [], 'negotiating 不寄')
assert.deepEqual(pick('closed', 'negotiating'), [], 'closed 不寄')

// 狀態沒變＝這次 UPDATE 動的是別的欄位（改金額、加註記），一律不寄。
assert.deepEqual(pick('submitted', 'submitted'), [], '狀態未變不寄')
assert.deepEqual(pick('approved', 'approved'), [], '狀態未變不寄（即使是會寄信的狀態）')

// ── 4. 過濾規則 ─────────────────────────────────────────────────
// 醫院採購一律排除——這是決策不是遺漏，改壞了要在這裡紅燈。
{
  const all = [
    ...pick('submitted', 'draft'),
    ...pick('approved_l1', 'submitted'),
    ...pick('approved', 'approved_l1'),
  ]
  assert.ok(!all.includes('pc1@example.com'),
    '醫院採購（procurement）即使啟用且填了地址也絕不收信')
}
// 就算採購自己是開單人也不寄（同一條過濾，不對開單人開後門）
assert.deepEqual(pick('approved', 'approved_l1', 'pc1'), [],
  '開單人若為採購角色一樣不寄')

// 停用帳號排除
assert.ok(!pick('submitted', 'draft').includes('dh2@example.com'),
  '停用的處長不收信')
assert.deepEqual(pick('approved', 'approved_l1', 'st9'), [],
  '停用的開單人不收信')

// 沒填 notify_email（空字串或只有空白）排除
assert.ok(!pick('submitted', 'draft').some((e) => e.trim() === ''),
  '沒填通知信箱的人不會產生空字串收件人')

// 同一個地址只出現一次（dh1 與 dh4 填了同一個信箱）
assert.equal(pick('submitted', 'draft').length, 1, '重複地址要去重')

// 查無此開單人（帳號已被刪）不該爆，回空陣列
assert.deepEqual(pick('approved', 'approved_l1', 'ghost'), [], '查無開單人時回空陣列')
assert.deepEqual(pick('approved', 'approved_l1', null), [], 'created_by 為 null 時回空陣列')

// ── 5. 信件內容 ─────────────────────────────────────────────────
const rec = (o: Partial<QuoteRecord> = {}): QuoteRecord => ({
  id: 'abc-123', quote_no: 'Q26090001', project: '神經醫學中心配電',
  dept: '工務處', status: 'submitted', created_by: 'st1', review_note: '', ...o,
})

{
  const m = buildMail({ record: rec(), baseUrl: 'https://dexin-quote.pages.dev' })
  assert.ok(m.subject.includes('Q26090001'), '主旨要含單號')
  assert.ok(m.subject.includes('待處長核可'), '主旨要含狀態中文')
  assert.ok(m.text.includes('神經醫學中心配電'), '內文要含案名')
  assert.ok(m.text.includes('工務處'), '內文要含需求單位')
  assert.ok(m.text.includes('https://dexin-quote.pages.dev/#/quote/abc-123'),
    '內文要含可直接點開的報價單連結')
}

// baseUrl 結尾有斜線時不能組出 //#
{
  const m = buildMail({ record: rec(), baseUrl: 'https://dexin-quote.pages.dev/' })
  assert.ok(m.text.includes('/#/quote/'), '連結形狀固定是 /#/quote/（HashRouter）')
  assert.ok(!m.text.includes('//#'), 'baseUrl 尾端斜線不可變成雙斜線')
  assert.ok(m.text.includes('https://dexin-quote.pages.dev/#/quote/abc-123'))
}

// 退回時一定要把退回理由寫進信裡，否則開單人還得自己登入才知道為什麼被退
{
  const m = buildMail({
    record: rec({ status: 'rejected', review_note: '第 3 項單價高於標準品項，請附理由' }),
    baseUrl: 'https://dexin-quote.pages.dev',
  })
  assert.ok(m.subject.includes('已退回'), '退回信主旨要看得出是退回')
  assert.ok(m.text.includes('第 3 項單價高於標準品項，請附理由'), '退回信內文要含退回理由')
}

// 非退回狀態不必也不該把 review_note 塞進信裡（那是上一輪的舊註記）
{
  const m = buildMail({
    record: rec({ status: 'approved', review_note: '上一輪的舊註記' }),
    baseUrl: 'https://dexin-quote.pages.dev',
  })
  assert.ok(!m.text.includes('上一輪的舊註記'), '非退回信不要夾帶舊的審核註記')
  assert.ok(m.subject.includes('已核定'))
}

// 欄位為 null（資料庫允許）不可讓信變成 "null"
{
  const m = buildMail({
    record: rec({ quote_no: null, project: null, dept: null, review_note: null }),
    baseUrl: 'https://dexin-quote.pages.dev',
  })
  assert.ok(!m.subject.includes('null'), '主旨不可出現 null 字樣')
  assert.ok(!m.text.includes('null'), '內文不可出現 null 字樣')
}

console.log('mail.ts 自我檢查全數通過')
