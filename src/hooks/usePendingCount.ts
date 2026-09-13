import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { pendingStatusesFor } from '../lib/quoteFilters'

/**
 * 「待我處理」張數。只要 count 不要資料，用 head:true 避免把整批單據拉下來。
 * RLS 擋下時 Supabase 不報錯只回 0——這裡回 0 是可接受的（徽章不顯示），
 * 但不可以拿它當「真的沒有單」的結論用在別處。
 *
 * 【偏離計畫 Task 4 Step 4，理由】計畫版在 effect 開頭用 `setN(0)` 處理
 * 「沒登入」與「這個角色沒有待辦」兩種情況。實測 oxlint 會對那一行報
 * react(set-state-in-effect)，基準 23 warnings 變 24——Global Constraints
 * 規定不得劣化，且衝突時以機器檢查為準。
 * 改法：把張數連同「它是為哪個身分查的」一起存，render 當下比對身分，
 * 不符就回 0。歸零不再需要 effect，行為與計畫版完全相同
 * （沒登入、角色沒有待辦、換人登入的空窗期，一律是 0）。
 * 這與 Task 6 useDraftAutosave 收斂到的寫法一致。
 */
export function usePendingCount(): number {
  const { profile, session } = useAuth()
  const role = profile?.role
  const uid = session?.user.id
  // 查詢範圍的識別字串：換人登入或換角色就換一個 scope，上一個身分查到的張數自動失效
  const scope = role && uid ? `${role}:${uid}` : ''
  const [hit, setHit] = useState<{ scope: string; n: number } | null>(null)

  useEffect(() => {
    if (!scope || !role || !uid) return
    const statuses = pendingStatusesFor(role)
    if (!statuses.length) return

    let cancelled = false
    void (async () => {
      let q = supabase.from('quotes')
        .select('id', { count: 'exact', head: true })
        .in('status', statuses)
      if (role === 'staff') q = q.eq('created_by', uid)
      const r = await q
      if (!cancelled) setHit({ scope, n: r.error ? 0 : (r.count ?? 0) })
    })()
    return () => { cancelled = true }
  }, [scope, role, uid])

  return hit?.scope === scope ? hit.n : 0
}
