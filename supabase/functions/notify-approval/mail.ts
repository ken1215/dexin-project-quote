// 簽核通知信的純邏輯 — 「誰該收到信」與「信要寫什麼」
//
// 為什麼要單獨切出這個檔：真正寄信的 index.ts 只能跑在 Supabase Edge Runtime 上
// （要有 Deno 全域、要有 service_role 金鑰、要開得出對 smtp.gmail.com:465 的 TLS 連線），
// 在本機沒辦法跑、更沒辦法在改壞的當下就知道改壞了。而這支函式庫裡的兩個決定——
// 「哪個狀態該通知誰」與「信裡寫什麼」——恰好是最容易寫錯、錯了又最不容易被發現的部分：
// 漏寄只會表現成「處長說他沒收到信」，誤寄則是把院內報價金額送到不該去的信箱。
// 所以把它壓成不碰任何外部世界的純函式，用 mail.test.ts 在本機驗到綠燈再上線。
//
// 因此本檔的硬性限制（改的人請照守）：
//   1. 不碰 Deno 全域、不 fetch、不 import 任何外部套件——它要能被 Node 直接跑。
//   2. 相對匯入一律帶 .ts 副檔名（Deno 要求），且不得跨目錄 import ../../src/*
//      （那會把整個前端型別圖譜拉進 Deno 的模組解析，Edge Function 會部署失敗）。
//   3. 不用 enum / namespace / 建構子參數屬性——Node 的 --experimental-strip-types
//      只做「擦掉型別」不做轉譯，這些語法會直接報錯。
//
// 測試：node --experimental-strip-types supabase/functions/notify-approval/mail.test.ts

/** Edge Function 用 service_role 從 profiles 查回來的欄位，只取判斷收件人需要的那幾個 */
export interface Profile {
  id: string
  role: string
  /** 停用帳號不寄——人已離職或被停權，信箱可能已被回收 */
  active: boolean
  /** db/25 新增的欄位。內部同仁的登入帳號是 工號@dexin.local 假網域寄不出去，
   *  真正能收信的地址由主管在帳號管理頁人工填；空字串＝這個人不寄。 */
  notify_email: string | null
}

/** Database Webhook payload 裡 record / old_record 的形狀（只列本檔用得到的欄位） */
export interface QuoteRecord {
  id: string
  quote_no: string | null
  project: string | null
  dept: string | null
  status: string
  created_by: string | null
  review_note?: string | null
}

/**
 * 狀態的中文說法。
 *
 * 為什麼在這裡自己抄一份而不 import src/types.ts 的 STATUS_LABEL：見檔頭限制 2，
 * 跨目錄匯入會把前端型別檔拉進 Deno 的模組圖譜。內容與 src/types.ts 逐字一致，
 * 為的是「同仁在信裡看到的字」和「他登入後在畫面上看到的字」是同一句，
 * 不必自己翻譯。改前端那份時記得同步改這裡。
 */
const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  submitted: '待處長核可',
  approved_l1: '待副部長核定',
  approved: '已核定',
  negotiating: '議價中',
  closed: '已定案',
  rejected: '已退回',
}

/**
 * 哪個「新狀態」要寄給哪些角色（使用者 2026-09-14 拍板）。
 *
 *   submitted   → 工務處長（dept_head）：有單等你核可
 *   approved_l1 → 副部長（manager）與行政管理部長（admin_head）：處長核可了，等你核定
 *
 * approved / rejected 的收件人不是角色而是「這張單的開單人」，所以不在這張表裡，
 * 由 CREATOR_STATUSES 另外處理。表裡沒有的狀態（draft / negotiating / closed）一律不寄。
 */
const ROLE_RECIPIENTS: Record<string, string[]> = {
  submitted: ['dept_head'],
  approved_l1: ['manager', 'admin_head'],
}

/** 這兩個狀態是「結果回報」，只通知當初開這張單的人 */
const CREATOR_STATUSES = ['approved', 'rejected']

/**
 * 醫院採購（procurement）一律不收系統通知信。
 *
 * ⚠️ 這是**決策，不是遺漏**：使用者 2026-09-14 拍板，第一版通知信只走內部
 * （處長 → 副部長／部長 → 開單人），對外的採購通知維持現有做法不變。
 * 理由是內部簽核信會帶案名與單號，對外窗口在什麼時機、以什麼措辭收到通知
 * 屬於商務判斷，不該由狀態機自動決定。
 *
 * 所以這條過濾是無條件的：採購帳號即使啟用、即使主管幫他填了 notify_email、
 * 即使他自己就是開單人，都不會出現在收件人名單裡。
 * 未來若要開放對外通知，請連同「寄什麼內容」一起重新討論，不要只把這一行刪掉。
 */
