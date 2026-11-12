import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useRefData } from '../context/RefDataContext'
import ChangePasswordDialog from './ChangePasswordDialog'
import BrandLockup from './ui/BrandLockup'
import BrandMark from './ui/BrandMark'
import { usePendingCount } from '../hooks/usePendingCount'
import { ROLE_LABEL } from '../types'

/** 桌機導覽：目前頁＝主藍 3px 底線＋深藍粗字（德新 CIS 的選單指示） */
const link = ({ isActive }: { isActive: boolean }) =>
  'whitespace-nowrap border-b-[3px] px-3 py-2 text-sm transition ' +
  (isActive ? 'border-bright font-bold text-deep' : 'border-transparent text-ink-700 hover:text-deep')

/** 手機選單是直排，指示線改畫在左側 */
const mobileLink = ({ isActive }: { isActive: boolean }) =>
  'border-l-[3px] px-3 py-2.5 text-sm transition ' +
  (isActive ? 'border-bright bg-light/40 font-bold text-deep' : 'border-transparent text-ink-700 hover:text-deep')

/** 頁首頂端的品牌色條：主藍 7 ： 新芽綠 2（純裝飾） */
function BrandBar() {
  return (
    <div aria-hidden="true" className="flex h-1">
      <span className="flex-[7] bg-bright" />
      <span className="flex-[2] bg-sprout" />
    </div>
  )
}

export default function Layout() {
  const { profile, isManager, signOut } = useAuth()
  const { settings, error } = useRefData()
  const version = String(settings.catalog_version ?? '')
  const [pwOpen, setPwOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const { pathname } = useLocation()
  const pending = usePendingCount()

  // 手機選單點完就收——不然換頁後選單還蓋在畫面上
  useEffect(() => { setMenuOpen(false) }, [pathname])

  const nav = (cls: typeof link) => (
    <>
      {/* 「開新單」是右側主 CTA，這裡只留清單入口＋待我處理徽章 */}
      <NavLink to="/" end className={cls}>
        報價單
        {pending > 0 && (
          <span className="num ml-1.5 rounded-full bg-sprout px-1.5 text-[0.6875rem] font-semibold text-ink-900">
            {pending}
          </span>
        )}
      </NavLink>
      {isManager && (
        <>
          <NavLink to="/catalog" className={cls}>單價維護</NavLink>
          <NavLink to="/indices" className={cls}>物價指數</NavLink>
          {/* 帳號管理：副部長管全部，處長只管得動同仁（把關在 RLS 與 Edge Function） */}
          <NavLink to="/users" className={cls}>人員權限</NavLink>
        </>
      )}
    </>
  )

  /** 姓名・角色＋改密碼／登出。主 CTA 不在這組裡——它在頁首列上永遠可見，手機也是，不會出現兩顆。 */
  const quiet = 'btn whitespace-nowrap border-transparent bg-transparent px-2 text-ink-500 hover:border-ink-200'
  const account = (
    <>
      <span className="whitespace-nowrap text-[0.8125rem] text-ink-500">
        {profile?.full_name || '—'}
        <span className="lg:hidden xl:inline">・{ROLE_LABEL[profile?.role ?? 'staff']}</span>
      </span>
      <button type="button" onClick={() => setPwOpen(true)} className={quiet}>改密碼</button>
      <button type="button" onClick={() => void signOut()} className={quiet}>登出</button>
    </>
  )

  return (
    // 欄式外框：內容少的頁面頁尾也貼在視窗底部
    <div className="flex min-h-dvh flex-col">
      {/* 2026-11-12 定案：頁首改白底＋德新橫式標誌組合，頂端 4px 品牌色條 */}
      <header className="no-print sticky top-0 z-20 border-b border-ink-200 bg-white">
        <BrandBar />
        <div className="mx-auto flex max-w-[1280px] items-center gap-2 px-3 py-2 sm:gap-4 sm:px-5 sm:py-2.5">
          <Link to="/" className="flex min-w-0 shrink-0 items-center gap-2 sm:gap-3 max-sm:shrink" aria-label="德新物業 工務報價系統 首頁">
            <span className="sm:hidden"><BrandLockup size="sm" /></span>
            <span className="hidden sm:inline-flex"><BrandLockup size="md" /></span>
            {/* 窄手機（<420px）放不下系統名，與其截成「工…」不如整段收起；標誌組合本身已足以辨識 */}
            <span aria-hidden="true" className="hidden h-6 w-px shrink-0 bg-ink-200 min-[420px]:block sm:h-7.5" />
            <span className="hidden min-w-0 truncate whitespace-nowrap text-[0.8125rem] min-[420px]:inline font-bold text-ink-900 sm:text-[0.9375rem]">
              工務報價系統
            </span>
          </Link>
          {version && (
            <span className="hidden whitespace-nowrap text-xs text-ink-500 2xl:inline">單價庫 {version}</span>
          )}

          <nav aria-label="主選單" className="ml-2 hidden gap-1 self-stretch lg:flex lg:items-end">
            {nav(link)}
          </nav>
          <div className="ml-auto hidden items-center gap-1 lg:flex">{account}</div>

          {/* 主要動作：整條頁首唯一的實心按鈕，桌機與手機都在同一個位置、只渲染一次 */}
          <Link to="/quote/new" className="btn btn-primary ml-auto shrink-0 lg:ml-0">＋ 開新單</Link>

          {/* 手機／平板：其餘導覽收進選單。aria-expanded 讓螢幕報讀器知道開合狀態 */}
          <button
            type="button"
            className="btn shrink-0 px-2.5 lg:hidden"
            aria-expanded={menuOpen}
            aria-controls="main-nav"
            aria-label={menuOpen ? '關閉選單' : '開啟選單'}
            onClick={() => setMenuOpen((v) => !v)}
          >
            {menuOpen ? '✕' : '☰'}
          </button>
        </div>

        {menuOpen && (
          <div id="main-nav" className="border-t border-ink-200 px-3 pb-3 lg:hidden">
            <nav aria-label="主選單" className="flex flex-col py-1">{nav(mobileLink)}</nav>
            <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-ink-200 pt-2">
              {account}
              {version && <span className="w-full text-xs text-ink-500">單價庫 {version}</span>}
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

      <main className="mx-auto w-full max-w-[1280px] flex-1 px-3 py-4 pb-16 sm:px-5 sm:py-6">
        <Outlet />
      </main>

      <footer className="no-print border-t border-ink-200 bg-white">
        <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-2 px-3 py-4 text-xs text-ink-500 sm:px-5">
          <span className="flex items-center gap-2">
            <BrandMark size={18} className="opacity-90" />
            立德新股份有限公司（德新物業）・工務處
          </span>
          <span className="font-brand tracking-[0.2em] text-bright">LANDSEED PROPERTY</span>
        </div>
      </footer>
    </div>
  )
}
