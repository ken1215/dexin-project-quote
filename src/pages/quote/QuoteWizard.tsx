import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Alert from '../../components/ui/Alert'
import PageHeader from '../../components/ui/PageHeader'
import StatusTag from '../../components/ui/StatusTag'
import Stepper from '../../components/ui/Stepper'
import { useAuth } from '../../context/AuthContext'
import { useRefData } from '../../context/RefDataContext'
import { useDraftAutosave } from '../../hooks/useDraftAutosave'
import { DEPT_OPTIONS, LABOR_SECTION_TITLE } from '../../hooks/useQuoteDraft'
import type { UseQuoteDraft } from '../../hooks/useQuoteDraft'
import { validateQuote } from '../../lib/calc'
import type { Totals } from '../../lib/calc'
import { draftKey } from '../../lib/draftStorage'
import type {
  Category, DraftLine, DraftQuote, DraftSection, LaborRate, PriceItem,
} from '../../types'
import StepSite from './steps/StepSite'
import StepCategory from './steps/StepCategory'
import StepItems from './steps/StepItems'
import StepLabor from './steps/StepLabor'
import StepConfirm from './steps/StepConfirm'

/* ═══════════════════════════════════════════════════════════════
   五個步驟元件的 props 契約。
   下一階段三路平行實作一律照這裡寫；要改契約先改這裡，各步驟不要自己加 props。
   ═══════════════════════════════════════════════════════════════ */

/**
 * ③ 與 ⑤ 都要把 LineTable ＋ TotalsCard 整組畫出來，共用同一份契約。
 * 兩個元件都直接把這組原封不動餵給 LineTable，不要在步驟裡另刻一份表格。
 */
export interface StepTableProps {
  sections: DraftSection[]
  totals: Totals
  laborRates: LaborRate[]
  itemById: Map<string, PriceItem>
  rateById: Map<string, LaborRate>
  laborBase: number
  laborDiscount: number
  mgmtFeeRate: number
  taxRate: number
  onPatchSection: (sk: string, patch: Partial<DraftSection>) => void
  onPatchLine: (sk: string, lk: string, patch: Partial<DraftLine>) => void
  onRemoveLine: (sk: string, lk: string) => void
  onRemoveSection: (sk: string) => void
  onAddCustomLine: (sk: string) => void
  onChangeLineRate: (sk: string, lk: string, rateId: string) => void
}

/** ① 位置與使用者：只碰 project／dept／contact／quote_date 四個表頭欄位 */
export interface StepSiteProps {
  draft: DraftQuote
  /** 常用開單人名單（都是「工務處-人名」）；不在名單內可直接手打 */
  deptOptions: string[]
  onPatch: (patch: Partial<DraftQuote>) => void
}

/**
 * ② 大項：**只是 ③ 的篩選條件，不寫進 draft**。
 * 勾選只進精靈的本地集合；取消勾選若該大類已有明細（lineCountOf > 0），
 * 要先用 ui/ConfirmPanel 二次確認再呼叫 onUnselect（連同已長出的明細一起移除）。
 */
export interface StepCategoryProps {
  categories: Category[]
  selectedIds: string[]
  /** 該大類目前在單子上有幾列明細 */
  lineCountOf: (categoryId: string) => number
  onSelect: (categoryId: string) => void
  onUnselect: (categoryId: string) => void
}

/** ③ 細項：已勾大類底下的品項（依 subgroup 分組）＋ 明細籃 */
export interface StepItemsProps extends StepTableProps {
  /** 已依 sort 排序、已用「已勾大類」與 active 篩過的品項 */
  items: PriceItem[]
  /** 已勾的大類（做分類頁籤用），順序同單價庫的 sort */
  categories: Category[]
  /** 剛按下「加入」的即時回饋，原樣沿用現行的 .row-added／「已加入 ×N」 */
  justAdded: { id: string; qty: number } | null
  onAddItem: (item: PriceItem) => void
}

