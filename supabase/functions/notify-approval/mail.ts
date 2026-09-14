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
 * 組出通知信的主旨、純文字內文與 CIS 版型的 HTML 內文。
 *
 * 兩種內文都給：HTML 是給看得到樣式的收件者，純文字是 multipart 的另一半——
 * 有人把信箱設成純文字模式、有人用手錶或通知列預覽，那時只剩 text 這一份。
 * 兩份內容必須等價，不能只在 HTML 裡講重要的事。
 *
 * **兩份都不含金額與明細**：這封信的唯一任務是「叫人回系統看單」。
 * 信件會被轉寄、會留在手機上，報價金額不該散落在信箱裡。
 *
 * @param baseUrl 前端網站網址（APP_BASE_URL）。前端用的是 HashRouter（src/App.tsx），
 *                報價單路徑是 `#/quote/:id`，四種通知狀態共用同一個連結形狀。
 */
export function buildMail(input: { record: QuoteRecord; baseUrl: string }): {
  subject: string
  text: string
  html: string
} {
  const { record, baseUrl } = input
  const statusText = STATUS_LABEL[record.status] ?? record.status
  const quoteNo = orDash(record.quote_no)

  // 使用者設定 APP_BASE_URL 時很可能會順手帶結尾斜線，不去掉會組出 https://x//#/quote/...
  const base = baseUrl.replace(/\/+$/, '')
  const link = `${base}/#/quote/${record.id}`

  const subject = encodeMimeHeader(`[德新報價系統] ${quoteNo} ${statusText}`)

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

  return {
    subject,
    text: lines.join('\n'),
    html: buildHtml({ record, statusText, quoteNo, link }),
  }
}

/**
 * HTML 內文。設計上的幾個限制，動之前請先讀：
 *
 * 1. **一律用 table 排版、樣式一律寫成 inline style**。信件用戶端（尤其 Outlook）
 *    會把 <style> 區塊整段丟掉，flex/grid 更是不支援。這裡看起來像 2005 年的寫法，
 *    是因為信箱的排版引擎就停在那裡。
 * 2. **不放任何圖片**，連標誌都不放。Gmail 預設擋遠端圖片，擋掉之後標誌會變成破圖框，
 *    比純文字字標更難看；而把圖片轉成 base64 內嵌會讓信件肥大又常被判垃圾信。
 *    所以標誌改用文字字標，永遠渲染得出來。
 * 3. **淺底深字，不用深藍底白字的橫條**（使用者偏好）。層級靠左側色條與字級拉開，
 *    不靠色塊撞色。行距放寬到 1.8。
 * 4. 色票取自這個系統自己的 `src/index.css`（德新墨階 ＋ 新芽綠 ＋ CIS 深藍），
 *    不是集團簡報模板那一套——信要長得像它連過去的那個系統。
 * 5. **所有來自資料庫的字串都要經 escapeHtml()**：案名、需求單位、退回理由都是
 *    使用者自己打的，裡面出現 `<` 或 `&` 會把版面弄壞。
 */
