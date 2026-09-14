-- ═══════════════════════════════════════════════════════════════
-- 25_notify_email.sql — 簽核通知信要寄到哪裡
--
-- 【要解決的事】簽核流程要在狀態轉換時寄通知信，但系統裡沒有一個「寄得出去的地址」。
--   內部同仁的登入身分是合成 email `工號@dexin.local`——dexin.local 是假網域，
--   建帳號時 email_confirm 直接設 true 從來沒驗證過，往那裡寄信 100% 退信。
--   profiles 表本身也沒有 email 欄位（現有欄位只有 id / full_name / role / active /
--   created_at / must_change_password）。
--
-- 【作法】profiles 加一個 notify_email 欄位，由主管在帳號管理頁人工填。
--   刻意**不**自動抓、不從 auth.users.email 帶入：
--   內部同仁那邊帶進來的一定是寄不出去的假網域地址，帶了反而讓人以為已經設定好。
--   預設空字串，空字串＝這個人不寄信，不是錯誤狀態——新帳號在主管填之前就是不收信，
--   簽核流程照常運作，只是少一封提醒。這讓本檔可以單獨上線而不影響任何既有功能。
--
-- 【為什麼不是 not null 的真 email 型別】填 email 是人工作業，會拖很久也會漏。
--   如果做成必填，主管在帳號管理頁存任何一個欄位都會被這個新欄位擋下來，
--   等於為了一個「加值功能」把既有的帳號維護流程卡死。
--
-- 【RLS：本檔不新增任何政策，這是刻意的】新欄位的存取完全由既有政策涵蓋：
--   * profiles_manage（db/19，is_admin()，for all）：副部長／行政管理部長
--     本來就能改 profiles 的任何欄位，含本欄。
--   * profiles_dept_head_staff（db/20，for update）：工務處長能改 staff 的列，
--     所以處長也能幫同仁填通知信箱——與他能改姓名／停用是同一個範圍。
--   * profiles_self（db/15，select：`id = auth.uid() or is_manager()`）：
--     一般同仁與醫院採購只讀得到自己那一列，讀不到別人的通知信箱。
--     這點很重要——通知信箱是個資，不能讓外部採購帳號把院內同仁的信箱撈走。
--   * profiles_password_flag_guard（db/23）：trigger 的 when 條件是
--     `old.must_change_password is distinct from new.must_change_password`，
--     只改 notify_email 不會觸發它，不會誤擋。
--   Edge Function 那一側走 service_role 繞過 RLS，本來就不受政策限制。
--
-- ⚠️ 部署順序（四步，順序不能顛倒）：
--   1. 本檔（先有欄位，Edge Function 才查得到）
--   2. npx supabase secrets set GMAIL_USER / GMAIL_APP_PASSWORD /
--      NOTIFY_HOOK_SECRET / APP_BASE_URL（值不進 repo，見 notify-approval/index.ts 檔頭）
--   3. npx supabase functions deploy notify-approval --no-verify-jwt
--   4. Supabase Dashboard → Database → Webhooks 建 quotes 表的 UPDATE webhook，
--      指到上一步的函式並加上 header `x-notify-secret`
--   webhook 若先建好而函式還沒上，每次改單都會在 pg_net 記一筆 404；
--   函式先上而 secrets 還沒設，selftest 會回 500 告訴你缺哪一個環境變數。
-- ═══════════════════════════════════════════════════════════════

-- ── 1. 欄位 ────────────────────────────────────────────────────
-- 預設空字串（不是 null）：讓 Edge Function 那側只要判斷「trim 後是不是空的」一種情況，
-- 不必同時處理 null 與 ''。既有帳號一律取得空字串＝在主管填之前不收信。
alter table profiles
  add column if not exists notify_email text not null default '';

comment on column profiles.notify_email is
  '簽核通知信的收件地址，由主管在帳號管理頁人工填寫。'
  '不能直接用登入帳號：內部同仁的登入身分是合成的 工號@dexin.local 假網域，寄不出去。'
  '空字串＝這個人不寄通知信（正常狀態，非錯誤）；停用帳號與醫院採購（procurement）'
  '即使填了也不會收到——採購不寄是 2026-09-14 的決策，第一版通知信只走內部。';

-- ── 2. 驗收 ────────────────────────────────────────────────────
-- 預期一列：notify_email / text / NO / ''::text
select column_name::text  as name,
       data_type::text    as type,
       is_nullable::text  as nullable,
       column_default::text as default_value
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'profiles'
   and column_name = 'notify_email';