/**
 * ④ 工資：試算面板直接產生明細列，不挑品項
 * （單價庫只剩一個按「工」計價的 active 品項，且 addItem 對同品項是數量合併，
 * 表達不出「3 工平日 ＋ 2 工休息日」）。
 * 金額一律用 calc.ts 的 laborPrice／laborListPrice 算，元件裡不得另寫公式。
 */
export interface StepLaborProps {
  /** active 且依 sort 排好的時段；chip 一律由這個陣列產生（labor_rate_id 有外鍵） */
  laborRates: LaborRate[]
  laborBase: number
  laborDiscount: number
  rateById: Map<string, LaborRate>
  /** 目前「人工費用」分項底下的列；分項還沒建立時是空陣列。回填重算的來源是 spec（`N 人 × M 天`） */
  laborLines: DraftLine[]
  /** ＝ useQuoteDraft.addLaborLine：分項不存在會自動建立，有列才建 */
  onAdd: (input: { name: string; headcount: number; days: number; rateId: string }) => void
  /** 刪掉已加入的工資列（只吃 DraftLine.key，分項 key 由精靈帶） */
  onRemoveLaborLine: (lineKey: string) => void
}

/**
 * ⑤ 送出：全份預覽。送審／儲存草稿的按鈕在精靈的動作列上，步驟裡不要再放一顆
 * （手機釘底列與桌機那組不得出現同一顆按鈕）。
 */
export interface StepConfirmProps extends StepTableProps {
  draft: DraftQuote
  /** validateQuote 即時算出的把關訊息，空陣列代表可以送 */
  issues: string[]
  l1Skipped: boolean
  saving: boolean
  onPrint: () => void
}

/* ═══════════════════════════════════════════════════════════════ */

/** 桌機顯示完整名稱，手機取前兩字當縮寫（Stepper 自己截），所以前兩字不能重複 */
const STEPS = ['位置與使用者', '大項分類', '細項工料', '工資試算', '確認送出']

/**
 * ④ 工資試算可略過——多數工料品項的單價裡已含工率，沒有純工資要報就直接過。
 * 完成判定恆為 true（否則會擋住下一步），所以要另外告訴 Stepper 別把它畫成已完成。
 */
const OPTIONAL_STEPS = [false, false, false, true, false]

/**
 * 新單第一次存檔時，persist 會 navigate 到 /quote/<新 id>：網址上的 ?step 被丟掉，
 * id 一變 useQuoteDraft 重新載入、本元件整個卸載重掛，步驟會掉回「有明細→3、沒有→1」。
 * 結果是同仁在 ④ 按「儲存草稿」會被彈回第 3 步、④ 的面板輸入全部歸零。
 * persist 不能動（明細寫入順序是刻意的），所以在這一端把步驟接回來。
 *
 * 用 sessionStorage 而不是 state：跨卸載重掛才留得住。
 * 10 秒窗口是為了只接「存檔→重掛」那一次（毫秒等級），不要在幾分鐘後開另一張單時誤用。
 */
const STEP_STASH_KEY = 'dexin-quote-wizard-step'

const stashStep = (n: number): void => {
  try {
    sessionStorage.setItem(STEP_STASH_KEY, JSON.stringify({ step: n, at: Date.now() }))
  } catch { /* 私密視窗／停用 cookie 時會丟例外，掉步驟不值得讓整頁掛掉 */ }
}

