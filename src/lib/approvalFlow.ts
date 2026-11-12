/**
 * 簽核關卡的顯示模型：一張單的「狀態＋戳記」→ 四關各自該怎麼畫。
 *
 * 純函式、零 runtime 依賴（只 import type），node --experimental-strip-types 可直跑。
 *
 * 口徑（不可改）：
 *   送審 → 工務處長核可 → 行政管理部副部長核定 → 副部長議價定案
 *
 * 【關卡狀態由 status 推導，戳記只當佐證】
 * 資料庫 trigger 不會在整單退回時清掉 approved_l1_*／approved_*，l1_skipped 也會
 * 一路殘留到重跑的草稿／待審。所以：
 *   · 第一關戳記只在 status ∈ {approved_l1, approved, negotiating, closed} 且非越級時採用
 *   · 第二關戳記只在 status ∈ {approved, negotiating, closed} 時採用
 *   · 越級(l1_skipped)只在 status ∈ {approved, negotiating, closed} 時成立
 *   · returned_at 只在 status ∈ {submitted, approved_l1} 時成立
 * 其餘一律當沒有，避免把上一輪的殘留值畫成這一輪的簽核紀錄。
 *
 * 【沒有欄位的事不要編】
 *   · 沒有送審時間（不得拿 created_at 冒充）→ 送審關 at 恆為 null
 *   · 沒有定案人欄位 → 定案關 byId 恆為 null；定案時間取 updated_at
 *     （close_quote_case 會寫 updated_at，且定案單全面凍結）
 *   · 沒有退回人／退回時間欄位 → rejected 時取 updated_at 當退回時間
 */
import type { Quote } from '../types'

export type FlowInput = Pick<Quote,
  'status' | 'l1_skipped' | 'returned_at' | 'approved_l1_by' | 'approved_l1_at'
  | 'approved_by' | 'approved_at' | 'created_by' | 'updated_at' | 'review_note'>

export type StepKey = 'submit' | 'l1' | 'l2' | 'close'
export type StepState = 'done' | 'current' | 'todo' | 'skipped' | 'rejected'

export interface FlowStep {
  key: StepKey
  /** 關卡名 */
  title: string
  /** 職稱（人名由畫面拿 byId 去對照表查，查不到就只顯示職稱） */
  actor: string
  state: StepState
  byId: string | null
  at: string | null
  /** 狀態短句；時間另外由畫面拿 at 去排版 */
  caption: string
  /** 這一關是被副部長「退回上一層級」退回來重審的 */
  returned: boolean
}

export interface FlowNote {
  kind: 'rejected' | 'returned'
  title: string
  text: string
  at: string | null
}

export interface Flow {
  steps: [FlowStep, FlowStep, FlowStep, FlowStep]
  note: FlowNote | null
  /** 一句話講完目前狀況：清單精簡版與 aria-label 用 */
  summary: string
  /** 舊制「議價中」的單 */
  legacy: boolean
}

const step = (
  key: StepKey, title: string, actor: string, state: StepState, caption = '',
  byId: string | null = null, at: string | null = null,
): FlowStep => ({ key, title, actor, state, byId, at, caption, returned: false })