const NEVER_NOTIFY_ROLES = ['procurement']

/** 這個人現在能不能收信：啟用中、不是採購、而且主管幫他填了收信地址 */
const mailableAddress = (p: Profile | undefined): string => {
  if (!p) return ''
  if (!p.active) return ''
  if (NEVER_NOTIFY_ROLES.includes(p.role)) return ''
  return (p.notify_email ?? '').trim()
}

/**
 * 決定這次狀態轉換要寄給誰，回傳去重後的 email 陣列（空陣列＝不寄）。
 *
 * @param profiles Edge Function 已一次查回的全部 profiles（不要為了省事逐角色查多次，
 *                 webhook 是同步呼叫，多一次往返就多一次逾時風險）
 */
export function resolveRecipients(input: {
  newStatus: string
  oldStatus: string
  createdBy: string | null
  profiles: Profile[]
}): string[] {
  const { newStatus, oldStatus, createdBy, profiles } = input

  // 狀態沒變＝這次 UPDATE 動的是金額、註記之類的其他欄位。
  // 報價單在編輯過程會被存很多次，不擋掉的話同一張單會連發好幾封一模一樣的信。
  if (newStatus === oldStatus) return []

  const out: string[] = []

  if (CREATOR_STATUSES.includes(newStatus)) {
    // 核定／退回：只通知開單人。注意這裡走的是**同一組**過濾條件
    // （停用、沒填地址、採購都不寄），不對開單人開後門——
    // 開單人若是已停用的離職同仁，寄過去也只是寄進一個沒人看的信箱。
    const addr = mailableAddress(profiles.find((p) => p.id === createdBy))
    if (addr) out.push(addr)
  } else {
    const roles = ROLE_RECIPIENTS[newStatus]
    if (!roles) return [] // draft / negotiating / closed 等：不在通知範圍內
    for (const p of profiles) {
      if (!roles.includes(p.role)) continue
      const addr = mailableAddress(p)
      if (addr) out.push(addr)
    }
  }

  // 去重：同一個人可能同時符合多條規則，主管之間也可能共用一個部門信箱。
  return [...new Set(out)]
}

/** 空值（null／空字串）在信裡要顯示成「—」而不是 "null"，資料庫這幾個欄位都允許為空 */
const orDash = (v: string | null | undefined): string => {
  const s = (v ?? '').trim()
  return s === '' ? '—' : s
}

/**
 * 組出通知信的主旨與純文字內文。
 *
 * 只做純文字不做 HTML：這封信的唯一任務是「叫人回系統看單」，
 * 真正的內容（金額、明細）一律留在系統裡，信裡不重複貼——
 * 信件會被轉寄、會留在手機上，報價金額不該散落在信箱裡。
 *
 * @param baseUrl 前端網站網址（APP_BASE_URL）。前端用的是 HashRouter（src/App.tsx），
 *                報價單路徑是 `#/quote/:id`，四種通知狀態共用同一個連結形狀。
 */
export function buildMail(input: { record: QuoteRecord; baseUrl: string }): {
  subject: string
  text: string
} {
  const { record, baseUrl } = input
  const statusText = STATUS_LABEL[record.status] ?? record.status
  const quoteNo = orDash(record.quote_no)

  // 使用者設定 APP_BASE_URL 時很可能會順手帶結尾斜線，不去掉會組出 https://x//#/quote/...
  const base = baseUrl.replace(/\/+$/, '')
  const link = `${base}/#/quote/${record.id}`

  const subject = `[德新報價系統] ${quoteNo} ${statusText}`

  const lines = [
    `報價單 ${quoteNo} 的狀態已變更為「${statusText}」。`,
    '',
    `案名：${orDash(record.project)}`,
    `需求單位：${orDash(record.dept)}`,
    `目前狀態：${statusText}`,
  ]

  // 退回理由只在退回時附上。其他狀態的 review_note 是上一輪留下來的舊註記，
  // 夾在核定信裡會讓人以為單子又被退了。
  if (record.status === 'rejected') {
    lines.push(`退回理由：${orDash(record.review_note)}`)
  }

  lines.push(
    '',
    `請點以下連結開啟報價單：`,
    link,
    '',
    '（本信由德新報價系統自動發出，請勿直接回覆。）',
  )

  return { subject, text: lines.join('\n') }
}
