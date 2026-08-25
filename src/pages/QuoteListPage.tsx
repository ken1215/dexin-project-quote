import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { calcTotals, money } from '../lib/calc'
import type { DraftLine, DraftSection, Quote, QuoteLine, QuoteStatus } from '../types'
import { STATUS_LABEL } from '../types'

/** 不同狀態的標籤配色（沿用 .tag 形狀，覆寫底色／文字色） */
const STATUS_TAG_CLASS: Record<QuoteStatus, string> = {
  draft: 'bg-ink-200 text-ink-700',
  submitted: 'bg-alert/15 text-alert',
  approved: 'bg-green/15 text-green',
  negotiating: 'bg-bright/15 text-bright',
  closed: 'bg-deep/15 text-deep',
  rejected: 'bg-warn-bg text-warn',
}

/** 用共用的 calcTotals 算單一報價單的合計金額（單一虛擬大項裝入所有明細即可） */
function quoteTotal(quote: Quote, lines: QuoteLine[]): number {
  const draftLines: DraftLine[] = lines.map((l) => ({
    key: l.id,
    item_id: l.item_id,
    labor_rate_id: l.labor_rate_id,
    name: l.name,
    spec: l.spec,
    unit: l.unit,
    unit_price: l.unit_price,
    qty: l.qty,
    is_custom: l.is_custom,
    reason: l.reason,
    note: l.note,
  }))
  const sections: DraftSection[] = [{ key: 'all', title: '', lines: draftLines }]
  return calcTotals(sections, quote.mgmt_fee_rate, quote.tax_rate).total
}

export default function QuoteListPage() {
  const { isManager } = useAuth()

  const [quotes, setQuotes] = useState<Quote[]>([])
  const [totals, setTotals] = useState<Record<string, number>>({})
  const [creators, setCreators] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [statusFilter, setStatusFilter] = useState<QuoteStatus | 'all'>('all')
  const [keyword, setKeyword] = useState('')

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)

      const { data: quoteRows, error: qErr } = await supabase
        .from('quotes')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200)

      if (cancelled) return
      if (qErr) {
        setError(qErr.message)
        setLoading(false)
        return
      }

      const list = (quoteRows ?? []) as Quote[]
      setQuotes(list)

      if (list.length === 0) {
        setTotals({})
        setCreators({})
        setLoading(false)
        return
      }

      const ids = list.map((q) => q.id)
      const { data: lineRows, error: lErr } = await supabase
        .from('quote_lines')
        .select('*')
        .in('quote_id', ids)

      if (cancelled) return
      if (lErr) {
        setError(lErr.message)
        setLoading(false)
        return
      }

      const linesByQuote = new Map<string, QuoteLine[]>()
      for (const l of (lineRows ?? []) as QuoteLine[]) {
        const arr = linesByQuote.get(l.quote_id)
        if (arr) arr.push(l)
        else linesByQuote.set(l.quote_id, [l])
      }
      const totalMap: Record<string, number> = {}
      for (const q of list) {
        totalMap[q.id] = quoteTotal(q, linesByQuote.get(q.id) ?? [])
      }
      setTotals(totalMap)

      if (isManager) {
        const creatorIds = [...new Set(list.map((q) => q.created_by).filter(Boolean))]
        if (creatorIds.length) {
          const { data: profileRows, error: pErr } = await supabase
            .from('profiles')
            .select('id, full_name')
            .in('id', creatorIds)
          if (cancelled) return
          if (pErr) {
            setError(pErr.message)
            setLoading(false)
            return
          }
          const map: Record<string, string> = {}
          for (const p of (profileRows ?? []) as { id: string; full_name: string }[]) {
            map[p.id] = p.full_name
          }
          setCreators(map)
        } else {
          setCreators({})
        }
      }

      setLoading(false)
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [isManager])

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return quotes.filter((q) => {
      if (statusFilter !== 'all' && q.status !== statusFilter) return false
      if (kw && !q.project.toLowerCase().includes(kw) && !q.quote_no.toLowerCase().includes(kw)) return false
      return true
    })
  }, [quotes, statusFilter, keyword])

  return (
    <div className="space-y-4">
      <div className="card">
        <h2 className="card-title">報價單列表</h2>

        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div>
            <label className="label">狀態</label>
            <select
              className="field w-40"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as QuoteStatus | 'all')}
            >
              <option value="all">全部</option>
              {(Object.keys(STATUS_LABEL) as QuoteStatus[]).map((s) => (
                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
              ))}
            </select>
          </div>
          <div className="flex-1 min-w-[200px]">
            <label className="label">關鍵字（案名或單號）</label>
            <input
              className="field"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="輸入案名或單號搜尋…"
            />
          </div>
          <Link to="/quote/new" className="btn btn-primary">＋ 開新單</Link>
        </div>

        {error && (
          <div className="mb-3 rounded-md border border-warn/30 bg-warn-bg px-3 py-2 text-sm text-warn">
            載入失敗：{error}
          </div>
        )}

        {loading ? (
          <div className="py-10 text-center text-sm text-ink-500">載入中…</div>
        ) : quotes.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-sm text-ink-500">目前還沒有任何報價單，建立第一張報價單開始使用。</p>
            <Link to="/quote/new" className="btn btn-primary">＋ 開新單</Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="th">單號</th>
                  <th className="th">案名</th>
                  <th className="th">申請單位</th>
                  {isManager && <th className="th">建立人</th>}
                  <th className="th">日期</th>
                  <th className="th">狀態</th>
                  <th className="th num">合計金額</th>
                  <th className="th">操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td className="td text-center text-ink-500" colSpan={isManager ? 8 : 7}>
                      無符合篩選條件的報價單。
                    </td>
                  </tr>
                ) : (
                  filtered.map((q) => (
                    <tr key={q.id}>
                      <td className="td">{q.quote_no}</td>
                      <td className="td">{q.project}</td>
                      <td className="td">{q.dept}</td>
                      {isManager && <td className="td">{creators[q.created_by] || '—'}</td>}
                      <td className="td">{q.quote_date}</td>
                      <td className="td">
                        <span className={`tag ${STATUS_TAG_CLASS[q.status]}`}>{STATUS_LABEL[q.status]}</span>
                      </td>
                      <td className="td num">{money(totals[q.id] ?? 0)}</td>
                      <td className="td">
                        <div className="flex flex-wrap gap-1.5">
                          <Link to={`/quote/${q.id}`} className="btn">編輯</Link>
                          <a href={`#/print/${q.id}`} target="_blank" rel="noopener noreferrer" className="btn">列印</a>
                          {isManager && (
                            <Link to={`/nego/${q.id}`} className="btn">議價</Link>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
