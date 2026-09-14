// 簽核通知信 Edge Function
//
// ═══════════════════════════════════════════════════════════════════
// 為什麼需要它
// ═══════════════════════════════════════════════════════════════════
// 報價單送審、核可、核定、退回之後，下一個要動作的人並不知道有單在等他。
// 現況只能靠口頭提醒或自己登入去翻，單子就卡在那裡。這支函式在 quotes.status
// 轉換的當下，用 Gmail SMTP 把通知寄給「下一個該動作的人」。
//
// ── 為什麼用 Database Webhook，不塞進既有 trigger ──────────────────
// quotes 表上已經有 BEFORE UPDATE trigger `quotes_transition_guard`，
// 它會在非法轉換時 raise 例外。把 HTTP 呼叫塞進去有兩個問題：
//   1. 那支 trigger 的職責是「擋下不該發生的轉換」，它會 raise；
//      寄信是副作用，跟「要不要放行」混在同一個交易裡，寄信失敗就會讓
//      使用者的簽核動作整個回滾——單子沒送出去，只因為 Gmail 忙線。
//   2. BEFORE trigger 跑的時候那一列還沒真的寫進去，交易也可能之後才回滾，
//      等於有機會寄出一封「其實沒發生的狀態變更」通知。
// Supabase 的 Database Webhook 走 pg_net 非同步送出，交易 commit 之後才打，
// 寄信失敗不會影響簽核本身——這是正確的責任分界。
//
// ── 為什麼不改前端去 fetch ────────────────────────────────────────
// 簽核動作散在 QuoteEditorPage 的五個地方（送審／核可／核定／退回／議價），
// 每一處都要記得呼叫一次，漏一處就是一個查不到原因的「沒收到信」。
// 而且前端是 public repo 上的靜態網站，寄信憑證不能放在那裡。
//
// ── webhook payload 形狀 ──────────────────────────────────────────
//   { type: 'UPDATE', table: 'quotes', schema: 'public',
//     record: { ...新的那一列... }, old_record: { ...舊的那一列... } }
// record.status === old_record.status 就直接 return——報價單在編輯過程會被存
// 很多次，不擋掉的話同一張單會連發好幾封一模一樣的信。
//
// ── 驗身：為什麼是 --no-verify-jwt 加自訂 header ───────────────────
// 呼叫端是資料庫的 webhook，不是登入中的使用者，它手上沒有、也不該有 JWT。
// 所以本函式必須以 --no-verify-jwt 部署，改用共享密鑰把關：
// webhook 設定裡加一個自訂 header `x-notify-secret`，函式拿它跟環境變數
// NOTIFY_HOOK_SECRET 逐字元比對（常數時間），不符就 401。
// 回應訊息一律不提密鑰內容、不提長度，免得變成線上的猜密碼工具。
//
// ═══════════════════════════════════════════════════════════════════
// 部署手冊（這幾步一律由使用者手動執行，順序不能顛倒）
// ═══════════════════════════════════════════════════════════════════
// 1) 先跑 db/25_notify_email.sql（要先有 profiles.notify_email 欄位）
//
// 2) 設四個環境變數（值不進 repo、不進前端；以下只列名字）：
//      npx supabase secrets set GMAIL_USER=...
//      npx supabase secrets set GMAIL_APP_PASSWORD=...
//      npx supabase secrets set NOTIFY_HOOK_SECRET=...
//      npx supabase secrets set APP_BASE_URL=...
//    · GMAIL_APP_PASSWORD 是 Google 帳號的「應用程式密碼」（16 碼），
//      不是 Gmail 登入密碼；帳號要先開啟兩步驟驗證才申請得到。
//    · NOTIFY_HOOK_SECRET 自己產一串夠長的隨機字串即可（例如 32 碼以上）。
//    · APP_BASE_URL 例：https://dexin-quote.pages.dev（結尾有沒有斜線都可以，
//      組連結時會自動去掉）。
//    · SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY 由平台自動注入，不必自己設。
//
// 3) 部署（一定要帶 --no-verify-jwt，理由見上）：
//      npx supabase functions deploy notify-approval --no-verify-jwt
//
// 4) 先做一次 SMTP 自我測試再去接 webhook（見下方「唯一的技術風險」）：
//      curl -X POST 'https://<專案 ref>.supabase.co/functions/v1/notify-approval' \
//        -H 'Content-Type: application/json' \
//        -H 'x-notify-secret: <你在步驟 2 設的那串>' \
//        -d '{"action":"selftest","to":"someone@example.com"}'
//    回 {"ok":true} 且信箱真的收到＝SMTP 這條路通了，可以往下做。
//    回 500 就照錯誤訊息處理（常見：應用程式密碼貼錯、帳號沒開兩步驟驗證）。
//    收到信但寄件者顯示名是亂碼＝denomailer 沒有 MIME 編碼中文顯示名，
//    把 sendMail() 裡的 from 改成純英文或純信箱即可，不影響收件。
//
// 5) Supabase Dashboard → Database → Webhooks → Create a new hook
//      Table:      quotes
//      Events:     Update（只勾 Update）
//      Type:       HTTP Request，POST
//      URL:        https://<專案 ref>.supabase.co/functions/v1/notify-approval
//      HTTP Headers 加一列：
//                  x-notify-secret : <與步驟 2 相同的那串>
//    建好之後隨便把一張測試單送審，回 Dashboard 看 webhook 的執行紀錄。
//
// ── 唯一的技術風險 ────────────────────────────────────────────────
// Supabase Edge Runtime 能不能從函式內對 smtp.gmail.com:465 開一條原生 TLS 連線，
// 是本案唯一沒有把握、而且只能在線上驗證的一件事（本機測不出來）。
// selftest 入口就是為此而存在：它走的是**與 webhook 完全相同的** sendMail()，
// 所以它通就代表整條路通。若 SMTP 這條路不通，替代路線（改走 Resend／SendGrid
// 之類的 HTTP 寄信 API，或用 pg_cron 批次寄）待議——屆時只需要換掉 sendMail()
// 一支函式，收件人規則與信件內容（mail.ts）完全不用動。
//
// 測試：收件人與信件內容的純邏輯有本機單元測試，
//       node --experimental-strip-types supabase/functions/notify-approval/mail.test.ts
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts'
import { buildMail, resolveRecipients } from './mail.ts'
import type { Profile, QuoteRecord } from './mail.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

