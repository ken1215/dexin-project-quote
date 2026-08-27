/**
 * index.css 結構檢查。
 *
 * 為什麼需要：2026-08-27 加手機樣板時，插入點的錨點是 `.tag`，但原檔的
 * `.th` / `.td` 排在 `.tag` 後面，於是提前補上的 `}` 收掉了 @layer components，
 * 兩條元件樣式掉進後面的 `@media (pointer: coarse)` 裡——**桌機滑鼠下全部表格
 * 的框線、內距、表頭底色都失效**，而括號仍然平衡、build 與 tsc 全部通過，
 * 症狀直到使用者回報「捲動時文字跟表頭重疊」才浮現。
 *
 * 所以這裡驗的是「元件樣式有沒有待在該待的地方」，不是語法對不對。
 *
 * 跑法：node scripts/check-css.mjs（已併進 npm test）
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const FILE = resolve(import.meta.dirname, '..', 'src', 'index.css')
// 註解要先剝掉：本檔的中文註解裡就有「@media」「{」這些字，不剝的話
// at-rule 堆疊會被註解內容誤導（第一版就誤報了 .table-scroll）。
// 用等長空白取代而不是刪除，位置索引才不會偏移。
const css = readFileSync(FILE, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))

/** 這些必須定義在 @layer components 內，且不得被任何 @media 包住 */
const COMPONENT_CLASSES = [
  '.btn', '.btn-primary', '.btn-danger', '.field', '.label',
  '.card', '.card-title', '.tag', '.th', '.td',
  '.table-scroll', '.action-bar',
]

/** 回傳某個位置外層的 at-rule 堆疊（由外而內） */
function enclosingAtRules(index) {
  const stack = []
  let i = 0
  while (i < index) {
    const ch = css[i]
    if (ch === '@') {
      const m = /^@[\w-]+[^{;]*/.exec(css.slice(i))
      if (m) {
        const brace = css.indexOf('{', i)
        const semi = css.indexOf(';', i)
        if (brace !== -1 && (semi === -1 || brace < semi)) {
          stack.push(m[0].trim().replace(/\s+/g, ' '))
          i = brace + 1
          continue
        }
      }
    }
    if (ch === '{') stack.push('(rule)')
    else if (ch === '}') stack.pop()
    i++
  }
  return stack
}

const problems = []

// 1. 括號平衡（先驗這個，不平衡的話下面的堆疊分析都不可信）
let depth = 0
for (const ch of css) {
  if (ch === '{') depth++
  else if (ch === '}') depth--
  if (depth < 0) break
}
if (depth !== 0) problems.push(`大括號不平衡，最終深度 ${depth}`)

// 2. 每個元件樣式的定義位置
for (const cls of COMPONENT_CLASSES) {
  // 只找「規則的開頭」，避免比對到選擇器中間（例如 .rwd-table td）
  const re = new RegExp(`(^|[\\n;{}])\\s*${cls.replace('.', '\\.')}\\s*[,{]`, 'm')
  const m = re.exec(css)
  if (!m) {
    problems.push(`找不到 ${cls} 的定義`)
    continue
  }
  const at = m.index + m[0].indexOf(cls)
  const stack = enclosingAtRules(at).filter((s) => s !== '(rule)')
  const media = stack.filter((s) => s.startsWith('@media'))
  if (media.length) {
    problems.push(`${cls} 被包在 ${media.join(' > ')} 裡面——` +
      `只有符合該條件的裝置才會套用，其餘裝置整條樣式失效`)
  }
  if (!stack.some((s) => s.startsWith('@layer components'))) {
    problems.push(`${cls} 不在 @layer components 內（實際在：${stack.join(' > ') || '最外層'}）`)
  }
}

// 3. sticky 表頭必須是不透明的底色——半透明會讓捲上來的內容透出來，
//    看起來就是文字疊在表頭上。
const stickyTh = /\.th-sticky\s*\{([^}]*)\}/.exec(css)
if (stickyTh && /\/\d/.test(stickyTh[1])) {
  problems.push('.th-sticky 使用了半透明底色（含 /數字 的透明度修飾），sticky 表頭必須不透明')
}

if (problems.length) {
  console.error('❌ index.css 結構檢查未通過：')
  for (const p of problems) console.error('   · ' + p)
  process.exit(1)
}
console.log(`index.css 結構檢查通過（${COMPONENT_CLASSES.length} 個元件樣式都在 @layer components 內、未被 @media 包住）`)
