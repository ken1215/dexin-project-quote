import { useMemo } from 'react'
import Alert from '../../components/ui/Alert'
import ApprovalFlow from '../../components/ui/ApprovalFlow'
import PageHeader from '../../components/ui/PageHeader'
import StatusTag from '../../components/ui/StatusTag'
import { useAuth } from '../../context/AuthContext'
import { useRefData } from '../../context/RefDataContext'
import type { UseQuoteDraft } from '../../hooks/useQuoteDraft'
import { buildApprovalFlow } from '../../lib/approvalFlow'
import { money } from '../../lib/calc'
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
  const { isDeptHead, isAdmin, isViceDirector } = useAuth()
  /** 退回上一層級：只有副部長、只對已核定的單（db/30 trigger 才是真正的鎖） */
  const canReturnPrev = isViceDirector && q.draft.status === 'approved'
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

  const flow = useMemo(() => (q.flowInput ? buildApprovalFlow(q.flowInput) : null), [q.flowInput])

  if (refLoading) {
    return <div className="p-10 text-center text-ink-500">載入中…</div>
  }

  /** 唯讀原因：三種鎖定情境的說法不同，主管要看得出「為什麼不能改」 */
  const lockReason = q.draft.status === 'approved'
    ? '本單已核定，金額與明細已鎖定；減價定案請由副部長至「議價」頁處理，或退回重跑簽核。'
    : q.frozen
      ? '本單已定案（或為舊制議價中），在此改寫明細會清除議價紀錄，故已鎖定。'
      : '本單已送審，如需修改請洽核決主管退回。'

  /** 明細項數（摘要格用；空的大項不算） */
  const lineCount = q.draft.sections.reduce((a, s) => a + s.lines.length, 0)

  /** 右欄主動作卡的標題：輪到誰、要做哪一件事 */
  const primaryTitle = q.canReviewL1 ? '核可此單' : q.canReviewL2 ? '核定此單' : ''

  return (
    <div className="space-y-4">
      <PageHeader
        index="02"
        eyebrow="QUOTE REVIEW"
        title={q.draft.project || '報價單審閱'}
        meta={(
          <>
            {q.draft.quote_no && (
              <span className="tag num border border-ink-200 bg-white text-ink-700">{q.draft.quote_no}</span>
            )}
            <StatusTag status={q.draft.status} l1Skipped={q.l1Skipped} />
          </>
        )}
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

      {/* 簽核關卡。退回意見／副部長退回上一層級的理由都併在這張卡片的下緣，
          顯示的是資料庫裡已存的意見（flowInput.review_note），不是右欄輸入框正在打的字——
          以前兩者共用同一個 state，審核者一打字上面的「退回意見」就跟著變。 */}
      {flow && <ApprovalFlow flow={flow} names={q.names} />}
      {q.locked && <Alert kind="info">{lockReason}</Alert>}

      {/* 表頭摘要：純文字。不要用 disabled input——那是改版前被打槍的做法。
          案名格跨兩欄，長案名不再擠成三行。 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <div className="stat col-span-2 min-w-0">
          <div className="text-xs text-ink-500">工程地點／案名・申請單位</div>
          <div className="break-words text-[0.9375rem] font-medium text-ink-900">
            {q.draft.project || '—'}
          </div>
          <div className="break-words text-[0.8125rem] text-ink-700">
            {q.draft.dept || '—'}・聯絡窗口 {q.draft.contact || '—'}
          </div>
        </div>
        <div className="stat min-w-0">
          <div className="text-xs text-ink-500">報價日期</div>
          <div className="font-num tabular-nums text-[1.0625rem] font-semibold text-ink-900">{q.draft.quote_date || '—'}</div>
        </div>
        <div className="stat min-w-0">
          <div className="text-xs text-ink-500">明細</div>
          <div className="text-[1.0625rem] font-semibold text-ink-900">
            <span className="num">{lineCount}</span> 項
          </div>
        </div>
        <div className="stat col-span-2 min-w-0 lg:col-span-1">
          <div className="text-xs text-ink-500">合計（含稅）</div>
          <div className="font-num tabular-nums text-[1.0625rem] font-semibold text-deep">{money(q.totals.total)}</div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
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
        </div>

        <div className="min-w-0 space-y-4 lg:sticky lg:top-20 lg:self-start">
          {/* 動作卡：主動作（核可／核定）在最上面、是卡內唯一的實心按鈕；
              其次越級核定，再來退回，列印預覽墊底。
              核可／核定在手機已經在釘底動作列，這裡一律 hidden sm:block，
              同一顆按鈕不得在一支手機上出現兩次（改版前踩過）。 */}
          <div className="card space-y-4">
            {q.canReview && (
              <>
                {(q.canReviewL1 || q.canReviewL2) && (
                  <div className="hidden space-y-2 sm:block">
                    <div className="text-[0.8125rem] font-bold text-ink-900">{primaryTitle}</div>
                    {q.canReviewL1 && (
                      <button
                        type="button" className="btn btn-primary w-full py-2.5 text-[0.9375rem]" disabled={q.saving}
                        onClick={() => void q.onApproveL1()}
                      >{isDeptHead ? '核可（第一關）' : '代處長核可（第一關）'}</button>
                    )}
                    {q.canReviewL2 && (
                      <button
                        type="button" className="btn btn-primary w-full py-2.5 text-[0.9375rem]" disabled={q.saving}
                        onClick={() => void q.onApproveFinal()}
                      >核定（第二關）</button>
                    )}
                    <p className="text-xs text-ink-500">
                      {q.canReviewL1 ? '核可後送行政管理部副部長核定。' : '核定後進入議價定案。'}
                    </p>
                  </div>
                )}

                {/* 處長請假時不要卡單：副部長從待審單直接核定，trigger 會記 l1_skipped */}
                {q.canReviewL1 && isAdmin && (
                  <div className="space-y-1.5">
                    <button
                      type="button" className="btn w-full" disabled={q.saving}
                      onClick={() => void q.onApproveFinal()}
                    >越級直接核定</button>
                    <p className="text-xs text-ink-500">處長不在時使用，系統會留痕。</p>
                  </div>
                )}

                <div className="space-y-2 border-t border-ink-200 pt-4">
                  <label className="block text-[0.8125rem] font-bold text-ink-900" htmlFor="review-note">
                    退回<span className="ml-1.5 text-xs font-normal text-ink-500">（意見必填）</span>
                  </label>
                  <textarea
                    id="review-note"
                    className="field" rows={3} value={q.reviewNote}
                    placeholder="請寫明要修改的地方"
                    onChange={(e) => q.setReviewNote(e.target.value)}
                  />
                  <button
                    type="button" className="btn btn-danger w-full" disabled={q.saving}
                    onClick={() => void q.onReject()}
                  >退回開單人</button>
                </div>
              </>
            )}

            {canReturnPrev && (
              <div className="space-y-2">
                <label className="block text-[0.8125rem] font-bold text-ink-900" htmlFor="return-note">
                  退回上一層級<span className="ml-1.5 text-xs font-normal text-ink-500">（意見必填）</span>
                </label>
                <textarea
                  id="return-note"
                  className="field" rows={3} value={q.reviewNote}
                  placeholder="請寫明要修改的地方"
                  onChange={(e) => q.setReviewNote(e.target.value)}
                />
                <button
                  type="button" className="btn btn-danger w-full" disabled={q.saving}
                  onClick={() => void q.onReturnPrev()}
                >{q.l1Skipped ? '退回工務處長（越級核定的單）' : '退回上一層級（待副部長核定）'}</button>
              </div>
            )}

            <div className={q.canReview || canReturnPrev ? 'border-t border-ink-200 pt-3' : ''}>
              <button
                type="button"
                className="text-[0.8125rem] font-medium text-deep underline-offset-2 hover:text-deep-d hover:underline disabled:opacity-40 pointer-coarse:min-h-10"
                disabled={q.saving}
                onClick={() => void q.onPrint()}
              >列印預覽 →</button>
            </div>
          </div>

          <TotalsCard totals={q.totals} mgmtFeeRate={mgmtFeeRate} taxRate={taxRate} origTotal={q.origTotal} />
        </div>
      </div>

      {/* 手機專用釘底動作列：只放主管最常按的那一顆，與右側卡片共用同一組 handler。
          右側那組在手機是隱藏的，兩邊不會同時出現同一顆按鈕。 */}
      {q.canReview && (
        <div className="action-bar no-print sm:hidden">
          {q.canReviewL1 && (
            <button
              type="button" className="btn btn-primary py-3 text-base" disabled={q.saving}
              onClick={() => void q.onApproveL1()}
            >{isDeptHead ? '核可' : '代處長核可'}</button>
          )}
          {q.canReviewL2 && (
            <button
              type="button" className="btn btn-primary py-3 text-base" disabled={q.saving}
              onClick={() => void q.onApproveFinal()}
            >核定</button>
          )}
        </div>
      )}
    </div>
  )
}
