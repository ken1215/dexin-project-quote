// 帳號管理 Edge Function
//
// 為什麼需要它：建立／刪除帳號、重設密碼都要 service_role 金鑰，
// 而前端是 public repo 上的靜態網站，任何人都看得到原始碼——
// service_role 放進去等於把資料庫鑰匙公開。所以這些動作只能在伺服器端做，
// 而且每次都要重新確認「呼叫的人真的是主管」，不能只靠前端藏按鈕。
//
// 部署：npx supabase functions deploy admin-users
import { createClient } from 'jsr:@supabase/supabase-js@2'

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

  if (!profile || profile.role !== 'manager' || !profile.active) {
    return json({ error: '此功能限啟用中的主管使用' }, 403)
  }

  // ── 3. 執行動作 ────────────────────────────────────────────
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: '請求格式錯誤' }, 400)
  }
  const action = String(body.action ?? '')

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
          })),
        })
      }

      case 'create': {
        const email = String(body.email ?? '').trim()
        const password = String(body.password ?? '')
        const fullName = String(body.full_name ?? '').trim()
        const role = body.role === 'manager' ? 'manager' : 'staff'
        if (!email.includes('@')) return json({ error: 'Email 格式不正確' }, 400)
        if (password.length < 8) return json({ error: '密碼至少 8 碼' }, 400)

        const { data, error } = await admin.auth.admin.createUser({
          email, password, email_confirm: true,
          user_metadata: { full_name: fullName || email.split('@')[0] },
        })
        if (error) throw error
        // trigger 會自動建 profile，這裡補上姓名與角色
        await admin.from('profiles')
          .update({ full_name: fullName || email.split('@')[0], role })
          .eq('id', data.user.id)
        return json({ ok: true, id: data.user.id })
      }

      case 'reset_password': {
        const id = String(body.id ?? '')
        const password = String(body.password ?? '')
        if (password.length < 8) return json({ error: '密碼至少 8 碼' }, 400)
        const { error } = await admin.auth.admin.updateUserById(id, { password })
        if (error) throw error
        return json({ ok: true })
      }

      case 'delete': {
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
