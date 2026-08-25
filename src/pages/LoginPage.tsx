import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabaseConfigured } from '../lib/supabase'

export default function LoginPage() {
  const { session, signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (session) return <Navigate to="/" replace />

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError(null)
    const msg = await signIn(email, password)
    if (msg) setError(msg)
    setSubmitting(false)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-50 px-4">
      <div className="w-full max-w-sm">
        <div className="card">
          <div className="mb-6 text-center">
            <h1 className="text-lg font-bold text-deep">
              德新物業(立德新)專案工程報價系統
            </h1>
            <p className="mt-1 text-xs text-ink-500">立德新股份有限公司 · 工務處</p>
          </div>

          {!supabaseConfigured && (
            <div className="mb-4 rounded-md border border-yellow-300 bg-yellow-50 p-3 text-xs text-yellow-800">
              系統尚未設定 Supabase 連線（VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY）
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <div className="mb-3">
              <label className="label" htmlFor="login-email">Email</label>
              <input
                id="login-email"
                type="email"
                className="field"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
              />
            </div>
            <div className="mb-4">
              <label className="label" htmlFor="login-password">密碼</label>
              <input
                id="login-password"
                type="password"
                className="field"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>

            {error && (
              <p className="mb-3 text-sm text-warn">{error}</p>
            )}

            <button type="submit" className="btn btn-primary w-full" disabled={submitting}>
              {submitting ? '登入中…' : '登入'}
            </button>
          </form>

          <p className="mt-5 text-center text-xs text-ink-500">
            帳號由工務處主管建立，忘記密碼請洽主管。
          </p>
        </div>
      </div>
    </div>
  )
}
