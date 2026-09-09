import { useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { callAdmin, SESSION_EXPIRED } from '../lib/adminApi'

/**
 * 首次登入強制更換密碼。
 *
 * 為什麼是整頁而不是 dialog：dialog 看起來就是「可以關掉」的東西，而這一關不能跳過。
 * 資料庫層（db/23）在旗標解除前把所有業務資料都關掉了，就算硬把畫面關掉也是一片空白。
 *
 * 為什麼不用 ChangePasswordDialog 那條路（supabase.auth.updateUser）：
 * 那條路改完密碼之後，還得有人把 must_change_password 關掉。若由前端關，
 * 一行 console 指令就能跳過強制更換——而這功能防的正是「別人拿你的工號登入」。
 * 所以改密碼與解鎖必須在伺服器端同一支函式裡完成，見 admin-users 的 change_own_password。
 *
 * 也因為是 service_role 改的密碼，本人的 session **不會**被撤銷，
 * 改完直接 reloadProfile() 就能繼續用，不必重新登入。
 */
export default function ForcePasswordPage() {
  const { profile, reloadProfile, signOut } = useAuth()
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    if (pw1.length < 6) return setError('密碼至少 6 碼')
    if (pw1 !== pw2) return setError('兩次輸入的新密碼不一致')
    setBusy(true)
    setError(null)
    try {
      await callAdmin('change_own_password', { password: pw1 })
      await reloadProfile()
      // reloadProfile 之後 mustChangePassword 變 false，Guard 就會放行到原本的頁面
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg === SESSION_EXPIRED ? '登入已過期，請重新登入後再設定密碼。' : msg)
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-4">
      <div className="card">
        <h1 className="card-title">請設定新密碼</h1>
        <p className="mb-3 text-sm text-ink-700">
          {profile?.full_name ? `${profile.full_name}，您好。` : ''}
          您目前用的是主管配發的初始密碼。工號在院內不是秘密，
          <b>知道您工號的人就能登入這個帳號</b>，所以請先換成只有您知道的密碼。
        </p>
        <p className="mb-4 text-sm text-warn">設定完成前，系統不會顯示任何報價資料。</p>

        <form onSubmit={(e) => void submit(e)} className="space-y-3">
          <div>
            <label className="label" htmlFor="np1">新密碼（至少 6 碼，不可與工號相同）</label>
            <input
              id="np1" className="field" type="password" autoComplete="new-password"
              value={pw1} disabled={busy}
              onChange={(e) => { setPw1(e.target.value); setError(null) }}
            />
          </div>
          <div>
            <label className="label" htmlFor="np2">再輸入一次</label>
            <input
              id="np2" className="field" type="password" autoComplete="new-password"
              value={pw2} disabled={busy}
              onChange={(e) => { setPw2(e.target.value); setError(null) }}
            />
          </div>
          {error && (
            <div className="rounded-md border border-warn/30 bg-warn-bg px-3 py-2 text-sm break-words text-warn">
              {error}
            </div>
          )}
          <button type="submit" className="btn btn-primary w-full" disabled={busy}>
            {busy ? '設定中…' : '設定新密碼並開始使用'}
          </button>
        </form>

        <button
          type="button" className="btn mt-3 w-full" disabled={busy}
          onClick={() => void signOut()}
        >
          先登出
        </button>
      </div>
    </div>
  )
}