/**
 * 常數時間字串比對。
 *
 * 為什麼不直接用 `===`：字串比對一遇到不同的字元就回傳，回應時間會隨著
 * 「猜對了幾個字元」而變長，理論上可以被一個字元一個字元地試出來。
 * 這支函式一律把每個字元都比完才回答。長度不同時直接回 false——
 * 長度本來就從回應時間看得出來，硬要藏也藏不住，但長度以外不再洩漏任何資訊。
 */
const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * 實際寄信。selftest 與 webhook 兩條路徑共用這一支——
 * 這是刻意的：selftest 的唯一價值就是「證明正式路徑寄得出去」，
 * 如果它自己另外寫一套連線，測過了也不代表什麼。
 */
async function sendMail(
  gmailUser: string,
  gmailPassword: string,
  to: string[],
  subject: string,
  text: string,
): Promise<void> {
  const client = new SMTPClient({
    connection: {
      hostname: 'smtp.gmail.com',
      port: 465,
      tls: true, // SMTPS：一連上就是 TLS，不走 STARTTLS 升級
      auth: { username: gmailUser, password: gmailPassword },
    },
  })
  try {
    // 多個收件人放同一個 to 一起寄一封就好：這些人本來就是同一件事的關係人，
    // 逐一寄會讓 Gmail 在短時間內收到大量相同內容的信而觸發寄信頻率限制。
    await client.send({
      from: `德新報價系統 <${gmailUser}>`,
      to,
      subject,
      content: text,
    })
  } finally {
    // 連線一定要收掉。Edge Function 的執行個體會被重複使用，
    // 漏掉的連線會累積在那裡，直到 Gmail 端把後續連線全部拒掉。
    await client.close()
  }
}

