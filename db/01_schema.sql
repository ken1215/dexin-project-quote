-- ═══════════════════════════════════════════════════════════════
-- 德新物業(立德新)專案工程報價系統 — Supabase schema
-- 在 Supabase → SQL Editor 貼上執行（可重複執行）
-- ═══════════════════════════════════════════════════════════════

-- ── 角色 ──────────────────────────────────────────────────────
do $$ begin
  create type user_role as enum ('staff', 'manager');
exception when duplicate_object then null; end $$;

create table if not exists profiles (
  id          uuid primary key references auth.users on delete cascade,
  full_name   text not null default '',
  role        user_role not null default 'staff',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- 新註冊者自動建 profile（預設同仁，需主管改成 manager）
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- 判斷目前使用者是否為主管（供 RLS 使用，security definer 避免遞迴）
create or replace function is_manager() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role = 'manager' and active
  );
$$;

-- ── 佐證來源 ──────────────────────────────────────────────────
-- kind: index 官方指數 / law 法規 / market 市場行情 / history 自家歷史成交
create table if not exists evidence_sources (
  id         text primary key,
  kind       text not null check (kind in ('index','law','market','history')),
  name       text not null,
  publisher  text not null default '',
  url        text not null default '',
  note       text not null default ''
);

-- ── 原物料／工資指數（主管每月更新一次） ──────────────────────
create table if not exists material_indices (
  id            text primary key,
  name          text not null,
  source_id     text references evidence_sources(id),
  unit          text not null default '',
  base_period   text not null default '',   -- 基準期別（例：110年=100 或 2026-01）
  base_value    numeric not null default 100,
  period        text not null default '',   -- 現值期別
  value         numeric not null default 100,
  updated_by    uuid references profiles(id),
  updated_at    timestamptz not null default now()
);

-- ── 分類（section_title = 加入品項時自動帶入的工程大項名稱） ───
create table if not exists categories (
  id            text primary key,
  name          text not null,
  section_title text not null,
  sort          int not null default 0
);

-- ── 標準單價目錄 ──────────────────────────────────────────────
create table if not exists price_items (
  id             text primary key,
  category_id    text not null references categories(id),
  name           text not null,
  spec           text not null default '',
  unit           text not null,
  cost_type      text not null default 'material'
                 check (cost_type in ('material','consumable','labor','other')),
  std_price      numeric not null check (std_price >= 0),
  evidence_id    text references evidence_sources(id),
  evidence_note  text not null default '',
  index_id       text references material_indices(id),
  index_coeff    numeric not null default 0 check (index_coeff between 0 and 1),
  price_min      numeric, price_max numeric, price_median numeric,
  samples        int not null default 0,
  last_seen      text not null default '',
  last_price     numeric,
  needs_area     boolean not null default false,  -- 應改以面積計價但歷史為「式」
  active         boolean not null default true,
  sort           int not null default 0,
  updated_by     uuid references profiles(id),
  updated_at     timestamptz not null default now()
);
create index if not exists price_items_cat_idx on price_items(category_id) where active;

-- 底價：獨立表，RLS 只開給主管（Postgres RLS 無欄位級權限，故拆表）
create table if not exists price_floors (
  item_id     text primary key references price_items(id) on delete cascade,
  floor_price numeric not null check (floor_price >= 0),
  note        text not null default '',
  updated_by  uuid references profiles(id),
  updated_at  timestamptz not null default now()
);

-- 調價軌跡（誰、何時、從多少改到多少、為什麼）
create table if not exists price_history (
  id         bigserial primary key,
  item_id    text not null references price_items(id) on delete cascade,
  old_price  numeric,
  new_price  numeric not null,
  reason     text not null default '',
  changed_by uuid references profiles(id),
  changed_at timestamptz not null default now()
);

create or replace function log_price_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.std_price is distinct from old.std_price then
    insert into price_history (item_id, old_price, new_price, changed_by)
    values (new.id, old.std_price, new.std_price, auth.uid());
  end if;
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end $$;

drop trigger if exists price_items_audit on price_items;
create trigger price_items_audit before update on price_items
  for each row execute function log_price_change();

-- ── 工資時段加成（勞基法係數，主管可調） ──────────────────────
create table if not exists labor_rates (
  id          text primary key,
  name        text not null,
  multiplier  numeric not null check (multiplier > 0),
  legal_basis text not null default '',
  sort        int not null default 0,
  active      boolean not null default true
);

-- ── 系統參數（管理費率／稅率／工班日薪／版本） ────────────────
create table if not exists settings (
  key        text primary key,
  value      jsonb not null,
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now()
);

