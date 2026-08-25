import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from './AuthContext'
import type {
  Category, EvidenceSource, LaborRate, MaterialIndex, PriceItem,
} from '../types'

interface RefData {
  categories: Category[]
  items: PriceItem[]
  indices: MaterialIndex[]
  evidence: EvidenceSource[]
  laborRates: LaborRate[]
  settings: Record<string, unknown>
  loading: boolean
  error: string | null
  reload: () => Promise<void>
  /** 便利查詢 */
  mgmtFeeRate: number
  taxRate: number
  /** 技術工日薪「牌價」（3,000，對齊臺北市政府工程預算參考單價） */
  laborBase: number
  /** 物業管理合約優惠折數：報價 = laborBase × laborDiscount × 時段係數 */
  laborDiscount: number
  categoryOf: (id: string) => Category | undefined
  indexOf: (id: string | null) => MaterialIndex | undefined
  evidenceOf: (id: string | null) => EvidenceSource | undefined
}

const Ctx = createContext<RefData | null>(null)

export function useRefData(): RefData {
  const v = useContext(Ctx)
  if (!v) throw new Error('useRefData 必須在 RefDataProvider 內使用')
  return v
}

export function RefDataProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  const [categories, setCategories] = useState<Category[]>([])
  const [items, setItems] = useState<PriceItem[]>([])
  const [indices, setIndices] = useState<MaterialIndex[]>([])
  const [evidence, setEvidence] = useState<EvidenceSource[]>([])
  const [laborRates, setLaborRates] = useState<LaborRate[]>([])
  const [settings, setSettings] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [c, i, m, e, l, s] = await Promise.all([
      supabase.from('categories').select('*').order('sort'),
      supabase.from('price_items').select('*').order('sort'),
      supabase.from('material_indices').select('*'),
      supabase.from('evidence_sources').select('*'),
      supabase.from('labor_rates').select('*').eq('active', true).order('sort'),
      // 排除 quote_stamp：那是 145KB 的印章圖，只有列印已核可的單才需要，
      // 沒必要讓每個人每次開頁都下載一次。PrintPage 會在需要時自己抓。
      supabase.from('settings').select('*').neq('key', 'quote_stamp'),
    ])
    const firstErr = [c, i, m, e, l, s].find((r) => r.error)?.error
    if (firstErr) { setError(firstErr.message); setLoading(false); return }
    setCategories((c.data ?? []) as Category[])
    setItems((i.data ?? []) as PriceItem[])
    setIndices((m.data ?? []) as MaterialIndex[])
    setEvidence((e.data ?? []) as EvidenceSource[])
    setLaborRates((l.data ?? []) as LaborRate[])
    setSettings(Object.fromEntries(
      ((s.data ?? []) as { key: string; value: unknown }[]).map((r) => [r.key, r.value]),
    ))
    setLoading(false)
  }, [])

  // 這些資料全都要登入後才讀得到（RLS 只開給 authenticated），
  // 未登入時去抓只會得到一串連線錯誤，所以等有 session 才載入。
  useEffect(() => {
    if (!session) { setLoading(false); return }
    void reload()
  }, [session, reload])

  const num = (k: string, d: number) => {
    const v = settings[k]
    return typeof v === 'number' ? v : d
  }

  const value: RefData = {
    categories, items, indices, evidence, laborRates, settings, loading, error, reload,
    mgmtFeeRate: num('mgmt_fee_rate', 0.09),
    taxRate: num('tax_rate', 0.05),
    laborBase: num('labor_base_daily', 3000),
    laborDiscount: num('labor_discount', 0.9),
    categoryOf: (id) => categories.find((c) => c.id === id),
    indexOf: (id) => (id ? indices.find((x) => x.id === id) : undefined),
    evidenceOf: (id) => (id ? evidence.find((x) => x.id === id) : undefined),
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