const readStashedStep = (): number | null => {
  try {
    const raw = sessionStorage.getItem(STEP_STASH_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as { step?: unknown, at?: unknown }
    const s = Number(v.step)
    const at = Number(v.at)
    if (!Number.isInteger(s) || s < 1 || s > STEPS.length) return null
    if (!Number.isFinite(at) || Date.now() - at > 10_000) return null
    return s
  } catch { return null }
}

/** 每一步一句話說明這步要做什麼——用同仁的話，不是欄位名 */
const STEP_HINT = [
  '這次要修的地方在哪、誰開的單',
  '這次是哪一類工程？可以複選',
  '挑出要做的項目，填數量',
  '要派幾個人、做幾天？什麼時段？',
  '確認金額，送給處長核可',
]

/** 下一步鈕要寫出下一步是什麼；未達條件時停用，並在鈕旁寫出原因（不要只是灰掉） */
const NEXT_LABEL = ['下一步：挑大項', '下一步：挑細項', '下一步：算工資', '下一步：確認送出']
const BLOCK_REASON = [
  '請先填位置',
  '請先勾選至少一個大類',
  '請先加入項目，且每列數量要大於 0、品名不可空白',
  '',
]

/**
 * 單據「內容」的指紋，用來判斷 localStorage 的暫存跟畫面上這份是不是真的不一樣。
 * 刻意不含 DraftLine.key：persist 是整段砍掉重寫，存檔後重新載入的列會換成資料庫 id，
 * 直接比整包 JSON 會永遠判定不同，「找到未儲存草稿」就再也關不掉。
 */
const fingerprint = (d: DraftQuote): string => JSON.stringify({
  project: d.project,
  dept: d.dept,
  contact: d.contact,
  quote_date: d.quote_date,
  sections: d.sections.map((s) => ({
    title: s.title.trim(),
    lines: s.lines.map((l) => [
      l.item_id, l.labor_rate_id, l.name, l.spec, l.unit,
      Number(l.unit_price), Number(l.qty), l.is_custom, l.reason, l.note,
    ]),
  })),
})

/**
 * 開單五步精靈：① 位置與使用者 → ② 大項 → ③ 細項 → ④ 工資 → ⑤ 送出。
 *
 * 本檔只做**契約與狀態機**，每一步的內容在 steps/ 底下各自實作。
 *
 * 幾條不能破的規則：
 * - 「已勾大類」是精靈的本地 state，**不進 DraftQuote**——encodeDraft 會把 draft
 *   整包寫進 localStorage，畫面狀態塞進去會污染暫存。
 * - 已勾大類在 **render 當下**與 draft 現況取聯集，不用 useEffect 回填
 *   （effect 內 setState 會新增 react(set-state-in-effect) 警告，Task 6 為此來回四個 commit）。
 * - ② **不預建 DraftSection**：大項一律由 addItem 依 Category.section_title 自動長出，
 *   預建的空大項會被 persist 寫成「工程項目 N」並印進 A4 標單。
 * - 「下一步」用 dbGuard 的寬口徑（只有 ⑤ 的送審才用 validateQuote），
 *   否則同仁還在填單就被零元品項那條卡住、連草稿都存不了。
 */
export default function QuoteWizard({ q }: { q: UseQuoteDraft }) {
  const { session } = useAuth()
  const {
    categories, items, laborRates, laborBase, laborDiscount, mgmtFeeRate, taxRate,
    loading: refLoading, error: refError,
  } = useRefData()
  const [params, setParams] = useSearchParams()

  /* ── 參考資料索引 ───────────────────────────────────────── */
  const itemById = useMemo(
    () => new Map<string, PriceItem>(items.map((i) => [i.id, i])),
    [items],
  )
  const rateById = useMemo(
    () => new Map<string, LaborRate>(laborRates.map((r) => [r.id, r])),
    [laborRates],
  )

  /* ── 步驟（網址上的 step 是 1～5） ───────────────────────── */
  const hasLines = q.draft.sections.some((s) => s.lines.length > 0)
  const rawStep = Number(params.get('step'))
  // 只在首次 render 讀一次 sessionStorage（lazy initializer，不用 effect）；
  // 之後一律以網址為準，不會每次 render 又被舊值拉回去。
  const [stashedStep] = useState<number | null>(() => readStashedStep())
  // 預設：接得回存檔前的步驟就用它；否則新單 1、既有草稿（已經有明細了）3
  // ——已經有品項的單不該把人丟回去挑大類
  const step = Number.isInteger(rawStep) && rawStep >= 1 && rawStep <= STEPS.length
    ? rawStep
    : (stashedStep ?? (hasLines ? 3 : 1))

  const goStep = (n: number) => {
    const next = Math.min(STEPS.length, Math.max(1, Math.round(n)))
    stashStep(next)
    // replace：五步在瀏覽器歷史裡疊五筆的話，同仁想離開這頁要按五次上一頁
    setParams((prev) => {
      const p = new URLSearchParams(prev)
      p.set('step', String(next))
      return p
    }, { replace: true })
    // 手機上換步驟若停在原本的捲動位置，會以為畫面沒反應
    window.scrollTo({ top: 0 })
  }

  /* ── ② 已勾大類：本地集合 ∪ draft 現況（render 當下推導，不用 effect） ── */
  const [picked, setPicked] = useState<string[]>([])
  const categoryOfLine = (l: DraftLine): string | undefined =>
    (l.item_id ? itemById.get(l.item_id)?.category_id : undefined)

  const selectedCategoryIds = useMemo(() => {
    const s = new Set(picked)
    for (const sec of q.draft.sections) {
      for (const l of sec.lines) {
        const c = l.item_id ? itemById.get(l.item_id)?.category_id : undefined
        if (c) s.add(c)
      }
    }
    return [...s]
  }, [picked, q.draft.sections, itemById])

  const lineCountOf = (categoryId: string): number =>
    q.draft.sections.reduce(
      (a, s) => a + s.lines.filter((l) => categoryOfLine(l) === categoryId).length,
      0,
    )

  const selectCategory = (categoryId: string) =>
    setPicked((prev) => (prev.includes(categoryId) ? prev : [...prev, categoryId]))

  /**
   * 取消勾選：本地集合拿掉，該大類已長出的明細一併移除。
   * 逐列刪、整個大項空了才刪大項——兩個大類可能共用同一個 section_title，
   * 直接刪大項會把別的大類的列一起殺掉。
   */
  const unselectCategory = (categoryId: string) => {
    setPicked((prev) => prev.filter((x) => x !== categoryId))
    for (const sec of q.draft.sections) {
      const victims = sec.lines.filter((l) => categoryOfLine(l) === categoryId)
      if (!victims.length) continue
      for (const l of victims) q.removeLine(sec.key, l.key)
      if (victims.length === sec.lines.length) q.removeSection(sec.key)
    }
  }

  /* ── 完成判定（精靈自算，不要去解析 q.issues 的中文字串） ── */
  const liveIssues = useMemo(() => validateQuote(q.draft), [q.draft])
  const done: boolean[] = [
    q.draft.project.trim() !== '',
    selectedCategoryIds.length > 0,
    hasLines && q.draft.sections.every(
      (s) => s.lines.every((l) => Number(l.qty) > 0 && l.name.trim() !== ''),
    ),
    true, // ④ 恆真：工資常已含在品項單價的工率裡，不是每張單都有純工資項
    liveIssues.length === 0,
  ]

  /* ── 草稿暫存（Task 6 的 useDraftAutosave，全庫第一次掛載） ── */
  const userId = session?.user.id ?? ''
  const autosave = useDraftAutosave({
    userId, quoteId: q.draft.id, draft: q.draft, enabled: !q.locked,
  })
  const restored = autosave.restored
  /**
   * onSaveDraft／onSubmit 回傳 void，精靈**無法知道存檔成功與否**來呼叫 clear()；
   * 靠 q.notice 猜會在存檔失敗時清掉暫存（最不能出錯的那一種）。
   * 改成比對內容指紋：暫存與畫面一致就不提示——存檔成功後兩邊自然一致，
   * 提示會自己消失；存檔失敗時暫存仍原封不動留著。
   */
  // 另一道閘門：**空白的暫存不值得提示**。
  // 一開新單、什麼都還沒填，autosave 就會把空草稿寫進 localStorage；
  // 下次開新單就會跳一次「找到未儲存的草稿」，而按了套用什麼也不會發生。
  // 提示若連空單都跳，同仁很快就學會無視它，真的有東西要還原時反而被略過。
  const hasContent = (d: DraftQuote): boolean =>
    Boolean(d.project.trim() || d.dept.trim() || d.contact.trim())
    || d.sections.some((s) => s.lines.length > 0)

  const showRestore = restored
    ? hasContent(restored.draft) && fingerprint(restored.draft) !== fingerprint(q.draft)
    : false

  // 新單存檔成功後網址換成 /quote/<id>，暫存 key 也跟著換，舊的「:new」那份要清掉，
  // 否則下次「開新單」會一直跳出上一張單的還原提示。
  // 這裡不 setState（只動 localStorage），不會觸發 react(set-state-in-effect)。
  const startedWithoutId = useRef(!q.draft.id)
  useEffect(() => {
    if (!startedWithoutId.current || !q.draft.id || !userId) return
    try { localStorage.removeItem(draftKey(userId)) } catch { /* 無痕視窗會整個拋錯，忽略 */ }
  }, [q.draft.id, userId])

  const applyRestored = () => {
    const d = autosave.applyRestored()
    if (!d) return
    // 暫存裡的 id／單號／狀態一律不覆蓋現況（可能是另一張單留下的），只還原使用者打的內容
    q.patchDraft({
      project: d.project, dept: d.dept, contact: d.contact,
      quote_date: d.quote_date, sections: d.sections,
    })
  }

  /* ── 各步驟的 props ─────────────────────────────────────── */
  const tableProps: StepTableProps = {
    sections: q.draft.sections,
    totals: q.totals,
    laborRates,
    itemById,
    rateById,
    laborBase,
    laborDiscount,
    mgmtFeeRate,
    taxRate,
    onPatchSection: q.patchSection,
    onPatchLine: q.patchLine,
    onRemoveLine: q.removeLine,
    onRemoveSection: q.removeSection,
    onAddCustomLine: q.addCustomLine,
    onChangeLineRate: q.changeLineRate,
  }

  const pickedCategories = categories.filter((c) => selectedCategoryIds.includes(c.id))
  const visibleItems = items.filter(
    (i) => i.active && selectedCategoryIds.includes(i.category_id),
  )
  const laborSection = q.draft.sections.find((s) => s.title.trim() === LABOR_SECTION_TITLE)

  if (refLoading) {
    return <div className="p-10 text-center text-ink-500">載入中…</div>
  }

  const canNext = done[step - 1]

  return (
    <div className="space-y-4">
      <PageHeader
        index="02"
        eyebrow="QUOTE"
        title="開立報價單"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {q.draft.quote_no && <span className="tag">{q.draft.quote_no}</span>}
            <StatusTag status={q.draft.status} l1Skipped={q.l1Skipped} />
          </div>
        }
      />

      <Stepper
        steps={STEPS}
        current={step - 1}
        done={done}
        optional={OPTIONAL_STEPS}
        onJump={(i) => goStep(i + 1)}
      />

      {/* 步驟導引是螢幕上的操作提示，印出來只是雜訊（列印走 PrintPage，這裡是 Ctrl+P 的防呆）。
          要隱藏一律掛 no-print，不在 @media print 裡新增規則——那一區的 A4 標單版面已定版。 */}
      <div className="text-ink-700 no-print">
        <span className="mr-2 font-semibold text-deep">第 {step} 步</span>
        {STEP_HINT[step - 1]}
      </div>

      {(q.err || refError) && (
        <Alert kind="error">{q.err || `參考資料載入失敗：${refError}`}</Alert>
      )}
      {/* ⑤ 由 StepConfirm 自己列出送審前檢查，這裡不重複列一次 */}
      {q.issues.length > 0 && step !== 5 && (
        <Alert kind="error" title="請先修正以下問題：">
          <ul className="list-disc pl-5">
            {q.issues.map((m) => <li key={m}>{m}</li>)}
          </ul>
        </Alert>
      )}
      {q.notice && <Alert kind="success">{q.notice}</Alert>}
      {q.draft.status === 'rejected' && q.reviewNote && (
        <Alert kind="warn" title="退回意見">{q.reviewNote}</Alert>
      )}
      {restored && showRestore && (
        <Alert kind="warn" title="找到未儲存的草稿">
          <div className="mb-2">
            這台裝置上還留著一份沒存檔的內容
            （{new Date(restored.savedAt).toLocaleString('sv-SE')}）。要用它蓋掉目前畫面嗎？
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary" onClick={applyRestored}>
              套用未儲存的內容
            </button>
            <button type="button" className="btn" onClick={autosave.discardRestored}>
              捨棄
            </button>
          </div>
        </Alert>
      )}

      {step === 1 && (
        <StepSite draft={q.draft} deptOptions={DEPT_OPTIONS} onPatch={q.patchDraft} />
      )}
      {step === 2 && (
        <StepCategory
          categories={categories}
          selectedIds={selectedCategoryIds}
          lineCountOf={lineCountOf}
          onSelect={selectCategory}
          onUnselect={unselectCategory}
        />
      )}
      {step === 3 && (
        <StepItems
          {...tableProps}
          items={visibleItems}
          categories={pickedCategories}
          justAdded={q.justAdded}
          onAddItem={q.addItem}
        />
      )}
      {step === 4 && (
        <StepLabor
          laborRates={laborRates}
          laborBase={laborBase}
          laborDiscount={laborDiscount}
          rateById={rateById}
          laborLines={laborSection?.lines ?? []}
          onAdd={q.addLaborLine}
          onRemoveLaborLine={(lineKey) => {
            if (laborSection) q.removeLine(laborSection.key, lineKey)
          }}
        />
      )}
      {step === 5 && (
        <StepConfirm
          {...tableProps}
          draft={q.draft}
          issues={liveIssues}
          l1Skipped={q.l1Skipped}
          saving={q.saving}
          onPrint={() => void q.onPrint()}
        />
      )}

      {/* 停用原因寫在鈕旁邊，不要只是把鈕灰掉。
          釘底的 .action-bar 是 flex 且子項都 flex-1，字塞進去會擠掉按鈕，所以放它正上方。 */}
      {step < 5 && !canNext && BLOCK_REASON[step - 1] && (
        <div className="text-sm text-alert no-print">{BLOCK_REASON[step - 1]}</div>
      )}

      {/* 全站只有這一組動作列：.action-bar 在手機釘底、sm 以上變回一般區塊，
          所以同一顆按鈕不會在一支手機上出現兩次。 */}
      <div className="action-bar no-print">
        <button
          type="button" className="btn" disabled={step === 1}
          onClick={() => goStep(step - 1)}
        >上一步</button>
        {step < 5 ? (
          <button
            type="button" className="btn btn-primary" disabled={!canNext}
            onClick={() => goStep(step + 1)}
          >{NEXT_LABEL[step - 1]}</button>
        ) : (
          <button
            type="button" className="btn btn-primary"
            disabled={q.saving || liveIssues.length > 0}
            onClick={() => void q.onSubmit()}
          >{q.draft.status === 'rejected' ? '修正後重新送審' : '送工務處長核可'}</button>
        )}
        <button
          type="button" className="btn" disabled={q.saving}
          onClick={() => void q.onSaveDraft()}
        >{q.saving ? '儲存中…' : '儲存草稿'}</button>
      </div>
    </div>
  )
}
