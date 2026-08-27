-- ═══════════════════════════════════════════════════════════════
-- 19_two_stage_approval.sql — 兩階段簽核 ＋ 工號登入
--
-- 【簽核】原本一關（同仁送審 → 主管核可）改為兩關：
--     同仁草稿 → submitted（送審）
--       → 工務處長核可 → approved_l1
--         → 行政管理部副部長核定 → approved（此時才送得到醫院採購）
--   退回一律回到 draft 線（沿用既有 rejected 狀態，存檔時自動回草稿）。
--   副部長可越級：submitted 直接核定為 approved（處長請假不卡單），系統留痕。
--
-- 【角色】新增 dept_head（工務處長）。權限＝簽核第一關 ＋ 單價庫／物價指數維護，
--   但**不能**管帳號、**不能**議價定案。
--   作法上不重寫二十幾條既有政策，而是把 is_manager() 的語意擴大為
--   「核決層（處長或副部長）」，再新增 is_admin()＝「最終核決（副部長）」
--   套在那兩個必須排除處長的地方。
--
-- 【狀態轉換】不靠前端也不靠 RLS 的 with check（看不到 OLD 值），
--   改用 BEFORE UPDATE trigger 統一把關並蓋核可戳記——
--   前端傳什麼進來都一樣，違規的轉換直接 raise。
--
-- 【工號登入】登入身分改用 6 碼工號，實作為合成 email `工號@dexin.local`
--   （已實測 GoTrue 接受此網域與 6 碼密碼）。資料庫層完全不受影響——
--   所有 RLS 都認 auth.uid()，沒有一條認 email。本檔只放角色與流程。
-- ═══════════════════════════════════════════════════════════════

-- ── 1. 角色與狀態的合法值 ──────────────────────────────────────
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('staff', 'dept_head', 'manager', 'procurement'));

alter table quotes drop constraint if exists quotes_status_check;
alter table quotes add constraint quotes_status_check
  check (status in ('draft','submitted','approved_l1','approved','negotiating','closed','rejected'));

-- 第一關的核可戳記（第二關沿用既有 approved_by / approved_at）
alter table quotes add column if not exists approved_l1_by uuid references profiles(id);
alter table quotes add column if not exists approved_l1_at timestamptz;
-- 副部長越過第一關直接核定時記 true，報價單與清單上要看得出來
alter table quotes add column if not exists l1_skipped boolean not null default false;

-- ── 2. 身分判斷函式 ────────────────────────────────────────────
-- 最終核決＝行政管理部副部長。帳號管理與議價定案只認這個。
create or replace function is_admin() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role = 'manager' and active
  );
$$;

-- 工務處長（簽核第一關）
create or replace function is_dept_head() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role = 'dept_head' and active
  );
$$;

-- ⚠️ 語意變更：is_manager() 從「主管」擴大為「核決層（處長或副部長）」。
-- 既有政策一律沿用它，處長因此自動取得單價庫、物價指數、看得到底價與全部單據。
-- 需要排除處長的地方改掛 is_admin()（見下方第 4 節）。
create or replace function is_manager() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role in ('manager', 'dept_head') and active
  );
$$;

-- 自家人：加入處長，否則處長會被當成醫院採購擋在門外
create or replace function is_internal() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and active and role in ('staff', 'dept_head', 'manager')
  );
$$;

-- ── 3. 狀態轉換把關 ────────────────────────────────────────────
-- 只管 status 有變動的那一次 update；同狀態下的內容編輯照舊由 RLS 管。
create or replace function enforce_quote_transition() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  owner   boolean := old.created_by = auth.uid();
  head    boolean := is_dept_head();
  admin   boolean := is_admin();
  ok      boolean := false;
begin
  if new.status = old.status then
    return new;
  end if;

  case old.status || '->' || new.status
    -- 送審（含退回後修正重送）
    when 'draft->submitted',   'rejected->submitted' then ok := owner or admin;
    -- 退回後回到草稿：前端存檔時自動做，建立者自己來
    when 'rejected->draft' then ok := owner or admin;
    -- 第一關
    when 'submitted->approved_l1' then
      ok := head or admin;
      if ok then
        new.approved_l1_by := auth.uid();
        new.approved_l1_at := now();
      end if;
    when 'submitted->rejected' then ok := head or admin;
    -- 第二關
    when 'approved_l1->approved' then
      ok := admin;
      if ok then
        new.approved_by := auth.uid();
        new.approved_at := now();
      end if;
    when 'approved_l1->rejected' then ok := admin;
    -- 越級核定：處長請假時副部長直接放行，留痕給稽核看
    when 'submitted->approved' then
      ok := admin;
      if ok then
        new.approved_by := auth.uid();
        new.approved_at := now();
        new.l1_skipped  := true;
      end if;
    -- 核定之後的議價與定案：只有副部長
    when 'approved->negotiating', 'approved->closed',
         'negotiating->closed',   'negotiating->approved' then ok := admin;
    -- 定案後要重啟只能由副部長退回
    when 'closed->negotiating', 'approved->rejected' then ok := admin;
    else ok := false;
  end case;

  if not ok then
    raise exception '不允許的簽核動作：% → %（權限不足或流程順序不對）', old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists quotes_transition_guard on quotes;
create trigger quotes_transition_guard before update on quotes
  for each row when (old.status is distinct from new.status)
  execute function enforce_quote_transition();

-- ── 4. 必須排除處長的兩件事 ────────────────────────────────────
-- (a) 帳號管理：profiles 的寫入只留副部長（Edge Function 另有一道同樣的檢查）。
--     讀取不受影響——處長仍靠 profiles_self 的 is_manager() 看得到建立人姓名。
drop policy if exists profiles_manage on profiles;
create policy profiles_manage on profiles for all to authenticated
  using (is_admin()) with check (is_admin());

-- (b) 議價定案：會把金額寫回報價單，不可逆，只留副部長
--     （政策名在 db/15 已由 nego_write 改為 nego_manager_write，兩個名字都清一次）
drop policy if exists nego_write on negotiations;
drop policy if exists nego_manager_write on negotiations;
create policy nego_manager_write on negotiations for all to authenticated
  using (is_admin()) with check (is_admin());

-- ── 5. 醫院採購看得到的單據：approved 以後才算數（沿用既有定義） ──
-- approved_l1 是內部關卡，對方不得看見。既有政策列的是
-- ('approved','negotiating','closed')，不含 approved_l1，因此不必改動。

-- ── 6. 驗收 ────────────────────────────────────────────────────
select 'role check'   as item, pg_get_constraintdef(oid) as detail
  from pg_constraint where conname = 'profiles_role_check'
union all
select 'status check', pg_get_constraintdef(oid)
  from pg_constraint where conname = 'quotes_status_check'
union all
select 'trigger', tgname from pg_trigger where tgname = 'quotes_transition_guard';

-- ── 7. 補：刪單是不可逆的，不隨 is_manager() 一起放給處長 ────────
-- （這條原本掛 is_manager()，語意擴大後處長會連帶取得刪單權；收回到副部長。）
drop policy if exists quotes_delete on quotes;
create policy quotes_delete on quotes for delete to authenticated
  using (is_admin() or (created_by = auth.uid() and status = 'draft'));

select 'quotes_delete' as item, pg_get_expr(polqual, polrelid) as detail
  from pg_policy where polname = 'quotes_delete';
