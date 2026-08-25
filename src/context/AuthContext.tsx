import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import type { Profile } from '../types'

interface AuthValue {
  session: Session | null
  profile: Profile | null
  loading: boolean
  isManager: boolean
  /** 醫院採購：只能看已送出的單並登錄還價，看不到單價庫與底價 */
  isProcurement: boolean
  /** 自家人（同仁或主管） */
  isInternal: boolean
  signIn: (email: string, password: string) => Promise<string | null>
  signOut: () => Promise<void>
}

const Ctx = createContext<AuthValue>({
  session: null, profile: null, loading: true, isManager: false,
  isProcurement: false, isInternal: false,
  signIn: async () => '未初始化', signOut: async () => {},
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
    isManager: profile?.role === 'manager' && profile.active,
    isProcurement: profile?.role === 'procurement' && profile.active,
    isInternal: (profile?.role === 'manager' || profile?.role === 'staff') && profile.active,
    async signIn(email, password) {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      return error ? error.message : null
    },
    async signOut() {
      await supabase.auth.signOut()
      setProfile(null)
    },
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
