import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** 設定缺漏時不要在畫面上靜默失敗——直接讓使用者看到該補什麼 */
export const supabaseConfigured = Boolean(url && key)

export const supabase = createClient(
  url || 'http://localhost:54321',
  key || 'public-anon-key-not-set',
  { auth: { persistSession: true, autoRefreshToken: true } },
)
