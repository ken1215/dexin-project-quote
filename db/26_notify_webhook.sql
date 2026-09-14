-- ════════════════════════════════════════════════════════════════
-- 26_notify_webhook.sql — 簽核通知信的觸發器（等同 Dashboard 的 Database Webhooks）
--
-- 【貼之前一定要做一件事】
-- 把下面的 <在此貼上 NOTIFY_HOOK_SECRET> 換成真正的通關密語，
-- 也就是當初 `npx supabase secrets set NOTIFY_HOOK_SECRET=...` 設進去的那一串
-- （本機備份在專案根目錄的 .notify-hook-secret.local，該檔已被 gitignore）。
-- 沒換就執行的話，Edge Function 會一律回 401，信一封都寄不出去，
-- 而且因為 pg_net 是非同步的，簽核畫面上看起來一切正常——不會有任何錯誤提示。
--
-- ⚠️ 換好之後**不要把含真密語的版本存回這個檔**，這個 repo 是 public 的。
--    改完直接貼進 Supabase → SQL Editor → Run，然後把編輯器裡的內容丟掉即可。
--
-- ── 為什麼是 AFTER UPDATE 而不是塞進既有的 trigger ──────────────
-- db/19 的 quotes_transition_guard 是 BEFORE UPDATE 而且會 raise：它的職責是
-- 「擋下不合法的簽核動作」。把 HTTP 呼叫塞進去，會讓「寄信」與「能不能簽核」
-- 綁在同一個交易的同一個判斷裡——寄信出問題不該有能力擋下一張單的核可。
-- 所以另立 AFTER 觸發器，簽核擋不擋得下來仍然只由 guard 決定。
--
-- ── 為什麼不會拖慢簽核 ───────────────────────────────────────────
-- pg_net 的 net.http_post 是非同步的：把請求丟進背景 worker 佇列就立刻返回，
-- 寄信慢或 SMTP 掛掉都不會回頭卡住這筆 UPDATE。
-- 代價是**失敗不會重試**，這是刻意的取捨——待簽核清單才是真相，信只是提醒。
--
-- ── 為什麼 WHEN 子句要擋同狀態 ──────────────────────────────────
-- 報價單在編輯過程會被存很多次（改案名、加明細都是 update）。
-- 不擋的話同一張單會連發好幾封一模一樣的信。Edge Function 那邊也有第二道
-- 相同的判斷（record.status === old_record.status 就 return），兩層都留著：
-- 這一層省掉無謂的 HTTP 請求，那一層防止有人手動打 API 時誤寄。
--
-- 可重複執行。
-- ════════════════════════════════════════════════════════════════

-- Database Webhooks 底層就靠這個擴充；Dashboard 的介面也只是幫你裝它而已
create extension if not exists pg_net;

-- security definer：觸發器會以「按下核可的那個人」的身分被觸發，
-- 而 net.http_post 一般使用者沒有執行權限。定義者權限讓它以建立者
-- （在 SQL Editor 執行即 postgres）的身分發出請求。
create or replace function notify_quote_status_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url     := 'https://xjylpaqvdxmxzehvwreg.supabase.co/functions/v1/notify-approval',
    headers := jsonb_build_object(
                 'Content-Type',    'application/json',
                 'x-notify-secret', '<在此貼上 NOTIFY_HOOK_SECRET>'),
    body    := jsonb_build_object(
                 'type',       'UPDATE',
                 'table',      'quotes',
                 'record',     to_jsonb(new),
                 'old_record', to_jsonb(old))
  );
  return null;   -- AFTER 觸發器的回傳值不影響資料
end $$;

drop trigger if exists quotes_notify_mail on quotes;
create trigger quotes_notify_mail
  after update on quotes
  for each row when (old.status is distinct from new.status)
  execute function notify_quote_status_change();

-- ── 驗證：下面這句要回**兩列** ──────────────────────────────────
select 'pg_net 已安裝'::text as check, extname::text as value
  from pg_extension where extname = 'pg_net'
union all
select 'trigger 已建立'::text, tgname::text
  from pg_trigger where tgname = 'quotes_notify_mail';

-- ── 確認密語真的換掉了（沒換的話這句會回一列警告）──────────────
select '⚠️ 密語還是佔位符，改掉再跑一次'::text as warning
  from pg_proc
 where proname = 'notify_quote_status_change'
   and prosrc like '%在此貼上%';
