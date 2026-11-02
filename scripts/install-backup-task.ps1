# 建立（或更新）Windows 工作排程：每天 12:30 跑一次資料庫備份（scripts/backup-db.mjs）。
# 電腦當時沒開機，開機後會補跑一次（StartWhenAvailable）。只在使用者登入時執行，
# 因為 supabase CLI 的登入憑證在使用者設定檔裡。
# 用法：powershell -ExecutionPolicy Bypass -File scripts\install-backup-task.ps1
# 移除：Unregister-ScheduledTask -TaskName DexinQuoteBackup -Confirm:$false

$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$root\scripts\backup-db.mjs`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Daily -At 12:30
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
Register-ScheduledTask -TaskName 'DexinQuoteBackup' -Action $action -Trigger $trigger -Settings $settings `
  -Description '德新報價系統資料庫每日備份到雲端硬碟（工務專案小組\院內工程報價\資料庫備份）' -Force | Out-Null
Get-ScheduledTask -TaskName 'DexinQuoteBackup' | Select-Object TaskName, State
