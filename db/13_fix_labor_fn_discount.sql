-- 工資單價計算改用折扣（原本乘的是 labor_markup，已不存在）
create or replace function labor_cost_per_unit(p_id text)
returns numeric language sql stable security invoker set search_path = public as $$
  select round(
    (select (value #>> '{}')::numeric from settings where key = 'labor_base_daily')
    * coalesce((select (value #>> '{}')::numeric from settings where key = 'labor_discount'), 1)
    / lp.output_per_manday
  )
  from labor_productivity lp where lp.id = p_id;
$$;
select lp.work_item, lp.output_per_manday, labor_cost_per_unit(lp.id) fn,
       round(3000 * 0.9 / lp.output_per_manday) expected
  from labor_productivity lp order by lp.sort limit 3;
