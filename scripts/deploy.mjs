/**
 * 把 dist/ 推到 gh-pages 分支上線。
 * 用法：npm run deploy（會先 build）
 *
 * 之所以不是走 GitHub Actions：gh CLI 的 OAuth token 缺 `workflow` scope，
 * 推不了 .github/workflows/deploy.yml。等執行過
 *   gh auth refresh -h github.com -s workflow
 * 之後把該檔推上去，就會改成 push 即自動部署，這支腳本可以留著當備援。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadEnv } from 'vite'

const ROOT = resolve(import.meta.dirname, '..')
const DIST = resolve(ROOT, 'dist')
const REMOTE = 'https://github.com/ken1215/dexin-project-quote.git'

if (!existsSync(resolve(DIST, 'index.html'))) {
  console.error('找不到 dist/index.html —— 請先跑 npm run build')
  process.exit(1)
}

// 沒帶到 Supabase 設定的 build 上線就是一片空白，先擋下來
const assets = execFileSync('node', ['-e',
  `const fs=require('fs');const d='${DIST.replace(/\\/g, '/')}/assets';` +
  `process.stdout.write(fs.readdirSync(d).filter(f=>f.endsWith('.js')).map(f=>fs.readFileSync(d+'/'+f,'utf8')).join(''))`,
], { maxBuffer: 64 * 1024 * 1024 }).toString()

// 不能只找 '.supabase.co'——supabase-js 函式庫本身就含這段字串，等於沒檢查。
// 要找的是「真的被 Vite 替換進去的那個網址」。
// 也不能寫死 *.supabase.co：走自有域名反向代理時（見 functions/_middleware.js，
// 因醫院網路把 supabase.co 整類擋掉而設），VITE_SUPABASE_URL 會是 quote.<域名>，
// 寫死就會在換域名的那天拒絕部署、而且錯誤訊息完全指錯方向。
// 改成拿建置當下實際設定的值來找——這才真的是「這次執行才會出現的具體值」。
// 用 Vite 自己的解析，而不是只看 process.env——.env.local 只有 Vite 讀得到，
// 只看 process.env 的話本機跑 npm run deploy 一定誤判成「沒設定」。
const viteEnv = loadEnv('production', ROOT, 'VITE_')
const expected = (process.env.VITE_SUPABASE_URL || viteEnv.VITE_SUPABASE_URL)?.replace(/\/+$/, '')
if (!expected) {
  console.error('❌ 環境變數 VITE_SUPABASE_URL 沒設定，無法驗證 build 產出。')
  console.error('   本機請建立 .env.local；CI 請確認 GitHub Actions secret 有帶進 build。')
  process.exit(1)
}
const projectUrl = assets.includes(expected) ? [expected] : null
const hasFallback = assets.includes('localhost:54321')

if (!projectUrl || hasFallback) {
  console.error('❌ build 產出沒有帶到 Supabase 連線設定，拒絕部署（推上去會是一個連不上後端的空殼）。')
  console.error(`   找到的專案網址：${projectUrl ? projectUrl[0] : '（無）'}`)
  console.error(`   仍含 localhost fallback：${hasFallback ? '是' : '否'}`)
  console.error(`   期待在產出裡找到：${expected}`)
  console.error('   請在專案根目錄建立 .env.local：')
  console.error('     VITE_SUPABASE_URL=https://xjylpaqvdxmxzehvwreg.supabase.co  # 或自有域名')
  console.error('     VITE_SUPABASE_ANON_KEY=<anon key>')
  console.error('   然後重跑 npm run deploy。')
  process.exit(1)
}
console.log('連線設定檢查通過：' + projectUrl[0])

copyFileSync(resolve(DIST, 'index.html'), resolve(DIST, '404.html'))
writeFileSync(resolve(DIST, '.nojekyll'), '')

const git = (...args) => execFileSync('git', args, { cwd: DIST, stdio: 'inherit' })

rmSync(resolve(DIST, '.git'), { recursive: true, force: true })
git('init', '-q')
git('add', '-A')
git('-c', 'user.email=ken1215@gmail.com', '-c', 'user.name=ken1215', 'commit', '-qm', 'deploy')
git('push', '-qf', REMOTE, 'HEAD:gh-pages')
rmSync(resolve(DIST, '.git'), { recursive: true, force: true })

console.log('\n已上線：https://ken1215.github.io/dexin-project-quote/')
console.log('（GitHub Pages 通常 30 秒內生效，重新整理若沒變請強制重新載入 Ctrl+F5）')
