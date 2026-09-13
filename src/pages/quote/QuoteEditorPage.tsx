import { useParams } from 'react-router-dom'
import { useQuoteDraft } from '../../hooks/useQuoteDraft'
import QuoteReview from './QuoteReview'
import QuoteWizard from './QuoteWizard'

/**
 * 報價單頁的分派點：同一條路由，三種畫面。
 *
 * 1. 還在載入 → 「載入中…」。
 * 2. 不能編輯的單（送審中、已核定、議價中、已定案，或輪到主管簽核）→ QuoteReview。
 *    改版前這些狀態是留在同一個編輯畫面把輸入框 disabled 掉，主管看到的是一片灰欄位。
 * 3. 其餘（草稿／退回）→ QuoteWizard 五步精靈。
 *
 * 本檔只做分派、不持有任何狀態：單據邏輯在 useQuoteDraft，版面在 QuoteWizard／QuoteReview。
 * 原本寫在這裡的私有 QuoteEditor 元件（單頁版開單畫面）已隨精靈上線移除——
 * 兩者是同一件事的兩套 UI，留著就會有兩份表頭欄位、兩組動作鈕各自維護，
 * 且兩邊都直接接 useQuoteDraft，改一邊忘了另一邊的風險沒有任何機制擋得住。
 */
export default function QuoteEditorPage() {
  const { id } = useParams()
  const q = useQuoteDraft(id)
  if (q.loading) return <div className="p-10 text-center text-ink-500">載入中…</div>
  if (q.locked || q.canReview) return <QuoteReview q={q} />
  return <QuoteWizard q={q} />
}
