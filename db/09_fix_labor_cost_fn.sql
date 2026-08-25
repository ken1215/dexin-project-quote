-- 修正：labor_cost_per_unit() 原本只算成本，沒乘加成係數，
-- 會跟報價單上印出來的「應攤工資」差 15%。
-- 這支函式目前前端沒用到，但留著遲早有人拿去對帳。
create or replace function labor_cost_per_unit(p_id text)
returns numeric language sql stable security invoker set search_path = public as $$
  select round(
    (select (value #>> '{}')::numeric from settings where key = 'labor_base_daily')
    * coalesce((select (value #>> '{}')::numeric from settings where key = 'labor_markup'), 1)
    / lp.output_per_manday
  )
  from labor_productivity lp where lp.id = p_id;
$$;

-- 驗證：任取一筆工率，函式結果應等於 round(2800 * 1.15 / 工率)
select lp.work_item, lp.output_per_manday,
       labor_cost_per_unit(lp.id) as fn_result,
       round(2800 * 1.15 / lp.output_per_manday) as expected
  from labor_productivity lp
 order by lp.sort limit 3;
