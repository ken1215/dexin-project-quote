import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import type { Profile } from '../types'

/**
 * 工號登入用的合成網域。使用者輸入 6 碼工號，實際送給 Supabase 的是
 * `工號@dexin.local`——Supabase Auth 只認 email，但這個信箱永遠不會收信
 * （建帳號時 email_confirm: true，忘記密碼一律洽主管）。
 * 醫院採購那類外部帳號沿用真實 email，所以這裡只轉換「純 6 碼數字」。
 */
export const EMP_DOMAIN = 'dexin.local'
export const isEmployeeNo = (v: string) => /^\d{6}$/.test(v.trim())
export const toLoginEmail = (v: string) => {
  const id = v.trim()
  return isEmployeeNo(id) ? `${id}@${EMP_DOMAIN}` : id
}
/** 反向：拿 email 顯示成工號（外部帳號就原樣顯示 email） */
export const toEmployeeNo = (email: string) =>
  email.endsWith(`@${EMP_DOMAIN}`) ? email.split('@')[0] : email

interface AuthValue {
  session: Session | null
  profile: Profile | null
  loading: boolean
  /** 核決層（工務處長或副部長）：單價庫、物價指數、看得到底價與全部單據 */
  isManager: boolean
  /** 工務處長：簽核第一關 */
  isDeptHead: boolean
  /** 行政管理部副部長：最終核決，可越級、可管帳號、可議價定案 */
  isAdmin: boolean
  /** 醫院採購：只能看已送出的單並登錄還價，看不到單價庫與底價 */
  isProcurement: boolean
  /** 自家人（同仁或主管） */
  isInternal: boolean
  /** 帶入工號（6 碼）或 email 皆可 */
  signIn: (loginId: string, password: string) => Promise<string | null>
  signOut: () => Promise<void>
  /** 自行更改密碼。成功後 Supabase 會撤銷本人 session，呼叫端要導回登入頁 */
  changePassword: (newPassword: string) => Promise<string | null>
}

const Ctx = createContext<AuthValue>({
  session: null, profile: null, loading: true, isManager: false,
  isDeptHead: false, isAdmin: false,
  isProcurement: false, isInternal: false,
  signIn: async () => '未初始化', signOut: async () => {},
  changePassword: async () => '未初始化',
})

export const useAuth = () => useContext(Ctx)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      if (!data.session) setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s)
      if (!s) { setProfile(null); setLoading(false) }
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) return
    let cancelled = false
    setLoading(true)
    supabase.from('profiles').select('*').eq('id', session.user.id).maybeSingle()
      .then(({ data }) => {
        if (cancelled) return
        setProfile((data as Profile) ?? null)
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [session])

  const value: AuthValue = {
    session,
    profile,
    loading,
    isManager: (profile?.role === 'manager' || profile?.role === 'dept_head') && profile.active,
    isDeptHead: profile?.role === 'dept_head' && profile.active,
    isAdmin: profile?.role === 'manager' && profile.active,
    isProcurement: profile?.role === 'procurement' && profile.active,
    isInternal:
      (profile?.role === 'manager' || profile?.role === 'dept_head' ||
       profile?.role === 'staff') && profile.active,
    async signIn(loginId, password) {
      const { error } = await supabase.auth.signInWithPassword({
        email: toLoginEmail(loginId), password,
      })
      // Supabase 一律回英文的 Invalid login credentials，對第一線同仁沒有意義
      if (!error) return null
      return /invalid login credentials/i.test(error.message)
        ? '工號或密碼不正確'
        : error.message
    },
    async changePassword(newPassword) {
      const { error } = await supabase.auth.updateUser({ password: newPassword })
      return error ? error.message : null
    },
    async signOut() {
      await supabase.auth.signOut()
      setProfile(null)
    },
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
