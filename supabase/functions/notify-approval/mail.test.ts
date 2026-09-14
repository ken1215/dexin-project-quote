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

/**
 * 主旨在 buildMail 出來時已經是 RFC 2047 的 encoded-word（純 ASCII），
 * 那是為了繞過 denomailer 折斷標頭的 bug（見檔尾那組測試）。
 * 要斷言「人看到什麼」就得先解回來——直接對編碼後的字串比對中文一定不會過。
 */
const decodeSubject = (v: string): string =>
  v.replace(
    /=\?utf-8\?B\?([A-Za-z0-9+/=]+)\?=/g,
    (_m, b64: string) =>
      new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))),
  )
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

// 2026-09-14 起 approved 除了開單人，還加發行政管理部長（admin_head）備查。
// 這條斷言原本是「只寄給開單人」，是規則改了才改它——不是為了讓測試過。
assert.deepEqual(sorted(pick('approved', 'approved_l1')),
  ['ah1@example.com', 'st1@example.com'],
  'approved 寄給開單人，並加發行政管理部長備查')

assert.deepEqual(pick('rejected', 'submitted'), ['st1@example.com'],
  'rejected 只寄給開單人')

// ── 2. 兩條非典型轉換（規劃者點名要測）─────────────────────────
// 副部長越級核定（l1_skipped）：submitted 直接跳到 approved，照 new status 判收件人。
assert.deepEqual(sorted(pick('approved', 'submitted')),
  ['ah1@example.com', 'st1@example.com'],
  '越級核定一樣照 new status 判：開單人 ＋ 部長備查（備查不因為跳過第一關而漏掉）')
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
// 就算採購自己是開單人也不寄（同一條過濾，不對開單人開後門）。
// 2026-09-14 起 approved 會加發部長備查，所以名單不再是空的——
// 要驗的是「採購沒收到」，不是「沒有人收到」，斷言改寫成前者。
{
  const to = pick('approved', 'approved_l1', 'pc1')
  assert.ok(!to.includes('pc1@example.com'), '開單人若為採購角色一樣不寄')
  assert.deepEqual(to, ['ah1@example.com'],
    '此時只剩部長的備查信，沒有任何一封寄給採購')
}

// 停用帳號排除
assert.ok(!pick('submitted', 'draft').includes('dh2@example.com'),
  '停用的處長不收信')
// 同上：approved 現在必然帶一封部長備查，所以驗的是「停用者不在名單裡」
assert.deepEqual(pick('approved', 'approved_l1', 'st9'), ['ah1@example.com'],
  '停用的開單人不收信（名單裡只剩部長的備查信）')

// 沒填 notify_email（空字串或只有空白）排除
assert.ok(!pick('submitted', 'draft').some((e) => e.trim() === ''),
  '沒填通知信箱的人不會產生空字串收件人')

// 同一個地址只出現一次（dh1 與 dh4 填了同一個信箱）
assert.equal(pick('submitted', 'draft').length, 1, '重複地址要去重')

// 查無此開單人（帳號已被刪）不該爆。2026-09-14 起 approved 一定帶一封部長備查，
// 所以正確結果不是空陣列而是「只有部長」——備查刻意不因為開單人查不到而跟著消失。
assert.deepEqual(pick('approved', 'approved_l1', 'ghost'), ['ah1@example.com'],
  '查無開單人時不爆，且部長備查照發')
assert.deepEqual(pick('approved', 'approved_l1', null), ['ah1@example.com'],
  'created_by 為 null 時不爆，且部長備查照發')

// ── 5. 信件內容 ─────────────────────────────────────────────────
const rec = (o: Partial<QuoteRecord> = {}): QuoteRecord => ({
  id: 'abc-123', quote_no: 'Q26090001', project: '神經醫學中心配電',
  dept: '工務處', status: 'submitted', created_by: 'st1', review_note: '', ...o,
})

{
  const m = buildMail({ record: rec(), baseUrl: 'https://dexin-quote.pages.dev' })
  assert.ok(decodeSubject(m.subject).includes('Q26090001'), '主旨要含單號')
  assert.ok(decodeSubject(m.subject).includes('待處長核可'), '主旨要含狀態中文')
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
  assert.ok(decodeSubject(m.subject).includes('已退回'), '退回信主旨要看得出是退回')
  assert.ok(m.text.includes('第 3 項單價高於標準品項，請附理由'), '退回信內文要含退回理由')
}

// 非退回狀態不必也不該把 review_note 塞進信裡（那是上一輪的舊註記）
{
  const m = buildMail({
    record: rec({ status: 'approved', review_note: '上一輪的舊註記' }),
    baseUrl: 'https://dexin-quote.pages.dev',
  })
  assert.ok(!m.text.includes('上一輪的舊註記'), '非退回信不要夾帶舊的審核註記')
  assert.ok(decodeSubject(m.subject).includes('已核定'))
}

