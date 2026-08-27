import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { RefDataProvider } from './context/RefDataContext'
import Layout from './components/Layout'
import LoginPage from './pages/LoginPage'
import QuoteListPage from './pages/QuoteListPage'
import QuoteEditorPage from './pages/QuoteEditorPage'
import PriceCatalogPage from './pages/PriceCatalogPage'
import IndicesPage from './pages/IndicesPage'
import NegotiationPage from './pages/NegotiationPage'
import PrintPage from './pages/PrintPage'
import UsersPage from './pages/UsersPage'
import ClientNegotiationPage from './pages/ClientNegotiationPage'

/**
 * 未登入導去登入頁；managerOnly 擋非核決層（處長與副部長皆可）；
 * adminOnly 再收緊一階，只剩行政管理部副部長；internalOnly 擋醫院採購。
 * 醫院採購是對方的人，除了議價頁以外一律不得進入——真正的把關在資料庫 RLS，
 * 這裡只是不要讓他們看到一片空白的畫面而已。
 */
function Guard(
  { children, managerOnly = false, adminOnly = false, internalOnly = false }:
  {
    children: React.ReactNode
    managerOnly?: boolean; adminOnly?: boolean; internalOnly?: boolean
  },
) {
  const { session, profile, loading, isManager, isAdmin, isProcurement } = useAuth()
  if (loading) return <div className="p-10 text-center text-ink-500">載入中…</div>
  if (!session) return <Navigate to="/login" replace />
  if (profile && !profile.active) {
    return <div className="p-10 text-center text-warn">此帳號已停用，請洽工務處主管。</div>
  }
  // 採購登入後預設落到議價頁，不要讓他們卡在讀不到資料的畫面
  if (internalOnly && isProcurement) return <Navigate to="/client" replace />
  if (adminOnly && !isAdmin) {
    return <div className="p-10 text-center text-warn">此功能限行政管理部副部長使用。</div>
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
              <Route index element={<Guard internalOnly><QuoteListPage /></Guard>} />
              <Route path="quote/new" element={<Guard internalOnly><QuoteEditorPage /></Guard>} />
              <Route path="quote/:id" element={<Guard internalOnly><QuoteEditorPage /></Guard>} />
              <Route path="catalog" element={<Guard managerOnly><PriceCatalogPage /></Guard>} />
              <Route path="indices" element={<Guard managerOnly><IndicesPage /></Guard>} />
              {/* 處長也進得來，但他只動得了同仁——把關在 RLS 與 Edge Function，不在這裡 */}
              <Route path="users" element={<Guard managerOnly><UsersPage /></Guard>} />
              <Route path="nego/:id" element={<Guard adminOnly><NegotiationPage /></Guard>} />
              {/* 醫院採購專用：只看得到已送出的單，只能登錄還價 */}
              <Route path="client" element={<ClientNegotiationPage />} />
              <Route path="client/:id" element={<ClientNegotiationPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </RefDataProvider>
      </AuthProvider>
    </HashRouter>
  )
}
