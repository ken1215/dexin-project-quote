import { supabase } from './supabase'

/**
 * session 失效的哨兵訊息。
 * 最常見的觸發情境是「主管改了自己的密碼」——Supabase 會撤銷該使用者既有的 session，
 * 於是下一次呼叫就 401。原本直接把 Edge Function 的「登入憑證無效或已過期」丟到畫面上，
 * 使用者只會覺得系統壞了，根本不知道要重新登入。
 */
export const SESSION_EXPIRED = 'SESSION_EXPIRED'

/**
 * 呼叫 admin-users Edge Function（service_role 只存在於伺服器端，前端拿不到）。
 * 抽到 lib 是因為「強制改密碼」頁也要用同一支——那段錯誤解包邏輯不值得抄第二份。
 */
export async function callAdmin<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error(SESSION_EXPIRED)
  const { data, error } = await supabase.functions.invoke('admin-users', {
    body: { action, ...payload },
  })
  if (error) {
    // Edge Function 回非 2xx 時錯誤訊息藏在 context 裡，挖出來給人看
    const ctx = (error as { context?: Response }).context
    if (ctx && typeof ctx.status === 'number' && ctx.status === 401) throw new Error(SESSION_EXPIRED)
    if (ctx && typeof ctx.json === 'function') {
      try {
        const body = await ctx.json()
        throw new Error(body?.error ?? error.message)
      } catch (e) {
        if (e instanceof Error && e.message !== error.message) throw e
      }
    }
    throw new Error(error.message)
  }
  if (data && typeof data === 'object' && 'error' in data) throw new Error(String(data.error))
  return data as T
}
