-- ═══════════════════════════════════════════════════════════════
-- 23_force_password_change.sql — 主管發出的帳號，本人第一次登入必須改密碼
--
-- 【要解決的事】建帳號時密碼欄留空＝密碼同工號。工號在院內不是秘密，
--   等於「知道某人工號的人」就能登入他的帳號讀走整份單價庫。
--   原本只能靠口頭提醒本人去改，沒有任何強制力。
--
-- 【作法】profiles 加一個旗標 must_change_password：
--   主管建帳號／重設密碼時設 true，本人改完密碼由伺服器端設回 false。
--   旗標為 true 期間，**資料庫層**就把業務資料全部關起來——不是只擋畫面。
--   實作上不改任何一條政策，只在五支判斷函式後面各加一個條件，
--   跟 db/19／db/21 是同一套手法。
--
-- 【為什麼不能只擋畫面】前端是 public repo 上的靜態網站。只擋畫面的話，
--   知道工號的人登入後打開 console 直接打 PostgREST 就讀得到單價庫，
--   等於這個功能只防得了不會按 F12 的人。
--
-- 【為什麼改密碼要走 Edge Function】旗標若由前端自己關掉（RPC 或直接 update），
--   一行 console 指令就能解鎖，而攻擊情境正好是「別人拿你的工號登入」。
--   改成伺服器端在同一支函式裡「驗 session → 改密碼 → 關旗標」，無法偽造。
--
-- 【適用範圍】使用者 2026-09-09 裁示：只管**以後新建**與**被主管重設密碼**的帳號。
--   欄位預設 false，既有帳號（含 016123、016125）不受影響、不會突然被鎖在門外。
--
-- ⚠️ 部署順序：本檔 → 前端（要有那個「請設定新密碼」畫面）→ deploy admin-users。
--   Edge Function 先上會在建帳號時寫一個還不存在的欄位而失敗；
--   前端沒上就先發新帳號，那個人會被鎖住卻看不到可以改密碼的畫面。
-- ═══════════════════════════════════════════════════════════════

-- ── 1. 旗標 ────────────────────────────────────────────────────
-- 預設 false：既有帳號一律不受影響（見上方「適用範圍」）。
alter table profiles
  add column if not exists must_change_password boolean not null default false;

comment on column profiles.must_change_password is
  '主管發出的初始／重設密碼尚未被本人更換。為 true 時所有身分判斷函式一律回 false，'
  '等於在資料庫層關掉全部業務資料，只留 profiles_self 讓他讀得到自己這一列。';

-- ── 2. 五支判斷函式各加一個條件 ────────────────────────────────
-- 政策一條都不動——這些函式就是所有政策的共同入口。
-- 注意 profiles_self（db/15）是 `id = auth.uid() or is_manager()`，
-- 第一段不經過這些函式，所以被鎖住的人仍讀得到自己那一列，
-- 前端才有辦法知道「你要改密碼」。這是刻意保留的唯一一條縫。

create or replace function is_active_user() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and active and not must_change_password
  );
$$;

create or replace function is_manager() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and active and not must_change_password
      and role in ('manager', 'dept_head', 'admin_head')
  );
$$;

create or replace function is_admin() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and active and not must_change_password
      and role in ('manager', 'admin_head')
  );
$$;

create or replace function is_dept_head() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and active and not must_change_password
      and role = 'dept_head'
  );
$$;

create or replace function is_price_editor() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and active and not must_change_password
      and role in ('manager', 'dept_head')
  );
$$;

create or replace function is_internal() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and active and not must_change_password
      and role in ('staff', 'dept_head', 'manager', 'admin_head')
  );
$$;

create or replace function is_procurement() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and active and not must_change_password
      and role = 'procurement'
  );
$$;

-- ── 3. 誰都不准自己把旗標關掉 ──────────────────────────────────
-- profiles 的寫入政策本來就只開給 is_admin()（db/19 的 profiles_manage）與
-- 處長的 staff 範圍（db/20），本人沒有自己 update 自己的政策，所以「自己關旗標」
-- 這條路在政策層本來就不通。但主管是**改得動**的——加一支 trigger 讓
-- 「把別人的旗標從 true 改成 false」只能由 Edge Function 的 service_role 做，
-- 避免有人用主管帳號在人員權限頁幫別人「跳過」改密碼。
create or replace function guard_password_flag() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.must_change_password and not new.must_change_password
     and auth.uid() is not null then
    raise exception '「待改密碼」只能由本人改完密碼後由系統解除，不能在人員權限頁直接關掉'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists profiles_password_flag_guard on profiles;
create trigger profiles_password_flag_guard before update on profiles
  for each row when (old.must_change_password is distinct from new.must_change_password)
  execute function guard_password_flag();

-- ── 4. 驗收 ────────────────────────────────────────────────────
select 'column' as kind, column_name::text as name,
       column_default::text as detail
  from information_schema.columns
 where table_name = 'profiles' and column_name = 'must_change_password'
union all
select 'function', p.proname::text,
       case when pg_get_functiondef(p.oid) like '%must_change_password%'
            then '已加入旗標條件' else '✗ 沒有旗標條件' end
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('is_active_user', 'is_manager', 'is_admin', 'is_dept_head',
                     'is_price_editor', 'is_internal', 'is_procurement')
union all
select 'trigger', tgname::text, '已建立'
  from pg_trigger where tgname = 'profiles_password_flag_guard'
 order by 1, 2;
