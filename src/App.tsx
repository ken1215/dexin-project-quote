import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { RefDataProvider } from './context/RefDataContext'
import Layout from './components/Layout'
import LoginPage from './pages/LoginPage'
import QuoteListPage from './pages/QuoteListPage'
import QuoteEditorPage from './pages/quote/QuoteEditorPage'
import PriceCatalogPage from './pages/PriceCatalogPage'
import IndicesPage from './pages/IndicesPage'
import NegotiationPage from './pages/NegotiationPage'
import PrintPage from './pages/PrintPage'
import UsersPage from './pages/UsersPage'
import ForcePasswordPage from './pages/ForcePasswordPage'

/**
 * 未登入導去登入頁；managerOnly 擋非核決層（處長與副部長皆可）；
 * adminOnly 只剩行政管理部（部長可進議價頁唯讀檢視，減價／定案由頁內 isViceDirector
 * 與資料庫 RPC 把關）。真正的把關一律在資料庫 RLS／trigger，這裡只是不要讓人看到一片空白。
 * （醫院採購角色 2026-10-06 下線，原本的 internalOnly 與 /client 導向已移除。）
 */
function Guard(
  { children, managerOnly = false, adminOnly = false }:
  {
    children: React.ReactNode
    managerOnly?: boolean; adminOnly?: boolean
  },
) {
  const { session, profile, loading, isManager, isAdmin, mustChangePassword } = useAuth()
  if (loading) return <div className="p-10 text-center text-ink-500">載入中…</div>
  if (!session) return <Navigate to="/login" replace />
  if (profile && !profile.active) {
    return <div className="p-10 text-center text-warn">此帳號已停用，請洽工務處主管。</div>
  }
  // 初始密碼還沒換掉：擋在這裡，連 Layout 都不要進去。
  // 這只是畫面上的門；真正的鎖在 db/23——旗標解除前所有身分判斷函式都回 false，
  // 直接打 API 一樣讀不到任何業務資料。
  if (mustChangePassword) return <ForcePasswordPage />
  if (adminOnly && !isAdmin) {
    return <div className="p-10 text-center text-warn">此功能限行政管理部（部長／副部長）使用。</div>
  }
  if (managerOnly && !isManager) {
    return <div className="p-10 text-center text-warn">此功能限主管使用。</div>
  }
  return <>{children}</>
}

export default function App() {
  return (
    <HashRouter>
      <AuthProvider>
        <RefDataProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/print/:id" element={<Guard><PrintPage /></Guard>} />
            <Route element={<Guard><Layout /></Guard>}>
              <Route index element={<Guard><QuoteListPage /></Guard>} />
              <Route path="quote/new" element={<Guard><QuoteEditorPage /></Guard>} />
              <Route path="quote/:id" element={<Guard><QuoteEditorPage /></Guard>} />
              <Route path="catalog" element={<Guard managerOnly><PriceCatalogPage /></Guard>} />
              <Route path="indices" element={<Guard managerOnly><IndicesPage /></Guard>} />
              {/* 處長也進得來，但他只動得了同仁——把關在 RLS 與 Edge Function，不在這裡 */}
              <Route path="users" element={<Guard managerOnly><UsersPage /></Guard>} />
              {/* 副部長可減價定案，部長只能看（頁內 isViceDirector 決定，資料庫 RPC 才是鎖） */}
              <Route path="nego/:id" element={<Guard adminOnly><NegotiationPage /></Guard>} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </RefDataProvider>
      </AuthProvider>
    </HashRouter>
  )
}
