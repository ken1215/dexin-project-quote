-- ═══════════════════════════════════════════════════════════════
-- 15_procurement_role.sql — 新增「醫院採購」角色
--
-- 這批帳號是**對方的人**（聯新國際醫院採購單位），不是自家同事。
-- 權限設計的第一原則：他們只看得到「我方已經正式送出去給他們的東西」，
-- 其餘一律不可見。以下是刻意擋掉的，每一項都有理由：
--
--   price_floors      底價——議價底牌，看到就沒得談了
--   price_items       整份單價庫（206 項）——對方沒有理由瀏覽我方全部品項與標準價；
--                     他們該看到的只有「這張報價單上的那幾行」，而 quote_lines 已經有了
--   price_history     調價軌跡——我方何時把什麼價調過，等於營運資訊
--   evidence_sources  佐證來源本身無妨，但 evidence_note 內含內部推導與歷史成交區間
--   labor_productivity 工率基準與其 source/note——報價單上印出來的是摘要，原始表不必給
--   material_indices  物價指數維護資料
--   settings 的 quote_stamp  ★ 公司報價專用章的圖檔，給了等於把章交出去
--   settings 的 labor_base_daily / labor_discount  牌價與折數結構
--
-- 他們拿得到的：自己收到的報價單（已核可之後）、單據明細、議價往返紀錄，
-- 以及計算總價需要的稅率與管理費率（那兩個本來就印在報價單上）。
--
-- 能做的事：逐項登錄還價與理由。**不能定案**——定案會把金額寫回報價單，
-- 那是我方的決定，只有主管能按。
-- ═══════════════════════════════════════════════════════════════

-- ── 1. 角色從 enum 改成 text + check（enum 加值在交易中很難處理，且日後好擴充）──
alter table profiles alter column role drop default;
alter table profiles alter column role type text using role::text;
alter table profiles alter column role set default 'staff';
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('staff', 'manager', 'procurement'));

-- ── 2. 判斷函式 ────────────────────────────────────────────────
create or replace function is_procurement() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'procurement' and active
  );
$$;

/** 自家人（同仁或主管）——參考資料只開給這些人，醫院採購看不到 */
create or replace function is_internal() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and active and role in ('staff', 'manager')
  );
$$;

-- ── 3. 參考資料：收斂成「只有自家人可讀」──────────────────────
do $$
declare t text;
begin
  foreach t in array array['categories','evidence_sources','material_indices',
                           'price_items','labor_rates','labor_productivity'] loop
    execute format('drop policy if exists %I_read on %I', t, t);
    execute format('create policy %I_read on %I for select to authenticated
                    using (is_internal())', t, t);
  end loop;
end $$;

-- settings 是 key-value，可以逐列開放：只把「報價單上本來就印得出來的」給對方
drop policy if exists settings_read on settings;
create policy settings_read on settings for select to authenticated
  using (
    is_internal()
    or (is_procurement() and key in ('mgmt_fee_rate', 'tax_rate', 'company', 'client', 'catalog_version'))
  );

-- ── 4. 報價單：採購只看得到「已正式送出」之後的單 ──────────────
drop policy if exists quotes_read on quotes;
create policy quotes_read on quotes for select to authenticated
  using (
    created_by = auth.uid()
    or is_manager()
    or (is_procurement() and status in ('approved', 'negotiating', 'closed'))
  );

-- 子表跟著母單的可見性走
do $$
declare t text;
begin
  foreach t in array array['quote_sections','quote_lines'] loop
    execute format('drop policy if exists %I_select on %I', t, t);
    execute format($f$create policy %I_select on %I for select to authenticated
      using (exists (select 1 from quotes q where q.id = quote_id
             and (q.created_by = auth.uid() or is_manager()
                  or (is_procurement() and q.status in ('approved','negotiating','closed')))))$f$, t, t);
  end loop;
end $$;

-- 採購絕不能改單據內容（沒有 insert/update/delete 政策 = 一律拒絕）

-- ── 5. 議價：採購可讀、可新增自己的還價，但不能改別人的、不能刪 ──
drop policy if exists nego_read on negotiations;
create policy nego_read on negotiations for select to authenticated
  using (exists (select 1 from quotes q where q.id = quote_id
         and (q.created_by = auth.uid() or is_manager()
              or (is_procurement() and q.status in ('approved','negotiating','closed')))));

drop policy if exists nego_write on negotiations;
create policy nego_manager_write on negotiations for all to authenticated
  using (is_manager()) with check (is_manager());

drop policy if exists nego_procurement_insert on negotiations;
create policy nego_procurement_insert on negotiations for insert to authenticated
  with check (
    is_procurement()
    and responded_by = auth.uid()
    and exists (select 1 from quotes q where q.id = quote_id
                and q.status in ('approved', 'negotiating'))
  );

-- 採購送出的列，強制清掉「我方回應」欄位——那是我方的決定，不是對方能填的。
-- RLS 沒有欄位級權限，所以用 trigger 兜。
create or replace function guard_negotiation_fields() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if is_procurement() then
    new.response := null;      -- 接受/部分讓步/堅持 是我方的判斷
    new.final_price := null;   -- 定案價只有主管能給
    new.responded_by := auth.uid();
  end if;
  return new;
end $$;

drop trigger if exists negotiations_guard on negotiations;
create trigger negotiations_guard before insert or update on negotiations
  for each row execute function guard_negotiation_fields();

-- ── 6. profiles：採購只看得到自己 ──────────────────────────────
drop policy if exists profiles_self on profiles;
create policy profiles_self on profiles for select to authenticated
  using (id = auth.uid() or is_manager());

-- ── 7. 驗證 ────────────────────────────────────────────────────
select 'role check' as item, pg_get_constraintdef(oid) as detail
  from pg_constraint where conname = 'profiles_role_check';
