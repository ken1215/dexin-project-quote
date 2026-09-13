import { useMemo } from 'react'
import Alert from '../../components/ui/Alert'
import PageHeader from '../../components/ui/PageHeader'
import StatusTag from '../../components/ui/StatusTag'
import { useAuth } from '../../context/AuthContext'
import { useRefData } from '../../context/RefDataContext'
import type { UseQuoteDraft } from '../../hooks/useQuoteDraft'
import type { LaborRate, PriceItem } from '../../types'
import LineTable from './LineTable'
import TotalsCard from './TotalsCard'

/**
 * 報價單審閱（唯讀）。
 *
 * 改版前簽核與開單是同一個畫面，只把輸入框 disabled 掉——主管打開一張待審單，
 * 看到的是一整片灰色欄位，要核可的內容反而得在輸入框裡讀。這裡拆成獨立版面：
 * 內容一律純文字，畫面上只留「核可／核定／退回」這幾件主管真正要做的事。
 *
 * 能不能簽核由 useQuoteDraft 判定（canReviewL1／canReviewL2），
 * 本元件只負責顯示，不自己推導權限——真正的把關在資料庫 RLS 與 trigger。
 */
export default function QuoteReview({ q }: { q: UseQuoteDraft }) {
  const { isDeptHead, isAdmin } = useAuth()
  const {
    items, laborRates, laborBase, laborDiscount, mgmtFeeRate, taxRate,
    loading: refLoading, error: refError,
  } = useRefData()

  const itemById = useMemo(
    () => new Map<string, PriceItem>(items.map((i) => [i.id, i])),
    [items],
  )
  const rateById = useMemo(
    () => new Map<string, LaborRate>(laborRates.map((r) => [r.id, r])),
    [laborRates],
  )

  if (refLoading) {
    return <div className="p-10 text-center text-ink-500">載入中…</div>
  }

  /** 唯讀原因：三種鎖定情境的說法不同，主管要看得出「為什麼不能改」 */
  const lockReason = q.draft.status === 'approved'
    ? '本單已核定，金額與明細已鎖定；要調整金額請至「議價」頁處理，或退回草稿重跑簽核。'
    : q.frozen
      ? '本單已進入議價／定案階段，在此改寫明細會清除議價紀錄，故已鎖定；金額異動請至「議價」頁處理。'
      : '本單已送審，如需修改請洽核決主管退回。'

  return (
    <div className="space-y-4">
      <PageHeader
        index="02"
        eyebrow="QUOTE"
        title="報價單審閱"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {q.draft.quote_no && <span className="tag">{q.draft.quote_no}</span>}
            <StatusTag status={q.draft.status} l1Skipped={q.l1Skipped} />
          </div>
        }
      />

      {(q.err || refError) && (
        <Alert kind="error">{q.err || `參考資料載入失敗：${refError}`}</Alert>
      )}
      {q.issues.length > 0 && (
        <Alert kind="error" title="請先修正以下問題：">
          <ul className="list-disc pl-5">
            {q.issues.map((m) => <li key={m}>{m}</li>)}
          </ul>
        </Alert>
      )}
      {q.notice && <Alert kind="success">{q.notice}</Alert>}
      {q.locked && <Alert kind="info">{lockReason}</Alert>}
      {q.draft.status === 'rejected' && q.reviewNote && (
        <Alert kind="warn" title="退回意見">{q.reviewNote}</Alert>
      )}

      {/* 表頭摘要：四格純文字。不要用 disabled input——那是改版前被打槍的做法。
          值採左對齊，所以不套 ui/Stat（它的值欄是 .num，右對齊等寬數字，
          適合金額但不適合案名這種長字串），只共用 .stat 這個卡片樣式。 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="stat">
          <div className="text-xs text-ink-500">工程地點／案名</div>
          <div className="break-words text-[0.9375rem] font-semibold text-ink-900">
            {q.draft.project || '—'}
          </div>
        </div>
        <div className="stat">
          <div className="text-xs text-ink-500">申請單位</div>
          <div className="break-words text-[0.9375rem] text-ink-900">{q.draft.dept || '—'}</div>
        </div>
        <div className="stat">
          <div className="text-xs text-ink-500">工程現場聯絡窗口</div>
          <div className="break-words text-[0.9375rem] text-ink-900">{q.draft.contact || '—'}</div>
        </div>
        <div className="stat">
          <div className="text-xs text-ink-500">報價日期</div>
          <div className="text-[0.9375rem] text-ink-900">{q.draft.quote_date || '—'}</div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <LineTable
          sections={q.draft.sections}
          totals={q.totals}
          readOnly
          laborRates={laborRates}
          itemById={itemById}
          rateById={rateById}
          laborBase={laborBase}
          laborDiscount={laborDiscount}
        />

        <div className="space-y-4 lg:sticky lg:top-16 lg:self-start">
          <TotalsCard totals={q.totals} mgmtFeeRate={mgmtFeeRate} taxRate={taxRate} />

          {/* 核可／核定這兩顆在手機已經在釘底動作列，這裡一律 hidden sm:inline-flex，
              同一顆按鈕不得在一支手機上出現兩次（改版前踩過）。
              釘底列沒有的（列印預覽、越級核定、退回）才在手機顯示。 */}
          <div className="card space-y-2">
            <div className="card-title hidden sm:block">動作</div>
            <button
              type="button" className="btn w-full" disabled={q.saving}
              onClick={() => void q.onPrint()}
            >列印預覽</button>

            {q.canReview && (
              <div className="space-y-2 border-t border-ink-200 pt-2">
                {q.canReviewL1 && (
                  <button
                    type="button" className="btn btn-primary hidden w-full sm:inline-flex" disabled={q.saving}
                    onClick={() => void q.onApproveL1()}
                  >{isDeptHead ? '核可（第一關）' : '代處長核可（第一關）'}</button>
                )}
                {q.canReviewL2 && (
                  <button
                    type="button" className="btn btn-primary hidden w-full sm:inline-flex" disabled={q.saving}
                    onClick={() => void q.onApproveFinal()}
                  >核定（第二關·可送採購）</button>
                )}
                {/* 處長請假時不要卡單：副部長從待審單直接核定，trigger 會記 l1_skipped */}
                {q.canReviewL1 && isAdmin && (
                  <button
                    type="button" className="btn w-full" disabled={q.saving}
                    onClick={() => void q.onApproveFinal()}
                  >越級直接核定</button>
                )}
                <div>
                  <label className="label">退回意見（退回時必填）</label>
                  <textarea
                    className="field" rows={3} value={q.reviewNote}
                    onChange={(e) => q.setReviewNote(e.target.value)}
                  />
                </div>
                <button
                  type="button" className="btn btn-danger w-full" disabled={q.saving}
                  onClick={() => void q.onReject()}
                >退回</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 手機專用釘底動作列：只放主管最常按的那一顆，與右側卡片共用同一組 handler。
          右側那組在手機是隱藏的，兩邊不會同時出現同一顆按鈕。 */}
      {q.canReview && (
        <div className="action-bar no-print sm:hidden">
          {q.canReviewL1 && (
            <button
              type="button" className="btn btn-primary" disabled={q.saving}
              onClick={() => void q.onApproveL1()}
            >{isDeptHead ? '核可' : '代處長核可'}</button>
          )}
          {q.canReviewL2 && (
            <button
              type="button" className="btn btn-primary" disabled={q.saving}
              onClick={() => void q.onApproveFinal()}
            >核定</button>
          )}
        </div>
      )}
    </div>
  )
}
