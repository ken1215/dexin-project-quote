# 建立（或更新）Windows 工作排程，兩支：
#   DexinQuoteBackup      每天 12:30  scripts/backup-db.mjs   public 表資料 JSON（留 90 份）
#   DexinQuoteFullExport  每天 12:40  scripts/export-full.mjs pg_dump 完整匯出，供 NAS 備援還原（留 30 份）
# 電腦當時沒開機，開機後會補跑一次（StartWhenAvailable）。只在使用者登入時執行，
# 因為 supabase CLI 的登入憑證在使用者設定檔裡。
# 完整匯出需要 PostgreSQL 17 的 pg_dump 與 .supabase-db-password.txt，缺任一項只建 JSON 備份那支。
# 用法：powershell -ExecutionPolicy Bypass -File scripts\install-backup-task.ps1
# 移除：Unregister-ScheduledTask -TaskName DexinQuoteBackup -Confirm:$false
#       Unregister-ScheduledTask -TaskName DexinQuoteFullExport -Confirm:$false

$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$root\scripts\backup-db.mjs`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Daily -At 12:30
Register-ScheduledTask -TaskName 'DexinQuoteBackup' -Action $action -Trigger $trigger -Settings $settings `
  -Description '德新報價系統資料庫每日備份到雲端硬碟（工務專案小組\院內工程報價\資料庫備份）' -Force | Out-Null

$hasPgDump = (Test-Path 'C:\Program Files\PostgreSQL\17\bin\pg_dump.exe') -or (Test-Path 'C:\Program Files\PostgreSQL\18\bin\pg_dump.exe') -or [bool](Get-Command pg_dump -ErrorAction SilentlyContinue)
$hasPassword = Test-Path (Join-Path $root '.supabase-db-password.txt')
if ($hasPgDump -and $hasPassword) {
  $action2 = New-ScheduledTaskAction -Execute $node -Argument "`"$root\scripts\export-full.mjs`"" -WorkingDirectory $root
  $trigger2 = New-ScheduledTaskTrigger -Daily -At 12:40
  Register-ScheduledTask -TaskName 'DexinQuoteFullExport' -Action $action2 -Trigger $trigger2 -Settings $settings `
    -Description '德新報價系統 pg_dump 完整匯出（資料庫備份\完整匯出），供 NAS 自架備援還原' -Force | Out-Null
} else {
  Write-Warning "未建 DexinQuoteFullExport：pg_dump=$hasPgDump，密碼檔=$hasPassword"
}

Get-ScheduledTask -TaskName 'DexinQuote*' | Select-Object TaskName, State
