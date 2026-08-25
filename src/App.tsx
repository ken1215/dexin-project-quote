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

/** 未登入導去登入頁；managerOnly 的頁面擋非主管 */
function Guard({ children, managerOnly = false }: { children: React.ReactNode; managerOnly?: boolean }) {
  const { session, profile, loading, isManager } = useAuth()
  if (loading) return <div className="p-10 text-center text-ink-500">載入中…</div>
  if (!session) return <Navigate to="/login" replace />
  if (profile && !profile.active) {
    return <div className="p-10 text-center text-warn">此帳號已停用，請洽工務處主管。</div>
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
              <Route index element={<QuoteListPage />} />
              <Route path="quote/new" element={<QuoteEditorPage />} />
              <Route path="quote/:id" element={<QuoteEditorPage />} />
              <Route path="catalog" element={<Guard managerOnly><PriceCatalogPage /></Guard>} />
              <Route path="indices" element={<Guard managerOnly><IndicesPage /></Guard>} />
              <Route path="users" element={<Guard managerOnly><UsersPage /></Guard>} />
              <Route path="nego/:id" element={<Guard managerOnly><NegotiationPage /></Guard>} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </RefDataProvider>
      </AuthProvider>
    </HashRouter>
  )
}