function buildHtml(input: {
  record: QuoteRecord
  statusText: string
  quoteNo: string
  link: string
}): string {
  const { record, statusText, quoteNo, link } = input

  // 狀態色：呼應系統裡 StatusTag 的語意——等人動作用藍、完成用綠、退回用警示紅
  const ACCENT: Record<string, string> = {
    submitted: '#008CD6',   // 亮藍：等處長
    approved_l1: '#0054A7', // 深藍：等核決層
    approved: '#00A94F',    // CIS 綠：已核定
    rejected: '#C0392B',    // 警示紅：已退回
  }
  const accent = ACCENT[record.status] ?? '#4B4745'

  const FONT = "'Microsoft JhengHei','微軟正黑體',-apple-system,'Segoe UI',sans-serif"
  const e = escapeHtml

  /** 明細列：左欄標籤用墨 500，右欄值用墨 900 */
  const row = (label: string, value: string) =>
    `<tr>` +
    `<td style="padding:6px 16px 6px 0;font-size:13px;color:#78736E;white-space:nowrap;vertical-align:top;">${e(label)}</td>` +
    `<td style="padding:6px 0;font-size:14px;color:#3E3A39;line-height:1.8;">${e(value)}</td>` +
    `</tr>`

  const rows = [
    row('案名', orDash(record.project)),
    row('需求單位', orDash(record.dept)),
    row('目前狀態', statusText),
    // 退回理由只在退回時附上，理由同純文字版
    record.status === 'rejected' ? row('退回理由', orDash(record.review_note)) : '',
  ].join('')

  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F6F5F2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F6F5F2;">
<tr><td align="center" style="padding:24px 12px;">

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="max-width:560px;background:#ffffff;border:1px solid #DEDCD8;border-radius:10px;font-family:${FONT};">

    <!-- 字標：新芽綠方塊 ＋ 系統名，不放圖片 -->
    <tr><td style="padding:22px 24px 0;">
      <span style="display:inline-block;width:10px;height:10px;background:#8FC31F;border-radius:2px;"></span>
      <span style="margin-left:8px;font-size:13px;color:#78736E;letter-spacing:.06em;">德新物業 · 專案工程報價系統</span>
    </td></tr>

    <!-- 標題：左側色條分層，淺底深字 -->
    <tr><td style="padding:18px 24px 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td width="3" style="background:${accent};border-radius:2px;font-size:0;line-height:0;">&nbsp;</td>
          <td style="padding-left:14px;">
            <div style="font-size:20px;font-weight:700;color:#3E3A39;line-height:1.5;">${e(quoteNo)}</div>
            <div style="margin-top:2px;font-size:15px;font-weight:600;color:${accent};line-height:1.6;">${e(statusText)}</div>
          </td>
        </tr>
      </table>
    </td></tr>

    <!-- 明細 -->
    <tr><td style="padding:18px 24px 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${rows}</table>
    </td></tr>

    <!-- 主要動作 -->
    <tr><td style="padding:22px 24px 0;">
      <a href="${e(link)}" style="display:inline-block;padding:11px 22px;background:#0054A7;color:#ffffff;
         font-size:14px;font-weight:600;text-decoration:none;border-radius:6px;">開啟報價單</a>
      <div style="margin-top:10px;font-size:12px;color:#78736E;line-height:1.8;word-break:break-all;">
        按鈕沒反應請複製這個網址：<br>${e(link)}
      </div>
    </td></tr>

    <!-- 頁尾 -->
    <tr><td style="padding:20px 24px 22px;">
      <div style="border-top:1px solid #DEDCD8;padding-top:14px;font-size:12px;color:#78736E;line-height:1.8;">
        本信不含金額與明細，請點連結回系統查看。<br>
        由德新報價系統自動發出，請勿直接回覆。
      </div>
    </td></tr>

  </table>

</td></tr></table>
</body></html>`
}

/** 信件用戶端不會幫你擋，來自資料庫的字串一律先過這一關 */
function escapeHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 把一段可能含中文的標頭值編成 RFC 2047 的 base64 encoded-word，
 * 並保證回傳的整串是**純 ASCII、且不以編碼字開頭**。
 *
 * ── 為什麼非自己編不可（2026-09-14 線上事故）─────────────────────
 * denomailer 1.6.0 的 quotedPrintableEncodeInline 會拿「內文」的 QP 規則
 * 去編含非 ASCII 的標頭：每 74 個字元插一個「等號 + CRLF」的軟換行。
 * 那在內文是合法的，在標頭不是——標頭折行必須是「CRLF + 空白」，
 * 裸 CRLF 會直接終止整個標頭區。後果是 Content-Type 連同其後所有標頭
 * 全部掉進 body，信件用戶端把整封信當純文字顯示，收件者看到一整片
 * MIME 原始碼。上游 main 分支至今仍是同一段程式碼，升版解決不了。
 *
 * ── 為什麼這樣就繞得過去 ─────────────────────────────────────────
 * 那支函式自己留了出路：
 *     if (hasNonAsciiCharacters(data) || data.startsWith("=?")) { ...編碼... }
 *     return data
 * 純 ASCII 而且不以編碼字開頭的值，它原樣放行。RFC 2047 的 encoded-word
 * 本來就是純 ASCII，所以我們自己編好它就完全碰不到我們。
 * 結尾那個「以編碼字開頭就補一個空白」不是美觀問題：單號為 null 時
 * orDash() 會回全形破折號，主旨就會以 `=?` 開頭而被重新編碼一次。
 *
 * ⚠️ 這個限制同樣適用於 From 的顯示名與任何其他含中文的標頭，
 *    不是只有主旨。加新標頭一律先過這一關。
 */
export function encodeMimeHeader(value: string): string {
  // encoded-word 連同 `=?utf-8?B?` 與 `?=` 不得超過 75 字元（RFC 2047）。
  // 扣掉 12 字元的框，base64 只剩 63 字元 ≈ 47 bytes；中日韓一字 3 bytes，
  // 取 14 字一組（14×3=42 bytes → 56 字元 base64 → 全長 68）留有餘裕。
  const CHARS_PER_WORD = 14

  const toBase64 = (v: string): string => {
    const bytes = new TextEncoder().encode(v)
    let binary = ''
    for (const b of bytes) binary += String.fromCharCode(b)
    return btoa(binary)
  }

  // 拆成 ASCII／非 ASCII 交替的片段。ASCII 片段原樣留著——單號在主旨裡
  // 保持可讀，順便讓整串不會以編碼字開頭。
  const segments = value.match(/[\u0000-\u007f]+|[^\u0000-\u007f]+/g) ?? []
  let out = ''
  for (const seg of segments) {
    if (!/[^\u0000-\u007f]/.test(seg)) {
      out += seg
      continue
    }
    // Array.from 依「字元」而非 UTF-16 單元切，避免把代理對劈成兩半
    const chars = Array.from(seg)
    const words: string[] = []
    for (let i = 0; i < chars.length; i += CHARS_PER_WORD) {
      words.push(`=?utf-8?B?${toBase64(chars.slice(i, i + CHARS_PER_WORD).join(''))}?=`)
    }
    // 相鄰 encoded-word 之間的空白，解碼時會被吃掉（RFC 2047 §6.2）
    out += words.join(' ')
  }
  return out.startsWith('=?') ? ` ${out}` : out
}
