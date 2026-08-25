-- 工率基準：一個工（1 人 1 天 8 小時）能做多少量
--
-- 用途：報價單附上工率分析，讓醫院採購看得到工資怎麼算出來的——
--   應攤工資 = 數量 ÷ 工率 × 技術工日薪(2,800)
-- 這就是台灣工程界的「單價分析／工料分析」，比只給一個總價有說服力得多。

create table if not exists labor_productivity (
  id                 text primary key,
  trade              text not null,              -- 工種：電力配線／網路通訊／空調通風／裝修／拆除清運
  work_item          text not null,              -- 工項名稱
  unit               text not null,              -- 計量單位（米/處/點/m²/台…）
  output_per_manday  numeric not null check (output_per_manday > 0),  -- 一個工日的產出量
  crew               text not null default '技術工 1 名',
  basis              text not null default 'estimate'
                     check (basis in ('history', 'standard', 'estimate')),
  source             text not null default '',   -- 來源：報價單檔名／官方工料分析網址
  confidence         text not null default 'medium'
                     check (confidence in ('high', 'medium', 'low')),
  note               text not null default '',   -- 適用條件與限制
  active             boolean not null default true,
  sort               int not null default 0,
  updated_by         uuid references profiles(id),
  updated_at         timestamptz not null default now()
);

-- 品項對應到哪一筆工率（一個品項最多對一筆；沒對到就不做工率分析）
alter table price_items add column if not exists productivity_id text;
do $$ begin
  alter table price_items
    add constraint price_items_productivity_fkey
    foreign key (productivity_id) references labor_productivity(id) on delete set null;
exception when duplicate_object then null; end $$;

alter table labor_productivity enable row level security;

drop policy if exists productivity_read on labor_productivity;
create policy productivity_read on labor_productivity
  for select to authenticated using (true);

drop policy if exists productivity_write on labor_productivity;
create policy productivity_write on labor_productivity
  for all to authenticated using (is_manager()) with check (is_manager());

-- 便利查詢：某工項每單位應攤多少工資（日薪由 settings.labor_base_daily 決定）
create or replace function labor_cost_per_unit(p_id text)
returns numeric language sql stable security invoker set search_path = public as $$
  select round(
    (select (value #>> '{}')::numeric from settings where key = 'labor_base_daily')
    / lp.output_per_manday
  )
  from labor_productivity lp where lp.id = p_id;
$$;
