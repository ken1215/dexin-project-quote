import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'

/**
 * 自行更改密碼。不走 Edge Function——改自己的密碼不需要 service_role。
 *
 * 注意：Supabase 改完密碼會撤銷本人的 session，之後每一支 API 都回 401 而且
 * 訊息看不懂。所以成功之後直接登出、請他用新密碼重新登入，不要留在原畫面。
 *
 * 用原生 <dialog>：焦點鎖定、Esc 關閉、背景遮罩都是瀏覽器內建的，不用自己寫。
 */
export default function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const { changePassword, signOut } = useAuth()
  const ref = useRef<HTMLDialogElement>(null)
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { ref.current?.showModal() }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    if (pw1.length < 6) return setError('密碼至少 6 碼')
    if (pw1 !== pw2) return setError('兩次輸入的新密碼不一致')
    setBusy(true)
    setError(null)
    const msg = await changePassword(pw1)
    if (msg) { setError(msg); setBusy(false); return }
    // 這裡不 setBusy(false)：session 已失效，畫面要整個離開
    await signOut()
    alert('密碼已更改，請用新密碼重新登入。')
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="w-[min(24rem,calc(100vw-2rem))] rounded-lg border border-ink-200 p-0
                 backdrop:bg-ink-900/40"
    >
      <form onSubmit={submit} className="p-5">
        <h2 className="mb-1 text-[0.9375rem] font-semibold text-deep">更改密碼</h2>
        <p className="mb-4 text-xs text-ink-500">
          更改後本次登入會失效，需用新密碼重新登入。
        </p>

        <div className="mb-3">
          <label className="label" htmlFor="pw1">新密碼（至少 6 碼）</label>
          <input
            id="pw1" type="password" className="field" value={pw1}
            onChange={(e) => setPw1(e.target.value)}
            autoComplete="new-password" required minLength={6}
          />
        </div>
        <div className="mb-4">
          <label className="label" htmlFor="pw2">再輸入一次</label>
          <input
            id="pw2" type="password" className="field" value={pw2}
            onChange={(e) => setPw2(e.target.value)}
            autoComplete="new-password" required minLength={6}
          />
        </div>

        {error && <p className="mb-3 text-sm text-warn">{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={() => ref.current?.close()}>
            取消
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? '更改中…' : '確認更改'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
