// 帳號管理 Edge Function
//
// 為什麼需要它：建立／刪除帳號、重設密碼都要 service_role 金鑰，
// 而前端是 public repo 上的靜態網站，任何人都看得到原始碼——
// service_role 放進去等於把資料庫鑰匙公開。所以這些動作只能在伺服器端做，
// 而且每次都要重新確認「呼叫的人真的是主管」，不能只靠前端藏按鈕。
//
// 部署：npx supabase functions deploy admin-users
import { createClient } from 'jsr:@supabase/supabase-js@2'

/** 工號登入的合成網域，與前端 AuthContext 的 EMP_DOMAIN 必須一致 */
const EMP_DOMAIN = 'dexin.local'
const isEmployeeNo = (v: string) => /^\d{6}$/.test(v)
/** 帳號欄位收 6 碼工號（內部同仁）或真實 email（醫院採購那類外部帳號） */
const toLoginEmail = (v: string) => (isEmployeeNo(v) ? `${v}@${EMP_DOMAIN}` : v)
/** 密碼下限 6 碼——初始密碼就是 6 碼工號 */
const MIN_PW = 6

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const url = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

  // ── 1. 確認呼叫者是誰 ──────────────────────────────────────
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: '未帶登入憑證' }, 401)

  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: me, error: meErr } = await caller.auth.getUser()
  if (meErr || !me?.user) return json({ error: '登入憑證無效或已過期' }, 401)

  // ── 2. 確認呼叫者是「啟用中的主管」（每次都查，不信前端）────
  const admin = createClient(url, serviceKey)
  const { data: profile } = await admin
    .from('profiles').select('role, active').eq('id', me.user.id).maybeSingle()

  // 副部長：全部帳號都能管。工務處長：只能管 staff，且不能刪帳號。
  // 收在 staff 的理由是**提權**——處長若能建立或改成 manager，
  // 就能把自己升成副部長，兩關簽核與「不可逆三件事」的界線同時失效。
  // 這是與資料庫政策 profiles_dept_head_staff 同一條界線的第二道鎖。
  // 行政管理部長（admin_head）權限等同副部長，差別只在單價維護唯讀（DB 層 is_price_editor）
  const isAdmin = ['manager', 'admin_head'].includes(profile?.role ?? '') && !!profile?.active
  const isDeptHead = profile?.role === 'dept_head' && profile.active

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: '請求格式錯誤' }, 400)
  }
  const action = String(body.action ?? '')

  // ── 改自己的密碼：**在角色關卡之前**處理 ───────────────────
  // 被 must_change_password 鎖住的同仁本來就不是主管，卡在下面那道 403 就永遠
  // 改不了密碼、也就永遠解不開鎖。這個動作只需要「有效的 session」。
  //
  // 為什麼不讓前端自己呼叫 auth.updateUser 再把旗標關掉：前端是 public repo 上的
  // 靜態網站，旗標若由客戶端關，一行 console 指令就能跳過強制更換，
  // 而攻擊情境正好是「別人拿你的工號登入」。改密碼與關旗標必須在同一支
  // 伺服器端函式裡完成，中間沒有客戶端插手的餘地。
  if (action === 'change_own_password') {
    const password = String(body.password ?? '')
    if (password.length < MIN_PW) return json({ error: `密碼至少 ${MIN_PW} 碼` }, 400)
    const empNo = (me.user.email ?? '').split('@')[0]
    if (isEmployeeNo(empNo) && password === empNo) {
      return json({ error: '新密碼不能與工號相同，請換一組' }, 400)
    }
    if (!profile?.active) return json({ error: '此帳號已停用，請洽主管' }, 403)

    const up = await admin.auth.admin.updateUserById(me.user.id, { password })
    if (up.error) return json({ error: up.error.message }, 500)
    // 密碼確定改掉了才解鎖。順序反過來會出現「旗標關了但密碼沒換」的窗口。
    const { error: flagErr } = await admin.from('profiles')
      .update({ must_change_password: false }).eq('id', me.user.id)
    if (flagErr) return json({ error: flagErr.message }, 500)
    return json({ ok: true })
  }

  if (!isAdmin && !isDeptHead) {
    return json({ error: '此功能限行政管理部（部長／副部長）或工務處長使用' }, 403)
  }

  /** 這個呼叫者能不能動「角色為 r」的帳號 */
  const mayTouchRole = (r: string) => isAdmin || r === 'staff'
  /** 查某個帳號目前的角色（處長只能動 staff，要先查了才知道） */
  const roleOf = async (id: string): Promise<string | null> => {
    const { data } = await admin.from('profiles').select('role').eq('id', id).maybeSingle()
    return (data?.role as string | undefined) ?? null
  }

  // ── 3. 執行動作（body 與 action 已在上一段解析）────────────
  try {
    switch (action) {
      // 列出所有帳號（含 email 與最後登入時間，profiles 表沒有這些）
      case 'list': {
        const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
        if (error) throw error
        const { data: profiles } = await admin.from('profiles').select('*')
        const byId = new Map((profiles ?? []).map((p) => [p.id, p]))
        return json({
          users: data.users.map((u) => ({
            id: u.id,
            email: u.email,
            created_at: u.created_at,
            last_sign_in_at: u.last_sign_in_at,
            full_name: byId.get(u.id)?.full_name ?? '',
            role: byId.get(u.id)?.role ?? 'staff',
            active: byId.get(u.id)?.active ?? true,
            must_change_password: byId.get(u.id)?.must_change_password ?? false,
          })),
        })
      }

      case 'create': {
        const loginId = String(body.email ?? '').trim()
        const fullName = String(body.full_name ?? '').trim()
        const role = ['manager', 'admin_head', 'dept_head', 'procurement'].includes(String(body.role))
          ? String(body.role) : 'staff'
        if (!mayTouchRole(role)) {
          return json({ error: '工務處長只能建立「同仁」帳號，其他角色請洽行政管理部' }, 403)
        }

        if (!isEmployeeNo(loginId) && !loginId.includes('@')) {
          return json({ error: '請填 6 碼數字工號，外部單位帳號才填 Email' }, 400)
        }
        const email = toLoginEmail(loginId)
        // 初始密碼留空＝與工號相同（外部 email 帳號沒有工號可帶，一定要填）
        const password = String(body.password ?? '') || (isEmployeeNo(loginId) ? loginId : '')
        if (password.length < MIN_PW) {
          return json({ error: `密碼至少 ${MIN_PW} 碼` }, 400)
        }

        const { data, error } = await admin.auth.admin.createUser({
          email, password, email_confirm: true,
          user_metadata: { full_name: fullName || loginId },
        })
        if (error) throw error
        // trigger 會自動建 profile，這裡補上姓名與角色
        // trigger 建的 profile 預設 active=false（防自行註冊的人讀到資料），
        // 由主管建立的帳號在這裡明確設成啟用
        // must_change_password：主管發出的初始密碼（留空＝工號）本人首次登入必須換掉。
        // 在換掉之前，db/23 讓所有身分判斷函式回 false，等於讀不到任何業務資料。
        await admin.from('profiles')
          .update({
            full_name: fullName || loginId, role, active: true,
            must_change_password: true,
          })
          .eq('id', data.user.id)
        return json({ ok: true, id: data.user.id })
      }

      case 'reset_password': {
        const id = String(body.id ?? '')
        const password = String(body.password ?? '')
        if (password.length < MIN_PW) return json({ error: `密碼至少 ${MIN_PW} 碼` }, 400)
        const target = await roleOf(id)
        if (target && !mayTouchRole(target)) {
          return json({ error: '工務處長只能重設「同仁」的密碼' }, 403)
        }
        const { error } = await admin.auth.admin.updateUserById(id, { password })
        if (error) throw error
        // 主管重設出來的密碼與新建帳號是同一種東西（第三人知道），一樣要本人再換一次
        await admin.from('profiles').update({ must_change_password: true }).eq('id', id)
        return json({ ok: true })
      }

      case 'delete': {
        // 刪除不可逆，與「不可逆的事只留副部長」一致；處長請改用「停用」
        if (!isAdmin) {
          return json({ error: '刪除帳號限行政管理部（部長／副部長）；工務處長請改用「停用」（停用即無法登入，且可回復）' }, 403)
        }
        const id = String(body.id ?? '')
        if (id === me.user.id) return json({ error: '不能刪除自己的帳號' }, 400)
        // 這個人開過的報價單還在，刪帳號會讓 created_by 的外鍵失效，先擋下來
        const { count } = await admin
          .from('quotes').select('id', { count: 'exact', head: true }).eq('created_by', id)
        if ((count ?? 0) > 0) {
          return json({
            error: `此帳號名下還有 ${count} 張報價單，刪除會破壞單據紀錄。建議改為「停用」。`,
          }, 409)
        }
        const { error } = await admin.auth.admin.deleteUser(id)
        if (error) throw error
        return json({ ok: true })
      }

      default:
        return json({ error: '未知的動作：' + action }, 400)
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
