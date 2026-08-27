import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { toEmployeeNo, useAuth } from '../context/AuthContext'
import type { Role } from '../types'

interface AccountRow {
  id: string
  email: string
  full_name: string
  role: Role
  active: boolean
  created_at: string
  last_sign_in_at: string | null
}

/**
 * session 失效的哨兵訊息。
 * 最常見的觸發情境是「主管改了自己的密碼」——Supabase 會撤銷該使用者既有的 session，
 * 於是下一次呼叫就 401。原本直接把 Edge Function 的「登入憑證無效或已過期」丟到畫面上，
 * 使用者只會覺得系統壞了，根本不知道要重新登入。
 */
const SESSION_EXPIRED = 'SESSION_EXPIRED'

/** 呼叫 admin-users Edge Function（service_role 只存在於伺服器端，前端拿不到） */
async function callAdmin<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
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

const fmtDate = (s: string | null) => (s ? s.slice(0, 10) : '—')

export default function UsersPage() {
  const { profile, isAdmin, signOut } = useAuth()
  /**
   * 工務處長只能管「同仁」。收在 staff 是為了擋提權——處長若建得出 manager，
   * 就能把自己升成副部長並取得議價定案與刪單權。
   * 這裡只是不要顯示按不動的按鈕；真正的把關在資料庫政策 profiles_dept_head_staff
   * 與 Edge Function admin-users，前端拿掉也擋得住。
   */
  const mayTouch = (r: AccountRow) => isAdmin || val(r, 'role') === 'staff'
  /** 改完自己的密碼後的過場：顯示提示並自動登出，不要讓人卡在看不懂的 401 */
  const [selfPwDone, setSelfPwDone] = useState(false)
  const [expired, setExpired] = useState(false)
  const [rows, setRows] = useState<AccountRow[]>([])
  const [draft, setDraft] = useState<Record<string, Partial<AccountRow>>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)

  // 新增帳號表單
  const [showNew, setShowNew] = useState(false)
  const [nf, setNf] = useState({ email: '', password: '', full_name: '', role: 'staff' as Role })

  // 重設密碼 / 刪除確認
  const [pwFor, setPwFor] = useState<AccountRow | null>(null)
  const [newPw, setNewPw] = useState('')
  const [delFor, setDelFor] = useState<AccountRow | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const { users } = await callAdmin<{ users: AccountRow[] }>('list')
      setRows(users.sort((a, b) => a.created_at.localeCompare(b.created_at)))
      setDraft({})
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  const flash = (msg: string) => { setOk(msg); setError(null); setTimeout(() => setOk(null), 4000) }
  const fail = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e)
    setOk(null)
    if (msg === SESSION_EXPIRED) { setExpired(true); setError(null); return }
    setError(msg)
  }

  const val = <K extends keyof AccountRow>(r: AccountRow, k: K): AccountRow[K] =>
    (draft[r.id]?.[k] ?? r[k]) as AccountRow[K]
  const edit = (id: string, patch: Partial<AccountRow>) =>
    setDraft((d) => ({ ...d, [id]: { ...d[id], ...patch } }))

  const dirtyIds = Object.keys(draft).filter((id) => {
    const r = rows.find((x) => x.id === id); if (!r) return false
    const p = draft[id]
    return (p.full_name !== undefined && p.full_name !== r.full_name)
      || (p.role !== undefined && p.role !== r.role)
      || (p.active !== undefined && p.active !== r.active)
  })

  async function saveProfiles() {
    setBusy('save'); setError(null)
    try {
      for (const id of dirtyIds) {
        const r = rows.find((x) => x.id === id)!
        const { error } = await supabase.from('profiles').update({
          full_name: val(r, 'full_name'), role: val(r, 'role'), active: val(r, 'active'),
        }).eq('id', id)
        if (error) throw error
      }
      flash(`已儲存 ${dirtyIds.length} 筆`)
      await load()
    } catch (e) { fail(e) }
    setBusy('')
  }

  async function createUser() {
    setBusy('create')
    try {
      await callAdmin('create', nf)
      flash(`已建立帳號 ${nf.email}`)
      setShowNew(false); setNf({ email: '', password: '', full_name: '', role: 'staff' })
      await load()
    } catch (e) { fail(e) }
    setBusy('')
  }

  async function resetPw() {
    if (!pwFor) return
    const isSelf = pwFor.id === profile?.id
    setBusy('pw')
    try {
      await callAdmin('reset_password', { id: pwFor.id, password: newPw })
      setPwFor(null); setNewPw('')
      if (isSelf) {
        // Supabase 在密碼變更時會撤銷這個使用者既有的 session，
        // 繼續留在頁面上只會在下一次操作時撞 401。直接帶去重新登入。
        setSelfPwDone(true)
        setTimeout(() => { void signOut() }, 2500)
        return
      }
      flash(`已重設 ${toEmployeeNo(pwFor.email)} 的密碼，請告知本人並提醒他登入後自行更改`)
    } catch (e) { fail(e) }
    setBusy('')
  }

  async function removeUser() {
    if (!delFor) return
    setBusy('del')
    try {
      await callAdmin('delete', { id: delFor.id })
      flash(`已刪除帳號 ${toEmployeeNo(delFor.email)}`)
      setDelFor(null)
      await load()
    } catch (e) { fail(e) }
    setBusy('')
  }

  const isSelf = (r: AccountRow) => r.id === profile?.id

  // 改完自己的密碼：不要讓人留在頁面上等著撞 401
  if (selfPwDone) {
    return (
      <div className="mx-auto mt-16 max-w-md text-center">
        <div className="card">
          <h2 className="card-title justify-center text-center">密碼已更新</h2>
          <p className="text-ink-700">
            你剛更改了自己的密碼，基於安全考量目前的登入狀態已失效。
          </p>
          <p className="mt-2 text-ink-500">正在登出，請用<b className="text-deep">新密碼</b>重新登入…</p>
          <button className="btn btn-primary mt-4" onClick={() => void signOut()}>立即前往登入</button>
        </div>
      </div>
    )
  }

  // session 失效（最常見是密碼剛被改過）：講人話並給一個出口
  if (expired) {
    return (
      <div className="mx-auto mt-16 max-w-md text-center">
        <div className="card border-alert/40">
          <h2 className="card-title justify-center text-center text-alert">登入狀態已失效</h2>
          <p className="text-ink-700">
            這通常發生在密碼剛被更改過，或是離開太久。請重新登入後再操作。
          </p>
          <button className="btn btn-primary mt-4" onClick={() => void signOut()}>重新登入</button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="card">
        <h2 className="card-title">帳號管理</h2>
        <p className="text-ink-500">
          在這裡直接建立、停用帳號與重設密碼，不需要進 Supabase 後台。輸入 6 碼工號即可建帳號，
          初始密碼欄留空會自動帶入工號。
          {isAdmin
            ? '刪除帳號僅副部長可用；名下還有報價單的帳號會被擋下，請改為停用。'
            : '您是工務處長：可建立、停用、重設密碼，但範圍限「同仁」；其他角色與刪除帳號請洽行政管理部副部長。'}
        </p>
        {/* 角色說明表：兩欄敘述型表格，手機保留原本上下對照的排版，只做橫捲保險 */}
        <div className="mt-3 table-scroll">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th text-left">角色</th>
                <th className="th text-left">可以做什麼</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="td whitespace-nowrap font-semibold">同仁</td>
                <td className="td">
                  開單、選標準品項填數量、送主管核可、列印報價單。
                  <span className="text-warn">看不到底價，不能改標準單價。</span>
                  非標準品要走「臨時項目」並填理由。
                </td>
              </tr>
              <tr>
                <td className="td whitespace-nowrap font-semibold">主管</td>
                <td className="td">
                  同仁全部功能 ＋ 維護標準單價與底價 ＋ 物價指數與工資係數 ＋ 議價回應 ＋ 核可／退回 ＋ 帳號管理。
                </td>
              </tr>
              <tr>
                <td className="td whitespace-nowrap font-semibold text-alert">醫院採購</td>
                <td className="td">
                  <span className="text-alert">這是對方（聯新國際醫院採購單位）的帳號，不是自家人。</span>
                  只看得到已核可送出的報價單與自己提的議價，
                  <b>看不到單價庫、底價、成本、佐證與報價專用章</b>。
                  可逐項提出建議單價，但不能修改單據、也不能定案。
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {error && <div className="rounded-md border border-warn/30 bg-warn-bg px-3 py-2 text-warn break-words">{error}</div>}
      {ok && <div className="rounded-md border border-green/30 bg-green/10 px-3 py-2 text-green break-words">{ok}</div>}

      <div className="card">
        <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-ink-200 pb-2">
          <h2 className="text-[0.9375rem] font-semibold text-deep">帳號清單</h2>
          <span className="tag">{rows.length} 個帳號</span>
          {/* 手機：兩顆按鈕自成一列並等寬撐開，避免被擠成迷你按鈕 */}
          <div className="ml-auto flex w-full gap-2 sm:w-auto">
            <button className="btn flex-1 sm:flex-none" onClick={() => setShowNew((v) => !v)}>
              {showNew ? '取消新增' : '＋ 新增帳號'}
            </button>
            <button className="btn btn-primary flex-1 sm:flex-none" disabled={!dirtyIds.length || busy === 'save'}
              onClick={() => void saveProfiles()}>
              {busy === 'save' ? '儲存中…' : dirtyIds.length ? `儲存 ${dirtyIds.length} 筆變更` : '儲存變更'}
            </button>
          </div>
        </div>

        {showNew && (
          <div className="mb-4 rounded-md border border-bright/40 bg-light/40 p-3">
            {/* 手機單欄 → 平板雙欄 → 桌機四欄（mobile-first，手機不再被塞成 4 欄） */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4">
              <div>
                <label className="label">工號（登入帳號·6 碼數字）</label>
                <input className="field" value={nf.email} autoComplete="off"
                  inputMode="numeric" maxLength={6}
                  onChange={(e) => setNf({ ...nf, email: e.target.value })} placeholder="016123" />
              </div>
              <div>
                <label className="label">姓名</label>
                <input className="field" value={nf.full_name}
                  onChange={(e) => setNf({ ...nf, full_name: e.target.value })} placeholder="王小明" />
              </div>
              <div>
                <label className="label">初始密碼（留空＝與工號相同）</label>
                <input className="field" value={nf.password} autoComplete="new-password"
                  onChange={(e) => setNf({ ...nf, password: e.target.value })} placeholder="留空即帶入工號" />
              </div>
              <div>
                <label className="label">角色</label>
                <select className="field" value={nf.role} disabled={!isAdmin}
                  title={isAdmin ? '' : '工務處長只能建立「同仁」帳號'}
                  onChange={(e) => setNf({ ...nf, role: e.target.value as Role })}>
                  <option value="staff">同仁</option>
                  {isAdmin && <option value="dept_head">工務處長（簽核第一關）</option>}
                  {isAdmin && <option value="manager">行政管理部副部長（最終核決）</option>}
                  {isAdmin && <option value="procurement">醫院採購（對方）</option>}
                </select>
              </div>
            </div>
            <div className="mt-3 flex flex-col items-start gap-2 sm:flex-row sm:items-center">
              <button className="btn btn-primary w-full sm:w-auto" disabled={busy === 'create'} onClick={() => void createUser()}>
                {busy === 'create' ? '建立中…' : '建立帳號'}
              </button>
              <span className="text-xs text-ink-500">
                帳號建立後即可使用。初始密碼預設與工號相同，請提醒本人登入後從右上角「改密碼」自行更改。
              </span>
            </div>
          </div>
        )}

        {loading ? (
          <div className="py-8 text-center text-ink-500">載入中…</div>
        ) : (
          /* 手機（<640px）每一列變成一張卡片，欄位名由 td 的 data-label 長出來 */
          <div className="table-scroll">
            <table className="w-full rwd-table">
              <thead>
                <tr>
                  <th className="th text-left">工號</th>
                  <th className="th text-left">姓名</th>
                  <th className="th">角色</th>
                  <th className="th">啟用</th>
                  <th className="th">建立日</th>
                  <th className="th">最後登入</th>
                  <th className="th">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={val(r, 'active') ? '' : 'opacity-50'}>
                    <td className="td" data-label="工號">
                      <span className="break-words">
                        {toEmployeeNo(r.email)}
                        {isSelf(r) && <span className="tag ml-1.5">你自己</span>}
                      </span>
                    </td>
                    <td className="td p-1" data-label="姓名">
                      <input className="field" value={val(r, 'full_name')}
                        onChange={(e) => edit(r.id, { full_name: e.target.value })} />
                    </td>
                    <td className="td p-1" data-label="角色">
                      <select className="field" value={val(r, 'role')}
                        disabled={isSelf(r) || !isAdmin}
                        title={isSelf(r) ? '不能改自己的角色，避免把自己鎖在門外'
                          : !isAdmin ? '變更角色限行政管理部副部長' : ''}
                        onChange={(e) => edit(r.id, { role: e.target.value as Role })}>
                        <option value="staff">同仁</option>
                        <option value="dept_head">工務處長</option>
                        <option value="manager">行政管理部副部長</option>
                        <option value="procurement">醫院採購（對方）</option>
                      </select>
                    </td>
                    <td className="td text-center" data-label="啟用">
                      <input type="checkbox" checked={val(r, 'active')}
                        disabled={isSelf(r) || !mayTouch(r)}
                        title={isSelf(r) ? '不能停用自己'
                          : !mayTouch(r) ? '工務處長只能停用「同仁」' : ''}
                        onChange={(e) => edit(r.id, { active: e.target.checked })} />
                    </td>
                    <td className="td num" data-label="建立日">{fmtDate(r.created_at)}</td>
                    <td className="td num" data-label="最後登入">{fmtDate(r.last_sign_in_at)}</td>
                    {/* 操作格不給 data-label：手機卡片模式下會獨佔整行，兩顆按鈕等寬好按 */}
                    <td className="td whitespace-nowrap">
                      <div className="flex w-full gap-1">
                        <button className="btn flex-1 px-2 py-0.5 text-xs sm:flex-none"
                          disabled={!mayTouch(r)}
                          title={mayTouch(r) ? '' : '工務處長只能重設「同仁」的密碼'}
                          onClick={() => { setPwFor(r); setNewPw('') }}>
                          重設密碼
                        </button>
                        {/* 刪除不可逆，只留副部長；處長請改用「停用」 */}
                        {isAdmin && (
                          <button className="btn btn-danger flex-1 px-2 py-0.5 text-xs sm:flex-none" disabled={isSelf(r)}
                            title={isSelf(r) ? '不能刪除自己' : ''} onClick={() => setDelFor(r)}>
                            刪除
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-3 text-xs text-ink-500">
          離職人員建議用「停用」而不是「刪除」——刪除會讓他開過的報價單失去建立人紀錄，
          系統會擋下這種刪除並提示你改用停用。
        </p>
      </div>

      {pwFor && (
        <div className="card border-bright/40">
          <h2 className="card-title break-words">重設密碼：{toEmployeeNo(pwFor.email)}</h2>
          {pwFor.id === profile?.id ? (
            <p className="mb-3 rounded-md border border-alert/40 bg-alert/10 px-3 py-2 text-[0.8125rem] text-alert">
              這是<b>你自己的帳號</b>。改完之後目前的登入狀態會立即失效，
              系統會自動登出，需要用新密碼重新登入——請先確認新密碼記得住。
            </p>
          ) : (
            <p className="mb-3 text-[0.8125rem] text-ink-500">
              改完之後對方目前的登入狀態會失效，需重新登入。請以其他管道告知新密碼。
            </p>
          )}
          {/* 手機：輸入框整行、按鈕自成一列等寬；sm 以上恢復原本的橫排 */}
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
            <div className="w-full sm:w-auto sm:min-w-[240px]">
              <label className="label">新密碼（至少 6 碼·建議帶回工號）</label>
              <input className="field" value={newPw} autoComplete="new-password"
                onChange={(e) => setNewPw(e.target.value)} />
            </div>
            <div className="flex gap-2">
              <button className="btn btn-primary flex-1 sm:flex-none" disabled={newPw.length < 8 || busy === 'pw'}
                onClick={() => void resetPw()}>
                {busy === 'pw' ? '處理中…' : '確認重設'}
              </button>
              <button className="btn flex-1 sm:flex-none" onClick={() => { setPwFor(null); setNewPw('') }}>取消</button>
            </div>
          </div>
        </div>
      )}

      {delFor && (
        <div className="card border-warn/40 bg-warn-bg">
          <h2 className="card-title text-warn">確認刪除帳號</h2>
          <p className="mb-3 break-words">
            即將永久刪除 <b>{toEmployeeNo(delFor.email)}</b>（{delFor.full_name || '未命名'}）。此動作無法復原。
            若此人只是離職、資料還要留存，請改用「停用」。
          </p>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-danger flex-1 sm:flex-none" disabled={busy === 'del'} onClick={() => void removeUser()}>
              {busy === 'del' ? '刪除中…' : '確認刪除'}
            </button>
            <button className="btn flex-1 sm:flex-none" onClick={() => setDelFor(null)}>取消</button>
          </div>
        </div>
      )}
    </div>
  )
}