// 欄位為 null（資料庫允許）不可讓信變成 "null"
{
  const m = buildMail({
    record: rec({ quote_no: null, project: null, dept: null, review_note: null }),
    baseUrl: 'https://dexin-quote.pages.dev',
  })
  assert.ok(!decodeSubject(m.subject).includes('null'), '主旨不可出現 null 字樣')
  assert.ok(!m.text.includes('null'), '內文不可出現 null 字樣')
}

// ── HTML 版型 ──────────────────────────────────────────────────
// 使用者自己打的字會直接進 HTML，沒跳脫就會把版面弄壞（或更糟）
{
  const m = buildMail({
    record: rec({ project: '<script>alert(1)</script> & "引號" 案' }),
    baseUrl: 'https://dexin-quote.pages.dev',
  })
  assert.ok(!m.html.includes('<script>'), '案名裡的標籤必須被跳脫，不可原樣進 HTML')
  assert.ok(m.html.includes('&lt;script&gt;'), '跳脫後的文字仍要看得到')
  assert.ok(m.html.includes('&amp;') && m.html.includes('&quot;'), '& 與雙引號也要跳脫')
}

// 四種狀態各有自己的色，混用會讓「已退回」看起來像「已核定」
{
  const colorOf = (status: string) =>
    buildMail({ record: rec({ status }), baseUrl: 'https://x.test' }).html
  assert.ok(colorOf('approved').includes('#00A94F'), '已核定用 CIS 綠')
  assert.ok(colorOf('rejected').includes('#C0392B'), '已退回用警示紅')
  assert.ok(colorOf('submitted').includes('#008CD6'), '待處長核可用亮藍')
  assert.ok(colorOf('approved_l1').includes('#0054A7'), '待核定用深藍')
}

// HTML 與純文字必須等價：重要的事不能只寫在其中一邊
{
  const m = buildMail({
    record: rec({ status: 'rejected', review_note: '單價高於底價' }),
    baseUrl: 'https://dexin-quote.pages.dev',
  })
  assert.ok(m.html.includes('單價高於底價'), '退回理由 HTML 版也要有')
  assert.ok(m.text.includes('單價高於底價'), '退回理由純文字版也要有')
  const link = 'https://dexin-quote.pages.dev/#/quote/'
  assert.ok(m.html.includes(link) && m.text.includes(link), '兩邊的連結要一致')
}

// 信裡絕不可出現「金額數字」——這是刻意的約束，不是忘了加。
// 檢查的是數字樣態不是關鍵字：頁尾本來就寫著「本信不含金額與明細」，
// 用關鍵字掃會被自己的說明文字絆倒，而那句話正是這條約束的宣告。
{
  const m = buildMail({ record: rec({ status: 'approved' }), baseUrl: 'https://x.test' })
  for (const [name, re] of [
    ['千分位數字', /\d{1,3}(?:,\d{3})+/],
    ['新臺幣符號', /NT\$|＄|\$\s*\d/],
    ['金額加單位', /\d+\s*元/],
  ] as const) {
    assert.ok(!re.test(m.html), `信件版型出現${name}，金額一律留在系統裡`)
    assert.ok(!re.test(m.text), `純文字版出現${name}，金額一律留在系統裡`)
  }
}

// ── 主旨的 MIME 編碼（2026-09-14 線上事故的回歸測試）──────────────
// denomailer 1.6.0 的 quotedPrintableEncodeInline 會拿「內文」的 QP 規則去編
// 含非 ASCII 的標頭：每 74 個字元插一個「等號 + CRLF」的軟換行。但標頭的折行
// 必須是「CRLF + 空白」，裸 CRLF 會直接終止標頭區——Content-Type 跟著消失，
// 整封信被當成純文字，收件者看到的是一整片 MIME 原始碼。上游 main 至今未修。
// 出路是它自己留的：純 ASCII 且不以問號開頭的編碼字，它原樣放行。
// 所以主旨改由我們自己編成 RFC 2047 的 base64 encoded-word。
{
  /** 逐字複製 denomailer 的判斷式——它會不會動我們的主旨 */
  const denomailerWouldTouch = (v: string) =>
    /[^\u0000-\u007f]/.test(v) || v.startsWith('=?')

  const decodeWords = (v: string) =>
    v.replace(
      /=\?utf-8\?B\?([A-Za-z0-9+/=]+)\?=/g,
      (_m, b64: string) =>
        new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))),
    )

  for (const status of ['submitted', 'approved_l1', 'approved', 'rejected']) {
    const { subject } = buildMail({ record: rec({ status }), baseUrl: 'https://x.test' })
    assert.ok(
      !denomailerWouldTouch(subject),
      `主旨會被 denomailer 重新編碼而折斷整封信（status=${status}）：${subject}`,
    )
    // 解得回去才算數，不能只是「變成 ASCII」
    assert.ok(decodeWords(subject).includes('Q26090001'), `主旨解碼後要看得到單號：${subject}`)
  }

  // 單號為 null 時 orDash 會回全形破折號（非 ASCII），主旨就會以編碼字開頭，
  // 那正是被重新編碼的另一條路
  {
    const { subject } = buildMail({ record: rec({ quote_no: null }), baseUrl: 'https://x.test' })
    assert.ok(!denomailerWouldTouch(subject), `單號為 null 時主旨仍不可被重編：${subject}`)
  }

  // 每個 encoded-word 不得超過 RFC 2047 的 75 字元上限
  {
    const { subject } = buildMail({ record: rec({ status: 'approved_l1' }), baseUrl: 'https://x.test' })
    for (const w of subject.match(/=\?utf-8\?B\?[A-Za-z0-9+/=]+\?=/g) ?? []) {
      assert.ok(w.length <= 75, `encoded-word 超過 75 字元（${w.length}）：${w}`)
    }
  }
}

