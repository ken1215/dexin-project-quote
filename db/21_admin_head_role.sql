-- ═══════════════════════════════════════════════════════════════
-- 21_admin_head_role.sql — 新增「行政管理部長」角色 admin_head
--
-- 【定位】權限等同行政管理部副部長（manager）——第二關核定、越級核定、
--   議價定案、刪單、管理所有角色的帳號——**唯一的差別是單價維護只能看不能改**。
--
-- 【作法】沿用 db/19 的手法：不重寫二十幾條政策，改動判斷函式的語意。
--   is_admin()   ＝ 最終核決層 → 擴大為 manager + admin_head（部長因此拿到副部長的全部）
--   is_manager() ＝ 核決層（看得到底價、全部單據、單價庫）→ 也加入 admin_head
--   新增 is_price_editor() ＝ 單價「可寫」的人（manager + dept_head），
--   只把單價相關資料表的**寫入**政策從 is_manager() 換成它。讀取不動。
--
-- 【鎖住的範圍】不只單價庫本身，而是整組計價基礎：
--   price_items（標準單價）、price_floors（底價）、material_indices（物價指數）、
--   labor_rates ＋ labor_productivity（工資與工率）、settings（日薪／管理費／稅率）、
--   categories、evidence_sources。理由是這些數字最後都會變成報價金額，
--   只鎖單價庫、放行物價指數等於沒鎖。
--
-- ⚠️ 已知且刻意不擋：部長能管所有帳號，理論上可以把自己的角色改成 manager
--   而取得單價寫入權。部長本來就大於副部長，這裡的唯讀是「避免誤改」的護欄，
--   不是防範部長本人的資安邊界。真要硬擋，另加一條禁止任何人更改自己 role 的
--   trigger 即可（目前未加）。
-- ═══════════════════════════════════════════════════════════════

-- ── 1. 角色合法值 ──────────────────────────────────────────────
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('staff', 'dept_head', 'manager', 'admin_head', 'procurement'));

-- ── 2. 判斷函式 ────────────────────────────────────────────────
-- 最終核決：副部長與部長。帳號管理、議價定案、刪單、第二關核定都認這個。
create or replace function is_admin() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role in ('manager', 'admin_head') and active
  );
$$;

-- 核決層（處長／副部長／部長）：看得到底價、全部單據、單價庫
create or replace function is_manager() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role in ('manager', 'dept_head', 'admin_head') and active
  );
$$;

-- 自家人：不加會被當成醫院採購擋在門外
create or replace function is_internal() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and active
      and role in ('staff', 'dept_head', 'manager', 'admin_head')
  );
$$;

-- 新增：能改單價的人＝副部長與工務處長。部長不在內。
create or replace function is_price_editor() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role in ('manager', 'dept_head') and active
  );
$$;

-- ── 3. 計價基礎的寫入改掛 is_price_editor() ────────────────────
-- 這些表都另有 _read 政策（db/01 的 using(true)、db/15 的 settings_read），
-- 政策是 OR 的，所以只換 _write 不影響任何人的讀取。
do $$
declare t text;
begin
  foreach t in array array['categories','evidence_sources','material_indices',
                           'price_items','labor_rates','settings'] loop
    execute format('drop policy if exists %I_write on %I', t, t);
    execute format('create policy %I_write on %I for all to authenticated
                    using (is_price_editor()) with check (is_price_editor())', t, t);
  end loop;
end $$;

drop policy if exists productivity_write on labor_productivity;
create policy productivity_write on labor_productivity
  for all to authenticated using (is_price_editor()) with check (is_price_editor());

-- ⚠️ price_floors 與上面那幾張表不同：它只有 floors_manager 一條 for all，
--   沒有獨立的 _read。直接把它換成 is_price_editor() 會連「部長看得到底價」
--   一起收掉，所以要拆成讀、寫兩條。
drop policy if exists floors_manager on price_floors;
drop policy if exists floors_read on price_floors;
create policy floors_read on price_floors for select to authenticated
  using (is_manager());
drop policy if exists floors_write on price_floors;
create policy floors_write on price_floors for all to authenticated
  using (is_price_editor()) with check (is_price_editor());
-- price_history 本來就只有 select（history_manager），不必動。

-- ── 4. 驗收 ────────────────────────────────────────────────────
select 'role check' as item, pg_get_constraintdef(oid) as detail
  from pg_constraint where conname = 'profiles_role_check'
union all
select 'policy: ' || polname,
       coalesce(pg_get_expr(polqual, polrelid), '(no using)')
  from pg_policy
  where polname in ('price_items_write','settings_write','productivity_write',
                    'floors_read','floors_write');