export function buildApprovalFlow(q: FlowInput): Flow {
  const s = q.status
  const finalDone = s === 'approved' || s === 'negotiating' || s === 'closed'
  const skipped = finalDone && q.l1_skipped === true
  const l1Done = s === 'approved_l1' || (finalDone && !skipped)
  const returned = (s === 'submitted' || s === 'approved_l1') && Boolean(q.returned_at)
  const noteText = (q.review_note ?? '').trim()

  const submit = s === 'draft'
    ? step('submit', '送審', '開單人', 'current', '待送審', q.created_by)
    : s === 'rejected'
      ? step('submit', '送審', '開單人', 'rejected', '已退回', q.created_by, q.updated_at)
      : step('submit', '送審', '開單人', 'done', '已送審', q.created_by)

  const l1 = skipped
    ? step('l1', '處長核可', '工務處長', 'skipped', '越級・未經處長')
    : l1Done
      ? step('l1', '處長核可', '工務處長', 'done', '已核可', q.approved_l1_by, q.approved_l1_at)
      : s === 'submitted'
        ? step('l1', '處長核可', '工務處長', 'current', returned ? '副部長退回，待處長核可' : '待處長核可')
        : step('l1', '處長核可', '工務處長', 'todo')
  if (s === 'submitted' && returned) l1.returned = true

  const l2 = finalDone
    ? step('l2', '副部長核定', '副部長', 'done', skipped ? '越級核定' : '已核定', q.approved_by, q.approved_at)
    : s === 'approved_l1'
      ? step('l2', '副部長核定', '副部長', 'current', returned ? '已退回重審' : '待副部長核定')
      : step('l2', '副部長核定', '副部長', 'todo')
  if (s === 'approved_l1' && returned) l2.returned = true

  const close = s === 'closed'
    ? step('close', '定案', '副部長', 'done', '已定案', null, q.updated_at)
    : s === 'negotiating'
      ? step('close', '定案', '副部長', 'current', '議價中（舊制）')
      : s === 'approved'
        ? step('close', '定案', '副部長', 'current', '待議價定案')
        : step('close', '定案', '副部長', 'todo')

  let note: FlowNote | null = null
  if (noteText) {
    if (s === 'rejected') {
      note = { kind: 'rejected', title: '退回意見', text: noteText, at: q.updated_at }
    } else if (returned) {
      note = { kind: 'returned', title: '副部長退回上一層級', text: noteText, at: q.returned_at }
    }
  }

  const summary =
    s === 'draft' ? '草稿，尚未送審'
    : s === 'rejected' ? '已退回開單人，待修正重送'
    : s === 'submitted' ? (returned ? '副部長退回，待工務處長核可' : '待工務處長核可')
    : s === 'approved_l1' ? (returned ? '副部長退回重審' : '處長已核可，待副部長核定')
    : s === 'approved' ? (skipped ? '副部長越級核定（未經處長）' : '兩關已核定')
    : s === 'negotiating' ? '議價中（舊制）'
    : '已定案'

  return { steps: [submit, l1, l2, close], note, summary, legacy: s === 'negotiating' }
}

/**
 * 畫面與列印實際要顯示的關卡（使用者 2026-11-12）：「定案」關只在真的議價過
 * （已定案，或舊制議價中）才出現；其餘一律只顯示前三關，不掛「待議價定案」。
 */
export function visibleSteps(flow: Flow): FlowStep[] {
  return flow.steps.filter((st) => st.key !== 'close' || st.state === 'done' || flow.legacy)
}

/* ── 時間 ─────────────────────────────────────────────────────
   固定台北時區：戳記是資料庫 now()（UTC），出差時開在別的時區的瀏覽器
   也要跟辦公室看到同一個時間。 */
const FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

function parts(iso: string | null | undefined): Record<string, string> | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const out: Record<string, string> = {}
  for (const p of FMT.formatToParts(d)) out[p.type] = p.value
  return out
}

/** 「MM/DD HH:mm」；null 或無效回空字串 */
export function formatStamp(iso: string | null | undefined): string {
  const p = parts(iso)
  return p ? `${p.month}/${p.day} ${p.hour}:${p.minute}` : ''
}

/** 「MM/DD」；null 或無效回空字串 */
export function formatStampDate(iso: string | null | undefined): string {
  const p = parts(iso)
  return p ? `${p.month}/${p.day}` : ''
}

/* ── 清單精簡版 ───────────────────────────────────────────── */
export interface CompactLine {
  text: string
  /** normal＝一般小字；skipped＝越級（橘）；warn＝退回（紅） */
  tone: 'normal' | 'skipped' | 'warn'
}

const join = (...xs: string[]): string => xs.filter(Boolean).join(' ')

/**
 * 清單「狀態」欄小點下方那一行：只講最有用的一件事。
 * 草稿與一般待處長核可不出字（狀態標籤已經講完了，再講是雜訊）。
 * names 查不到人（同仁端受 RLS 限制）就只出職稱。
 */
export function compactLine(flow: Flow, names: Record<string, string> = {}): CompactLine | null {
  const [submit, l1, l2, close] = flow.steps
  const who = (st: FlowStep): string => (st.byId ? names[st.byId] ?? '' : '')

  if (flow.steps.some((st) => st.returned)) {
    // 意見被清空時 note 會是 null，這時沒有時間可講，但仍要看得出是退回的單
    return { text: join(formatStampDate(flow.note?.at ?? null), '副部長退回'), tone: 'warn' }
  }
  if (submit.state === 'rejected') {
    return { text: join(formatStampDate(submit.at), '退回'), tone: 'warn' }
  }
  if (close.state === 'done') {
    return { text: join(formatStampDate(close.at), '定案'), tone: 'normal' }
  }
  if (l2.state === 'done') {
    const skip = l1.state === 'skipped'
    return {
      text: join('副部長', who(l2), formatStampDate(l2.at), skip ? '越級核定' : '核定'),
      tone: skip ? 'skipped' : 'normal',
    }
  }
  if (l1.state === 'done') {
    return { text: join('處長', who(l1), formatStampDate(l1.at), '核可'), tone: 'normal' }
  }
  return null
}