// ── 主旨後綴（2026-09-14 的二次翻車）─────────────────────────────
// 第一次修好主旨編碼之後，selftest 仍然寄出壞信：因為它把中文的
// 「（版型測試）」接在**已經編碼完成**的 subject 後面，整串又含了非 ASCII，
// denomailer 於是再編一次、又折斷標頭。改接「已編碼的片段」也不行——
// 那會產生兩個中間沒有空白的相鄰 encoded-word，不合 RFC 2047 §6.2。
// 唯一對的做法是把後綴當原始文字交給 buildMail，整串只編一次。
{
  const denomailerWouldTouch = (v: string) =>
    /[^\u0000-\u007f]/.test(v) || v.startsWith('=?')

  const { subject } = buildMail({
    record: rec({ status: 'rejected' }),
    baseUrl: 'https://x.test',
    subjectSuffix: '（版型測試）',
  })

  assert.ok(!denomailerWouldTouch(subject), `帶後綴的主旨會被重新編碼：${subject}`)
  assert.ok(
    !/\?==\?/.test(subject),
    `出現兩個中間沒有空白的相鄰 encoded-word，不合 RFC 2047：${subject}`,
  )

  const decoded = subject.replace(
    /=\?utf-8\?B\?([A-Za-z0-9+/=]+)\?=/g,
    (_m, b64: string) =>
      new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))),
  )
  assert.ok(decoded.includes('版型測試'), `後綴解碼後要看得到：${decoded}`)
  assert.ok(decoded.includes('已退回'), `狀態解碼後要看得到：${decoded}`)
}

// ── 核定後加發部長備查（使用者 2026-09-14 追加）────────────────
// 「所有已完成核定的報價單都要發給行政管理部長備查」。
// 掛的是**角色** admin_head 不是某個人名——換人做部長時不必改程式。
{
  const profiles = [
    { id: 'creator', role: 'staff', active: true, notify_email: 'staff@x.test' },
    { id: 'boss', role: 'admin_head', active: true, notify_email: 'head@x.test' },
    { id: 'vice', role: 'manager', active: true, notify_email: 'vice@x.test' },
    { id: 'dept', role: 'dept_head', active: true, notify_email: 'dept@x.test' },
  ]
  const at = (newStatus: string, createdBy: string | null = 'creator') =>
    resolveRecipients({ newStatus, oldStatus: 'whatever', createdBy, profiles })

  const approved = at('approved')
  assert.ok(approved.includes('staff@x.test'), '核定信仍要寄給開單人')
  assert.ok(approved.includes('head@x.test'), '核定信要加發部長備查')
  assert.ok(!approved.includes('vice@x.test'), '備查只給部長，副部長不在此列')
  assert.ok(!approved.includes('dept@x.test'), '備查只給部長，處長不在此列')

  // 退回不是「完成核定」，不必備查
  const rejected = at('rejected')
  assert.ok(rejected.includes('staff@x.test'), '退回信寄給開單人')
  assert.ok(!rejected.includes('head@x.test'), '退回不備查，只有核定才發部長')

  // 部長自己開的單被核定：只能出現一次，不可因為「開單人」與「備查」兩條規則各加一次
  const both = at('approved', 'boss')
  assert.strictEqual(
    both.filter((m) => m === 'head@x.test').length, 1,
    '部長同時是開單人與備查對象時，不可收到兩份',
  )
}

console.log('mail.ts 自我檢查全數通過')