Deno.serve(async (req) => {
  // ── 1. 驗身：先做，而且在讀其他環境變數之前做 ──────────────────
  // 順序是刻意的。若先檢查其他環境變數，未通過驗身的呼叫者就能靠回應訊息
  // 探出「哪些 secret 還沒設」。這裡只讀 NOTIFY_HOOK_SECRET，
  // 它自己沒設就是 500（伺服器沒裝好，不是呼叫者的錯），其餘一律先擋在門外。
  const hookSecret = Deno.env.get('NOTIFY_HOOK_SECRET') ?? ''
  if (!hookSecret) return json({ error: '缺環境變數 NOTIFY_HOOK_SECRET' }, 500)

  const presented = req.headers.get('x-notify-secret') ?? ''
  if (!timingSafeEqual(presented, hookSecret)) {
    // 訊息裡不放密鑰、不放長度、不區分「沒帶」與「帶錯」。
    return json({ error: '未授權' }, 401)
  }

  // ── 2. 其餘環境變數（過了驗身才檢查，只說名字不說值）────────────
  const gmailUser = Deno.env.get('GMAIL_USER') ?? ''
  if (!gmailUser) return json({ error: '缺環境變數 GMAIL_USER' }, 500)
  const gmailPassword = Deno.env.get('GMAIL_APP_PASSWORD') ?? ''
  if (!gmailPassword) return json({ error: '缺環境變數 GMAIL_APP_PASSWORD' }, 500)
  // APP_BASE_URL 只有 webhook 路徑用得到，但**刻意在這裡就檢查**：
  // 這樣 selftest 就能一次驗完四個 secret 都設好了。
  // 若留到下面才檢查，selftest 會通過，然後第一張真的有收件人的單才 500 ——
  // 那時候是使用者在等信，不是在做驗證，排錯成本高得多。
  const baseUrl = Deno.env.get('APP_BASE_URL') ?? ''
  if (!baseUrl) return json({ error: '缺環境變數 APP_BASE_URL' }, 500)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: '請求格式錯誤' }, 400)
  }

  // ── 3. SMTP 自我測試（部署後的一鍵驗證，見檔頭步驟 4）───────────
  if (body.action === 'selftest') {
    const to = String(body.to ?? '').trim()
    if (!to) return json({ error: 'selftest 需要收件地址 to' }, 400)
    try {
      await sendMail(
        gmailUser, gmailPassword, [to],
        '[德新報價系統] SMTP 自我測試',
        '這是一封測試信。收到它代表 Edge Function 連得上 smtp.gmail.com:465，\n'
          + '簽核通知信的寄送路徑沒有問題。',
      )
      return json({ ok: true })
    } catch (e) {
      // 這裡刻意把 SMTP 的原始錯誤訊息回出去——這個入口只有握有 NOTIFY_HOOK_SECRET
      // 的人叫得動，而看不到真正的錯誤就沒辦法判斷是密碼錯、兩步驟驗證沒開，
      // 還是 Edge Runtime 根本開不出這條 TLS 連線。
      return json({ error: e instanceof Error ? e.message : String(e) }, 500)
    }
  }

  // ── 4. 以下是 webhook 路徑 ──────────────────────────────────────
  // 不是 quotes 的 UPDATE 就安靜跳過。回 200 而不是 4xx：webhook 可能被誤設到
  // 別的表或別的事件，那是設定問題，不該在 pg_net 留下一整排看起來很嚴重的錯誤。
  if (body.type !== 'UPDATE' || body.table !== 'quotes') {
    return json({ skipped: 'not quotes update' })
  }
  const record = body.record as QuoteRecord | undefined
  const oldRecord = body.old_record as QuoteRecord | undefined
  if (!record || !oldRecord) return json({ skipped: 'no record' })
  if (record.status === oldRecord.status) return json({ skipped: 'status unchanged' })

  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!url || !serviceKey) return json({ error: '缺平台注入的 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' }, 500)

  // profiles 有 RLS，而呼叫端是 webhook 沒有使用者身分，只能用 service_role 讀。
  // 一次把全部人撈回來再在記憶體裡篩，不要逐角色查多次——webhook 是同步呼叫，
  // 多一次資料庫往返就多一次逾時風險，而這張表只有數十列。
  const admin = createClient(url, serviceKey)
  const { data: profiles, error: profErr } = await admin
    .from('profiles').select('id, role, active, notify_email')
  if (profErr) return json({ error: profErr.message }, 500)

  const to = resolveRecipients({
    newStatus: record.status,
    oldStatus: oldRecord.status,
    createdBy: record.created_by,
    profiles: (profiles ?? []) as Profile[],
  })

  // 沒有收件人是**正常結果**（例如轉成 negotiating，或處長還沒填通知信箱），
  // 所以回 200 不回 5xx。webhook 失敗不會重試，只會在紀錄裡留一筆紅字，
  // 把正常情況記成失敗只會讓真正該查的錯誤被淹沒。
  if (to.length === 0) return json({ sent: 0 })

  const { subject, text } = buildMail({ record, baseUrl })
  try {
    await sendMail(gmailUser, gmailPassword, to, subject, text)
  } catch (e) {
    // 真的寄失敗就回 500——這一筆該在 webhook 紀錄裡顯示成失敗，
    // 才有人會發現「通知信整批沒寄出去」。
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
  return json({ sent: to.length })
})
