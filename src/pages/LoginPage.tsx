import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabaseConfigured } from '../lib/supabase'

export default function LoginPage() {
  const { session, signIn } = useAuth()
  const [loginId, setLoginId] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (session) return <Navigate to="/" replace />

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError(null)
    const msg = await signIn(loginId, password)
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
              <label className="label" htmlFor="login-id">工號</label>
              {/* type 不能是 email——瀏覽器內建驗證會擋掉純數字的工號。
                  inputMode="numeric" 讓手機直接跳數字鍵盤。 */}
              <input
                id="login-id"
                type="text"
                inputMode="numeric"
                className="field"
                value={loginId}
                onChange={(e) => setLoginId(e.target.value)}
                placeholder="6 碼數字"
                autoComplete="username"
                autoCapitalize="off"
                spellCheck={false}
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
            工號由行政管理部建立，初始密碼與工號相同，登入後請自行更改。<br />
            忘記密碼請洽行政管理部。外部單位帳號請直接輸入 Email。
          </p>
        </div>
      </div>
    </div>
  )
}
