-- 讓主管可以刪除單價品項，而不會破壞已開出去的報價單
--
-- quote_lines 已經把 name/spec/unit/unit_price 複製一份存下來（報價當下的快照），
-- item_id 只是「這行當初是從哪個標準品項來的」的參照。所以品項被刪掉時，
-- 把 item_id 設成 null 即可——歷史報價單的內容與金額完全不受影響，
-- 只是失去「連回單價庫」的線索。這比 (a) 擋住刪除 或 (b) 連帶刪掉單據明細 都合理。

alter table quote_lines drop constraint if exists quote_lines_item_id_fkey;
alter table quote_lines
  add constraint quote_lines_item_id_fkey
  foreign key (item_id) references price_items(id) on delete set null;

-- 議價紀錄不直接參照品項，不用處理。
-- price_floors / price_history 原本就是 on delete cascade，跟著品項一起消失是對的。

-- 給主管用的查詢：某個品項被幾張報價單用過（刪除前的影響評估）
create or replace function item_usage(p_item_id text)
returns table (quote_count bigint, line_count bigint)
language sql security invoker stable set search_path = public as $$
  select count(distinct quote_id), count(*)
    from quote_lines where item_id = p_item_id;
$$;
