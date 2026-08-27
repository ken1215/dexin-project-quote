import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useRefData } from '../context/RefDataContext'
import ChangePasswordDialog from './ChangePasswordDialog'
import { ROLE_LABEL } from '../types'

const link = ({ isActive }: { isActive: boolean }) =>
  'rounded px-3 py-2 text-sm transition ' +
  (isActive ? 'bg-white/20 text-white' : 'text-white/80 hover:bg-white/10 hover:text-white')

export default function Layout() {
  const { profile, isManager, isProcurement, signOut } = useAuth()
  const { settings, error } = useRefData()
  const version = String(settings.catalog_version ?? '')
  const [pwOpen, setPwOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const { pathname } = useLocation()

  // 手機選單點完就收——不然換頁後選單還蓋在畫面上
  useEffect(() => { setMenuOpen(false) }, [pathname])

  const nav = (
    <>
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
      {/* 帳號管理：副部長管全部，處長只管得動同仁（把關在 RLS 與 Edge Function） */}
      {isManager && <NavLink to="/users" className={link}>人員權限</NavLink>}
    </>
  )

  const account = (
    <>
      <span className="text-white/85">
        {profile?.full_name || '—'}
        <span className="ml-1.5 rounded-full bg-white/20 px-2 py-0.5 text-[0.6875rem]">
          {ROLE_LABEL[profile?.role ?? 'staff']}
        </span>
      </span>
      {/* 醫院採購是對方的人，帳號由我方發，不給自助改密碼 */}
      {!isProcurement && (
        <button onClick={() => setPwOpen(true)} className="btn border-white/35 bg-white/15 text-white hover:border-white hover:text-white">
          改密碼
        </button>
      )}
      <button onClick={() => void signOut()} className="btn border-white/35 bg-white/15 text-white hover:border-white hover:text-white">
        登出
      </button>
    </>
  )

  return (
    <>
      <header className="no-print sticky top-0 z-20 bg-deep text-white">
        <div className="flex items-center gap-3 px-3 py-2 sm:px-5 sm:py-2.5">
          <h1 className="truncate text-[0.9375rem] font-semibold tracking-wide sm:text-[1.0625rem]">
            {/* 手機沒有橫向空間放全名，留下認得出來的短名 */}
            <span className="sm:hidden">德新報價系統</span>
            <span className="hidden sm:inline">德新物業(立德新)專案工程報價系統</span>
          </h1>
          {/* 單價庫版本是我方內部的標籤，醫院採購沒必要看到 */}
          {version && !isProcurement && (
            <span className="hidden text-xs text-white/70 lg:inline">單價庫 {version}</span>
          )}

          <nav className="ml-2 hidden flex-wrap gap-1 lg:flex">{nav}</nav>
          <div className="ml-auto hidden items-center gap-3 text-sm lg:flex">{account}</div>

          {/* 手機／平板：收進漢堡選單。aria-expanded 讓螢幕報讀器知道開合狀態 */}
          <button
            type="button"
            className="btn ml-auto border-white/35 bg-white/15 text-white lg:hidden"
            aria-expanded={menuOpen}
            aria-controls="main-nav"
            onClick={() => setMenuOpen((v) => !v)}
          >
            {menuOpen ? '✕ 關閉' : '☰ 選單'}
          </button>
        </div>

        {menuOpen && (
          <div id="main-nav" className="border-t border-white/20 px-3 pb-3 lg:hidden">
            <nav className="flex flex-col py-1">{nav}</nav>
            <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-white/20 pt-2 text-sm">
              {account}
            </div>
          </div>
        )}
      </header>

      {pwOpen && <ChangePasswordDialog onClose={() => setPwOpen(false)} />}

      {error && (
        <div className="no-print border-b border-warn/30 bg-warn-bg px-3 py-2 text-sm text-warn sm:px-5">
          資料載入失敗：{error}
        </div>
      )}

      <main className="mx-auto max-w-[1280px] px-3 py-3 pb-16 sm:px-5 sm:py-4">
        <Outlet />
      </main>
    </>
  )
}
