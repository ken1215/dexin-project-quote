import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabaseConfigured } from '../lib/supabase'
// 從 src/assets 匯入而不是寫 public/ 的絕對路徑：Vite 會處理雜湊與 base 前綴。
// 這個系統有三個部署目標（本機／GitHub Pages 子路徑／Cloudflare 根目錄），
// 寫死路徑會在其中一個上面 404。
import logo from '../assets/logo-landseed.png'

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
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-ink-50 px-4 py-8">
      {/* 背景：CIS 深藍→亮藍的極淡光暈。用 blur 的色塊而不是整片漸層底，
          避免把表單區的對比壓掉——這是給第一線同仁在工地用的登入頁，
          可讀性優先於視覺效果。pointer-events-none 確保它不吃點擊。 */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -left-24 -top-24 h-72 w-72 rounded-full bg-deep/10 blur-3xl" />
        <div className="absolute -bottom-32 -right-24 h-80 w-80 rounded-full bg-bright/10 blur-3xl" />
        <div className="absolute bottom-1/3 left-1/4 h-40 w-40 rounded-full bg-green/[0.07] blur-3xl" />
      </div>

      <div className="relative w-full max-w-sm">
        <div className="overflow-hidden rounded-xl border border-ink-200 bg-white shadow-lg shadow-deep/5">
          {/* 頂部識別帶：深藍→亮藍→CIS 綠，集團三色一次到位 */}
          <div className="h-1.5 bg-gradient-to-r from-deep via-bright to-green" />

          <div className="px-6 py-7 sm:px-8">
            <div className="mb-6 text-center">
              <img
                src={logo}
                alt="LANDSEED 聯新國際醫療"
                /* 官方 lockup 比例 5.3929:1，只給寬度、高度自動，不要壓變形 */
                className="mx-auto w-[13.5rem] max-w-full"
              />
              <div className="mt-5 border-t border-ink-200 pt-4">
                <h1 className="text-base font-bold tracking-wide text-deep">
                  專案工程報價系統
                </h1>
                <p className="mt-1 text-xs text-ink-500">
                  立德新股份有限公司 · 工務處
                </p>
              </div>
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
                  className="field text-center tracking-[0.35em] placeholder:tracking-normal"
                  value={loginId}
                  onChange={(e) => setLoginId(e.target.value)}
                  placeholder="6 碼數字"
                  autoComplete="username"
                  autoCapitalize="off"
                  spellCheck={false}
                  autoFocus
                  required
                />
              </div>
              <div className="mb-5">
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
                <p
                  role="alert"
                  className="mb-3 rounded-md border border-warn/30 bg-warn-bg px-3 py-2 text-sm text-warn"
                >
                  {error}
                </p>
              )}

              <button
                type="submit"
                className="btn btn-primary w-full py-2.5 text-[0.9375rem] font-semibold tracking-wide"
                disabled={submitting}
              >
                {submitting ? '登入中…' : '登入'}
              </button>
            </form>
          </div>

          <div className="border-t border-ink-200 bg-ink-50/70 px-6 py-4 text-center text-xs leading-relaxed text-ink-500 sm:px-8">
            工號由行政管理部建立，初始密碼與工號相同，登入後請自行更改。<br />
            忘記密碼請洽行政管理部。外部單位帳號請直接輸入 Email。
          </div>
        </div>

        <p className="mt-5 text-center text-[0.6875rem] text-ink-500">
          © 聯新國際醫療集團 · 立德新股份有限公司
        </p>
      </div>
    </div>
  )
}
