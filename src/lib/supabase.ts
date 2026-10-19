import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** 設定缺漏時不要在畫面上靜默失敗——直接讓使用者看到該補什麼 */
export const supabaseConfigured = Boolean(url && key)

/**
 * 剛登入（或換發憑證）的頭幾秒，Auth 伺服器時鐘比 PostgREST 快一兩秒，
 * 新憑證會被判「JWT issued at future」。等 1.5 秒重送即可，最多 3 次。
 */
const fetchWithClockSkewRetry: typeof fetch = async (input, init) => {
  for (let i = 0; ; i++) {
    const res = await fetch(input, init)
    if (res.status !== 401 || i >= 3) return res
    if (!/issued at future/i.test(await res.clone().text())) return res
    await new Promise((r) => setTimeout(r, 1500))
  }
}

export const supabase = createClient(
  url || 'http://localhost:54321',
  key || 'public-anon-key-not-set',
  {
    auth: { persistSession: true, autoRefreshToken: true },
    global: { fetch: fetchWithClockSkewRetry },
  },
)
