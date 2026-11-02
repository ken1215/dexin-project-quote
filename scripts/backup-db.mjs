// 定期備份：把 Supabase public schema 每一張表整份讀出，存成一個 JSON 檔到雲端硬碟。
//
// 只讀不寫——全程 select，不碰任何資料。報價單資料含金額，repo 是 public，
// 所以備份一律寫到 repo 外（預設工務專案小組的雲端夾，可用 BACKUP_DIR 覆寫）。
// 排程由 scripts/install-backup-task.ps1 建立（Windows 工作排程器，每天一次）。
//
// 用法：node scripts/backup-db.mjs
// 還原：備份檔是 { table: rows[] }，要還原哪張表再個別寫 SQL，不做一鍵覆蓋（覆蓋已核定單太危險）。

import { execSync } from 'node:child_process'
import { mkdirSync, readdirSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = process.env.BACKUP_DIR
  || 'H:\\我的雲端硬碟\\工作專用\\聯新_德新物業\\01_德新物業 (事業經營)\\02_經營議題專案小組\\01_工務專案小組\\院內工程報價\\資料庫備份'
// ponytail: 保留最近 90 份（每天一份約三個月），檔案很小，要更久改這裡
const KEEP = 90

function query(sql) {
  const out = execSync(`npx supabase db query --linked --output-format json "${sql}"`, {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
  })
  try {
    // 互動終端機下 CLI 回 {boundary, rows}，排程（非終端機）下直接回陣列，兩種都收
    const start = out.search(/[[{]/)
    const parsed = JSON.parse(out.slice(start))
    return Array.isArray(parsed) ? parsed : parsed.rows
  } catch (e) {
    throw new Error(`${e.message}；CLI 原始輸出前 300 字：${out.slice(0, 300).replace(/\s+/g, ' ')}`)
  }
}

const pad = (n) => String(n).padStart(2, '0')
const now = new Date()
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`

mkdirSync(DIR, { recursive: true })
const log = (m) => appendFileSync(join(DIR, 'backup.log'), `${new Date().toISOString()} ${m}\n`)

try {
  const tables = query(
    "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1",
  ).map((r) => r.table_name)

  const data = {}
  const counts = []
  for (const t of tables) {
    data[t] = query(`select * from public.${t}`)
    counts.push(`${t}=${data[t].length}`)
  }

  const file = join(DIR, `dexin-quote_${stamp}.json`)
  writeFileSync(file, JSON.stringify({ backed_up_at: now.toISOString(), tables: data }, null, 1))
  if (!data.quotes || !data.quote_lines) throw new Error('備份內容缺 quotes 或 quote_lines，請檢查')

  const old = readdirSync(DIR).filter((f) => /^dexin-quote_\d{8}_\d{4}\.json$/.test(f)).sort()
  for (const f of old.slice(0, Math.max(0, old.length - KEEP))) unlinkSync(join(DIR, f))

  log(`OK ${file} ${counts.join(' ')}`)
  console.log(`備份完成：${file}\n${counts.join('\n')}`)
} catch (e) {
  log(`FAIL ${e.message.split('\n')[0]}`)
  console.error(`備份失敗：${e.message}`)
  process.exit(1)
}
