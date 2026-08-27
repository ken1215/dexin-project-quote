/**
 * 部署到 Cloudflare Pages。
 * 用法：npm run deploy:cf        （第一次會自動建專案並設好環境變數）
 *
 * 為什麼要有這一份：聯新的網路過濾把 `github.io` 與 `supabase.co` 整類擋掉，
 * 院內連不到 GitHub Pages 那份，連後端也連不到。Cloudflare Pages 這份
 * 搭配 functions/_middleware.js 反向代理，讓瀏覽器全程只連一個位址。
 * GitHub Pages 那份保留不動，院外照樣可用。
 *
 * 兩份的差別只在 build 時的 VITE_SUPABASE_URL：
 *   GitHub Pages → 直接指向 Supabase
 *   Cloudflare   → 指向自己（由 _middleware.js 轉發）
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { loadEnv } from 'vite'

const ROOT = resolve(import.meta.dirname, '..')
const PROJECT = 'dexin-quote'
/** 換自有網域時只改這一行，其餘不動 */
const SITE_URL = process.env.CF_SITE_URL || `https://${PROJECT}.pages.dev`

const SUPABASE_URL = 'https://xjylpaqvdxmxzehvwreg.supabase.co'

const wrangler = (args, opts = {}) =>
  spawnSync('npx', ['wrangler@latest', ...args], {
    cwd: ROOT, stdio: opts.input ? ['pipe', 'inherit', 'inherit'] : 'inherit',
    shell: true, input: opts.input,
  })

// ── 0. 先確認登入，不然後面每一步都會失敗得莫名其妙 ──────────
const who = spawnSync('npx', ['wrangler@latest', 'whoami'], {
  cwd: ROOT, encoding: 'utf8', shell: true,
})
if ((who.stdout || '').includes('not authenticated')) {
  console.error('❌ 尚未登入 Cloudflare。請先執行：npx wrangler login')
  process.exit(1)
}

// ── 1. anon key 從 .env.local 取，不寫死在 repo 裡 ─────────────
const env = loadEnv('production', ROOT, 'VITE_')
const anon = process.env.VITE_SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY
if (!anon) {
  console.error('❌ 找不到 VITE_SUPABASE_ANON_KEY（請確認 .env.local 存在）')
  process.exit(1)
}

// ── 2. 建專案（已存在會失敗，屬正常，忽略即可）─────────────────
console.log(`\n▶ 確認 Pages 專案 ${PROJECT}`)
wrangler(['pages', 'project', 'create', PROJECT, '--production-branch', 'main'])

// ── 3. 代理用的上游位址。這是給 Function 用的，不是給前端用的 ──
console.log('\n▶ 設定 SUPABASE_URL（供 functions/_middleware.js 轉發）')
wrangler(['pages', 'secret', 'put', 'SUPABASE_URL', '--project-name', PROJECT],
         { input: SUPABASE_URL + '\n' })

// ── 4. build：前端指向「自己」，由 _middleware.js 轉發到 Supabase ──
// VITE_BASE 必須是 '/'：vite.config.ts 預設是 GitHub Pages 的 /dexin-project-quote/，
// 用那個前綴部署到 Cloudflare 會拿不到資產、畫面整片空白（實際踩過，console 會說
// MIME type 是 text/html——那是 SPA fallback 的 HTML 被當成 JS/CSS）。
console.log(`
▶ build（VITE_SUPABASE_URL=${SITE_URL}、VITE_BASE=/）`)
execFileSync('npm', ['run', 'build'], {
  cwd: ROOT, stdio: 'inherit', shell: true,
  env: {
    ...process.env,
    VITE_BASE: '/',
    VITE_SUPABASE_URL: SITE_URL,
    VITE_SUPABASE_ANON_KEY: anon,
  },
})

// ── 5. 上傳。functions/ 在專案根目錄，wrangler 會自動一起帶上去 ──
console.log('\n▶ 部署')
const r = wrangler(['pages', 'deploy', 'dist', '--project-name', PROJECT, '--branch', 'main'])
if (r.status !== 0) process.exit(r.status ?? 1)

console.log(`\n✅ 完成：${SITE_URL}`)
console.log('   請用「醫院網路」開這個網址測試——這是整件事唯一要驗的東西。')
console.log('   若仍被擋，改買自有網域接到同一個 Pages 專案，')
console.log('   然後 CF_SITE_URL=https://quote.你的網域 npm run deploy:cf')
