// 完整匯出：用 pg_dump 把 Supabase 上「重建整套系統」需要的東西一次拉下來，
// 供 NAS 自架備援（Supabase self-hosted）還原用。和 backup-db.mjs 的差別：
//   backup-db.mjs  → 只有 public 表的資料（JSON），給「個別資料救回」用
//   export-full.mjs → 結構（表／函式／RLS／觸發器／權限）＋資料＋登入帳號，給「整套重建」用
//
// 只讀不寫——pg_dump 是唯讀交易快照，不碰任何資料。
//
// 產出（每次一個資料夾 dexin-quote-full_YYYYMMDD_HHMM\）：
//   01_public_schema.sql  public 結構（含 RLS policy、函式、觸發器、GRANT）
//   02_public_data.sql    public 資料（COPY 格式）
//   03_auth_data.sql      auth.users／auth.identities 資料（含密碼雜湊——工號登入要靠它）
//   source\               db\*.sql、Edge Function、Cloudflare middleware 原始碼快照
//   manifest.json         各表筆數、檔案 sha256、git commit、還原注意事項
//
// ⚠️ 敏感：03 有密碼雜湊；01 的 notify_quote_status_change 函式內含通知信密語。
//    輸出一律寫到 repo 外（預設工務專案小組雲端夾\完整匯出），repo 是 public 的。
//
// 需求：PostgreSQL 17 以上的 pg_dump（Supabase 是 PG 17）。沒有的話：
//   winget install --id PostgreSQL.PostgreSQL.17 -e --silent --accept-source-agreements --accept-package-agreements `
//     --override "--mode unattended --unattendedmodeui none --disable-components server,pgAdmin,stackbuilder"
//   （只裝命令列工具，不建資料庫服務）
// 密碼：環境變數 SUPABASE_DB_PASSWORD，或專案根目錄 .supabase-db-password.txt 第一個非空行。
// 連線：supabase\.temp\pooler-url（npx supabase link 產生的 session pooler，5432）。
//
// 用法：node scripts/export-full.mjs
// 環境變數：FULL_BACKUP_DIR（輸出根目錄）、PG_BIN（pg_dump 所在資料夾）