-- ── 報價單 ────────────────────────────────────────────────────
create table if not exists quotes (
  id            uuid primary key default gen_random_uuid(),
  quote_no      text unique not null,
  project       text not null,
  dept          text not null default '',
  contact       text not null default '',
  quote_date    date not null default current_date,
  status        text not null default 'draft'
                check (status in ('draft','submitted','approved','negotiating','closed','rejected')),
  mgmt_fee_rate numeric not null default 0.09,
  tax_rate      numeric not null default 0.05,
  created_by    uuid not null references profiles(id) default auth.uid(),
  approved_by   uuid references profiles(id),
  approved_at   timestamptz,
  review_note   text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists quotes_creator_idx on quotes(created_by, created_at desc);

create table if not exists quote_sections (
  id       uuid primary key default gen_random_uuid(),
  quote_id uuid not null references quotes(id) on delete cascade,
  title    text not null,
  sort     int not null default 0
);

create table if not exists quote_lines (
  id            uuid primary key default gen_random_uuid(),
  quote_id      uuid not null references quotes(id) on delete cascade,
  section_id    uuid not null references quote_sections(id) on delete cascade,
  item_id       text references price_items(id),
  labor_rate_id text references labor_rates(id),
  name          text not null,
  spec          text not null default '',
  unit          text not null,
  unit_price    numeric not null check (unit_price >= 0),
  qty           numeric not null check (qty > 0),
  is_custom     boolean not null default false,
  reason        text not null default '',   -- 臨時項目必填
  note          text not null default '',
  sort          int not null default 0
);
create index if not exists quote_lines_quote_idx on quote_lines(quote_id);

-- 臨時項目必須有理由（資料庫層強制，不靠前端）
alter table quote_lines drop constraint if exists quote_lines_custom_reason;
alter table quote_lines add constraint quote_lines_custom_reason
  check (not is_custom or length(btrim(reason)) > 0);

-- ── 議價往返（逐項還價 → 我方回應 → 定案） ────────────────────
create table if not exists negotiations (
  id           uuid primary key default gen_random_uuid(),
  quote_id     uuid not null references quotes(id) on delete cascade,
  line_id      uuid references quote_lines(id) on delete cascade,
  round        int not null default 1,
  client_offer numeric,                    -- 院方還價（單價；line_id 為 null 時視為總價）
  response     text check (response in ('accept','partial','hold')),
  final_price  numeric,
  rationale    text not null default '',   -- 我方理由（引用佐證）
  responded_by uuid references profiles(id),
  responded_at timestamptz not null default now()
);
create index if not exists negotiations_quote_idx on negotiations(quote_id, round);

-- ═══════════════════════════════════════════════════════════════
-- RLS：同仁看得到標準價與自己的單；主管管全部與底價
-- ═══════════════════════════════════════════════════════════════
alter table profiles          enable row level security;
alter table categories        enable row level security;
alter table evidence_sources  enable row level security;
alter table material_indices  enable row level security;
alter table price_items       enable row level security;
alter table price_floors      enable row level security;
alter table price_history     enable row level security;
alter table labor_rates       enable row level security;
alter table settings          enable row level security;
alter table quotes            enable row level security;
alter table quote_sections    enable row level security;
alter table quote_lines       enable row level security;
alter table negotiations      enable row level security;

-- profiles：看自己；主管看全部並可改角色
drop policy if exists profiles_self on profiles;
create policy profiles_self on profiles for select to authenticated
  using (id = auth.uid() or is_manager());
drop policy if exists profiles_manage on profiles;
create policy profiles_manage on profiles for all to authenticated
  using (is_manager()) with check (is_manager());

-- 參考資料：登入者皆可讀，只有主管可寫
do $$
declare t text;
begin
  foreach t in array array['categories','evidence_sources','material_indices',
                           'price_items','labor_rates','settings'] loop
    execute format('drop policy if exists %I_read on %I', t, t);
    execute format('create policy %I_read on %I for select to authenticated using (true)', t, t);
    execute format('drop policy if exists %I_write on %I', t, t);
    execute format('create policy %I_write on %I for all to authenticated
                    using (is_manager()) with check (is_manager())', t, t);
  end loop;
end $$;

-- 底價／調價軌跡：只有主管看得到
drop policy if exists floors_manager on price_floors;
create policy floors_manager on price_floors for all to authenticated
  using (is_manager()) with check (is_manager());
drop policy if exists history_manager on price_history;
create policy history_manager on price_history for select to authenticated
  using (is_manager());

-- 報價單：同仁只碰自己的；草稿以外不可再改（送審後鎖定）；主管全部
drop policy if exists quotes_read on quotes;
create policy quotes_read on quotes for select to authenticated
  using (created_by = auth.uid() or is_manager());
drop policy if exists quotes_insert on quotes;
create policy quotes_insert on quotes for insert to authenticated
  with check (created_by = auth.uid());
drop policy if exists quotes_update on quotes;
create policy quotes_update on quotes for update to authenticated
  using (is_manager() or (created_by = auth.uid() and status = 'draft'))
  with check (is_manager() or (created_by = auth.uid() and status in ('draft','submitted')));
drop policy if exists quotes_delete on quotes;
create policy quotes_delete on quotes for delete to authenticated
  using (is_manager() or (created_by = auth.uid() and status = 'draft'));

-- 單據子表：跟著母單的權限走
do $$
declare t text;
begin
  foreach t in array array['quote_sections','quote_lines'] loop
    execute format('drop policy if exists %I_all on %I', t, t);
    execute format($f$create policy %I_all on %I for all to authenticated
      using (exists (select 1 from quotes q where q.id = quote_id
             and (q.created_by = auth.uid() or is_manager())))
      with check (exists (select 1 from quotes q where q.id = quote_id
             and (is_manager() or (q.created_by = auth.uid() and q.status = 'draft'))))$f$, t, t);
  end loop;
end $$;

-- 議價：同仁看得到自己單的紀錄，只有主管能寫
drop policy if exists nego_read on negotiations;
create policy nego_read on negotiations for select to authenticated
  using (exists (select 1 from quotes q where q.id = quote_id
         and (q.created_by = auth.uid() or is_manager())));
drop policy if exists nego_write on negotiations;
create policy nego_write on negotiations for all to authenticated
  using (is_manager()) with check (is_manager());

-- ── 單號產生器：DX-YYYYMM-nnn ──────────────────────────────────
create or replace function next_quote_no() returns text
language plpgsql security definer set search_path = public as $$
declare p text := 'DX-' || to_char(now(), 'YYYYMM'); n int;
begin
  -- 取當月既有最大流水號 + 1，不能用 count()：刪過單就會產生重號撞上 unique
  select coalesce(max(nullif(regexp_replace(quote_no, '^.*-', ''), '')::int), 0) + 1
    into n from quotes where quote_no like p || '-%';
  return p || '-' || lpad(n::text, 3, '0');
end $$;
