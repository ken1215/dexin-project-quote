import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import type { Profile, Role } from '../types'

/** profiles 資料表比共用 Profile 型別多一個建立時間欄位，僅在本頁使用，不動 types.ts */
interface ProfileRow extends Profile {
  created_at: string
}

const ROLE_LABEL: Record<Role, string> = { staff: '同仁', manager: '主管' }

function formatDate(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function UsersPage() {
  const { profile: me } = useAuth()
  const [rows, setRows] = useState<ProfileRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const original = useRef<Map<string, ProfileRow>>(new Map())

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setNotice(null)
    const { data, error: err } = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: true })
    if (err) {
      setError(err.message)
      setLoading(false)
      return
    }
    const list = (data ?? []) as ProfileRow[]
    setRows(list)
    original.current = new Map(list.map((r) => [r.id, r]))
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  function patchRow(id: string, patch: Partial<Pick<ProfileRow, 'full_name' | 'role' | 'active'>>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  function isDirty(row: ProfileRow): boolean {
    const orig = original.current.get(row.id)
    if (!orig) return false
    return orig.full_name !== row.full_name || orig.role !== row.role || orig.active !== row.active
  }

  const dirtyRows = rows.filter(isDirty)

  async function handleSave() {
    if (dirtyRows.length === 0) return
    setSaving(true)
    setError(null)
    setNotice(null)
    const results = await Promise.all(
      dirtyRows.map((r) =>
        supabase
          .from('profiles')
          .update({ full_name: r.full_name, role: r.role, active: r.active })
          .eq('id', r.id),
      ),
    )
    const failed = results.find((r) => r.error)
    if (failed?.error) {
      setError(failed.error.message)
      setSaving(false)
      return
    }
    setSaving(false)
    setNotice(`已儲存 ${dirtyRows.length} 筆異動。`)
    await load()
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="card">
        <div className="card-title">人員權限</div>
        <p className="text-sm text-ink-700">
          新帳號請由主管在 Supabase Dashboard → Authentication → Users → Add user 建立（或請同仁自行註冊）。
          建立後預設為「同仁」，需在本頁改成「主管」才有維護單價的權限。
        </p>
      </div>

      <div className="card overflow-x-auto">
        <div className="card-title">帳號清單</div>

        {loading && <p className="text-sm text-ink-500">載入中…</p>}
        {error && <p className="mb-3 text-sm text-warn">錯誤：{error}</p>}
        {notice && <p className="mb-3 text-sm text-green">{notice}</p>}

        {!loading && (
          <>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className="th text-left">姓名</th>
                  <th className="th text-left">角色</th>
                  <th className="th text-left">啟用</th>
                  <th className="th text-left">建立時間</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const isSelf = row.id === me?.id
                  return (
                    <tr key={row.id} className={isDirty(row) ? 'bg-light/40' : undefined}>
                      <td className="td">
                        <input
                          className="field"
                          value={row.full_name}
                          onChange={(e) => patchRow(row.id, { full_name: e.target.value })}
                        />
                      </td>
                      <td className="td">
                        <select
                          className="field"
                          value={row.role}
                          disabled={isSelf}
                          title={isSelf ? '不能將自己的帳號降級，請請其他主管操作' : undefined}
                          onChange={(e) => patchRow(row.id, { role: e.target.value as Role })}
                        >
                          <option value="staff">{ROLE_LABEL.staff}</option>
                          <option value="manager">{ROLE_LABEL.manager}</option>
                        </select>
                      </td>
                      <td className="td">
                        <input
                          type="checkbox"
                          checked={row.active}
                          disabled={isSelf}
                          title={isSelf ? '不能停用自己的帳號，以免被鎖在系統外' : undefined}
                          onChange={(e) => patchRow(row.id, { active: e.target.checked })}
                        />
                      </td>
                      <td className="td">{formatDate(row.created_at)}</td>
                    </tr>
                  )
                })}
                {rows.length === 0 && (
                  <tr>
                    <td className="td text-center text-ink-500" colSpan={4}>目前沒有帳號資料。</td>
                  </tr>
                )}
              </tbody>
            </table>

            <div className="mt-4 flex items-center gap-3">
              <button
                className="btn btn-primary"
                disabled={dirtyRows.length === 0 || saving}
                onClick={() => void handleSave()}
              >
                {saving ? '儲存中…' : `儲存${dirtyRows.length > 0 ? `（${dirtyRows.length} 筆異動）` : ''}`}
              </button>
              <button className="btn" disabled={saving} onClick={() => void load()}>重新整理</button>
            </div>
          </>
        )}
      </div>

      <div className="card overflow-x-auto">
        <div className="card-title">角色差異對照表</div>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="th text-left">角色</th>
              <th className="th text-left">可執行功能</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="td font-medium text-ink-900">同仁</td>
              <td className="td">開單、選標準品項填數量、送審、列印；看不到底價、不能改單價。</td>
            </tr>
            <tr>
              <td className="td font-medium text-ink-900">主管</td>
              <td className="td">全部同仁功能＋維護標準單價與底價、物價指數、議價回應、核可退回、人員權限。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