import { execFileSync, execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.FULL_BACKUP_DIR
  || 'H:\\我的雲端硬碟\\工作專用\\聯新_德新物業\\01_德新物業 (事業經營)\\02_經營議題專案小組\\01_工務專案小組\\院內工程報價\\資料庫備份\\完整匯出'
// 完整匯出每份約數 MB，留 30 份（每天一份約一個月）；長期保存靠 backup-db.mjs 的 90 份 JSON
const KEEP = 30
const MIN_PG_MAJOR = 17

const pad = (n) => String(n).padStart(2, '0')
const now = new Date()
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`

mkdirSync(BASE, { recursive: true })
const log = (m) => appendFileSync(join(BASE, 'export.log'), `${new Date().toISOString()} ${m}\n`)

function findPgDump() {
  const exe = process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump'
  const candidates = []
  if (process.env.PG_BIN) candidates.push(join(process.env.PG_BIN, exe))
  for (const v of [18, 17]) candidates.push(`C:\\Program Files\\PostgreSQL\\${v}\\bin\\${exe}`)
  for (const c of candidates) if (existsSync(c)) return c
  try {
    const found = execSync(process.platform === 'win32' ? 'where pg_dump' : 'command -v pg_dump', { encoding: 'utf8' })
      .split(/\r?\n/).find(Boolean)
    if (found) return found.trim()
  } catch { /* 不在 PATH */ }
  throw new Error('找不到 pg_dump（需 PostgreSQL 17 以上），安裝指令見本檔開頭註解')
}

function readPassword() {
  if (process.env.SUPABASE_DB_PASSWORD) return process.env.SUPABASE_DB_PASSWORD
  const f = join(ROOT, '.supabase-db-password.txt')
  if (!existsSync(f)) throw new Error('沒有 DB 密碼：設 SUPABASE_DB_PASSWORD，或放 .supabase-db-password.txt')
  const line = readFileSync(f, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map((s) => s.trim()).find(Boolean)
  if (!line) throw new Error('.supabase-db-password.txt 是空的')
  return line
}

function poolerUrl() {
  const f = join(ROOT, 'supabase', '.temp', 'pooler-url')
  if (!existsSync(f)) throw new Error('沒有 supabase\\.temp\\pooler-url，先跑 npx supabase link --project-ref xjylpaqvdxmxzehvwreg')
  const url = readFileSync(f, 'utf8').trim()
  if (/:[^:@/]+@/.test(url.replace(/^postgresql:\/\//, ''))) throw new Error('pooler-url 內含密碼，請改用不含密碼的版本')
  return url
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

// 從 COPY 格式的 dump 數每張表的筆數（不必再連一次資料庫）
function countCopyRows(sqlFile) {
  const counts = {}
  let table = null
  for (const line of readFileSync(sqlFile, 'utf8').split('\n')) {
    if (table) {
      if (line === '\\.' || line === '\\.\r') { table = null; continue }
      counts[table]++
    } else {
      const m = /^COPY (\S+) /.exec(line)
      if (m) { table = m[1]; counts[table] = 0 }
    }
  }
  return counts
}

function mustContain(file, needles) {
  const s = readFileSync(file, 'utf8')
  const missing = needles.filter((n) => !s.includes(n))
  if (missing.length) throw new Error(`${file} 缺少預期內容：${missing.join('、')}`)
}

const outDir = join(BASE, `dexin-quote-full_${stamp}`)
try {
  const pgDump = findPgDump()
  const ver = execFileSync(pgDump, ['--version'], { encoding: 'utf8' }).trim()
  const major = Number(/(\d+)\.\d+/.exec(ver)?.[1])
  if (!(major >= MIN_PG_MAJOR)) throw new Error(`pg_dump 版本太舊（${ver}），需要 ${MIN_PG_MAJOR} 以上`)

  const url = poolerUrl()
  const env = { ...process.env, PGPASSWORD: readPassword(), PGSSLMODE: 'require', PGCONNECT_TIMEOUT: '20' }
  mkdirSync(outDir, { recursive: true })

  const dump = (file, args) => {
    const out = join(outDir, file)
    execFileSync(pgDump, ['--dbname', url, '--no-owner', '--quote-all-identifiers', '--file', out, ...args], {
      env, stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8', timeout: 10 * 60 * 1000,
    })
    if (!existsSync(out) || statSync(out).size === 0) throw new Error(`${file} 沒有產出或是空檔`)
    return out
  }

  const schemaFile = dump('01_public_schema.sql', ['--schema-only', '--schema', 'public'])
  const dataFile = dump('02_public_data.sql', ['--data-only', '--schema', 'public'])
  const authFile = dump('03_auth_data.sql', ['--data-only', '--table', 'auth.users', '--table', 'auth.identities'])

  // 防呆：關鍵物件一定要在，少了就是 dump 不完整，不能當備份
  mustContain(schemaFile, ['CREATE TABLE "public"."quotes"', 'CREATE TABLE "public"."quote_lines"', 'CREATE POLICY'])
  const publicRows = countCopyRows(dataFile)
  const authRows = countCopyRows(authFile)
  for (const t of ['"public"."quotes"', '"public"."quote_lines"', '"public"."profiles"']) {
    if (!(t in publicRows)) throw new Error(`02_public_data.sql 沒有 ${t}`)
  }
  if (!authRows['"auth"."users"']) throw new Error('03_auth_data.sql 沒有任何 auth.users，登入帳號會全部遺失')

  // 原始碼快照：Edge Function 與 db 腳本（含 gitignore 的 db/14 印章）一起帶走，還原時不必回頭找 repo
  const src = join(outDir, 'source')
  for (const d of ['db', join('supabase', 'functions'), 'functions']) {
    if (existsSync(join(ROOT, d))) cpSync(join(ROOT, d), join(src, d), { recursive: true })
  }

  let commit = 'unknown'
  try { commit = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim() } catch { /* 非 git */ }

  const files = {}
  for (const f of [schemaFile, dataFile, authFile]) files[f.split(/[\\/]/).pop()] = { bytes: statSync(f).size, sha256: sha256(f) }

  const manifest = {
    exported_at: now.toISOString(),
    project_ref: 'xjylpaqvdxmxzehvwreg',
    source_commit: commit,
    pg_dump: ver,
    files,
    rows: { ...publicRows, ...authRows },
    restore_notes: [
      '還原順序：01_public_schema → 03_auth_data → 02_public_data（public.profiles 參照 auth.users）。',
      '還原資料時以 SET session_replication_role = replica 執行，避免 quotes 的狀態守門與通知觸發器在匯入時作用。',
      '⚠️ notify_quote_status_change() 寫死雲端 URL 與通知密語：備援機還原後必須先停用 quotes_notify_mail 觸發器或改指向本機，否則會從雲端寄信給同仁。',
      'Edge Function 的 secrets（SMTP 帳密、NOTIFY_HOOK_SECRET、SERVICE_ROLE）不在匯出內，自架時另行設定。',
      '自架版的 JWT secret 與雲端不同：前端要重 build 指向備援機的 URL 與 anon key；使用者密碼雜湊沿用，工號＋原密碼可直接登入。',
    ],
  }
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  const old = readdirSync(BASE).filter((f) => /^dexin-quote-full_\d{8}_\d{4}$/.test(f)).sort()
  for (const f of old.slice(0, Math.max(0, old.length - KEEP))) rmSync(join(BASE, f), { recursive: true, force: true })

  const summary = Object.entries(manifest.rows).map(([t, n]) => `${t.replace(/"/g, '')}=${n}`).join(' ')
  log(`OK ${outDir} ${summary}`)
  console.log(`完整匯出完成：${outDir}\n${summary.replace(/ /g, '\n')}`)
} catch (e) {
  const msg = (e.stderr ? String(e.stderr) : e.message).split('\n').find(Boolean) || e.message
  log(`FAIL ${msg}`)
  console.error(`完整匯出失敗：${msg}`)
  // 失敗的半成品資料夾不留，免得被當成可用備份
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
  process.exit(1)
}
