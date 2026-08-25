import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useRefData } from '../context/RefDataContext'

const link = ({ isActive }: { isActive: boolean }) =>
  'rounded px-3 py-1.5 text-sm transition ' +
  (isActive ? 'bg-white/20 text-white' : 'text-white/80 hover:bg-white/10 hover:text-white')

export default function Layout() {
  const { profile, isManager, isProcurement, signOut } = useAuth()
  const { settings, error } = useRefData()
  const version = String(settings.catalog_version ?? '')

  return (
    <>
      <header className="no-print sticky top-0 z-20 flex flex-wrap items-center gap-3 bg-deep px-5 py-2.5 text-white">
        <h1 className="text-[17px] font-semibold tracking-wide">
          德新物業(立德新)專案工程報價系統
        </h1>
        {version && <span className="text-xs text-white/70">單價庫 {version}</span>}

        <nav className="ml-4 flex flex-wrap gap-1">
          {/* 醫院採購是對方的人：只給議價入口，其餘一概不顯示 */}
          {isProcurement ? (
            <NavLink to="/client" className={link}>報價議價</NavLink>
          ) : (
            <>
              <NavLink to="/" end className={link}>報價單</NavLink>
              <NavLink to="/quote/new" className={link}>開新單</NavLink>
            </>
          )}
          {isManager && <NavLink to="/catalog" className={link}>單價維護</NavLink>}
          {isManager && <NavLink to="/indices" className={link}>物價指數</NavLink>}
          {isManager && <NavLink to="/users" className={link}>人員權限</NavLink>}
        </nav>

        <div className="ml-auto flex items-center gap-3 text-sm">
          <span className="text-white/85">
            {profile?.full_name || '—'}
            <span className="ml-1.5 rounded-full bg-white/20 px-2 py-0.5 text-[11px]">
              {isManager ? '主管' : isProcurement ? '醫院採購' : '同仁'}
            </span>
          </span>
          <button onClick={() => void signOut()} className="btn border-white/35 bg-white/15 text-white hover:border-white hover:text-white">
            登出
          </button>
        </div>
      </header>

      {error && (
        <div className="no-print border-b border-warn/30 bg-warn-bg px-5 py-2 text-sm text-warn">
          資料載入失敗：{error}
        </div>
      )}

      <main className="mx-auto max-w-[1280px] px-5 py-4 pb-16">
        <Outlet />
      </main>
    </>
  )
}
