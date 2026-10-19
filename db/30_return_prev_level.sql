-- ═══════════════════════════════════════════════════════════════
-- 30_return_prev_level.sql — 已核定的單由副部長「退回上一層級」
--
-- 【為什麼要有這支】使用者 2026-10-19 要求：核定後可以退回上一層，
--   只有副部長（role='manager'，is_vice_director()）能做，部長不行。
--   既有的 approved→rejected 是整單打回草稿重跑兩關；這支只退一層：
--     正常兩關核定的單  approved → approved_l1（回到「待副部長核定」）
--     越級核定的單      approved → submitted  （沒有第一關可回，退到「待處長核可」）
--   退回要寫理由（沿用 review_note），returned_at 記退回時間，畫面靠它顯示退回意見。
--   定案（closed）不在範圍內：db/29 已刻意不給定案單重開路徑。
--
-- 【作法】比照 db/29：enforce_quote_transition 整支重建最終版，trigger 不重掛。
--   相對 db/29 只多兩個分支，及「每次狀態異動先清 returned_at」一行。
-- ═══════════════════════════════════════════════════════════════

alter table quotes add column if not exists returned_at timestamptz;
-- ponytail: returned_at 只用來決定畫面要不要顯示退回意見，不涉金額或權限，故未加進 enforce_quote_immutable

create or replace function enforce_quote_transition() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  owner    boolean := (old.created_by = auth.uid()) and is_active_user();
  head     boolean := is_dept_head();
  admin    boolean := is_admin();
  vice     boolean := is_vice_director();
  ok       boolean := false;
  zero_cnt int;
begin
  if new.status = old.status then
    return new;
  end if;

  new.returned_at := null;   -- 只有下方兩個退回分支會重新蓋上

  case old.status || '->' || new.status
    -- 送審（含退回後修正重送）
    when 'draft->submitted',   'rejected->submitted' then
      ok := owner or admin;
      if ok then
        -- ⚠️ 依賴前端 persist() 的順序：明細必須在改狀態**之前**就寫進資料庫（見 db/22）。
        select count(*) into zero_cnt from quote_lines
         where quote_id = new.id and unit_price <= 0 and btrim(reason) = '';
        if zero_cnt > 0 then
          raise exception '有 % 項明細單價為 0 元且未填理由，請在理由欄註明（贈送／業主自購／待報價）後再送審', zero_cnt
            using errcode = 'check_violation';
        end if;
      end if;
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
        new.l1_skipped  := false;   -- 走完整兩關，清掉可能殘留的越級註記
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
    -- 退回上一層級（db/30）：只有副部長；正常核定退一關，越級核定退回處長
    when 'approved->approved_l1' then
      ok := vice and not old.l1_skipped;
      if ok then
        new.approved_by := null;
        new.approved_at := null;
        new.returned_at := now();
      end if;
    when 'approved->submitted' then
      ok := vice and old.l1_skipped;
      if ok then
        new.approved_by := null;
        new.approved_at := null;
        new.l1_skipped  := false;
        new.returned_at := now();
      end if;
    -- 減價定案：只有副部長（2026-10-06 起部長不能定案）
    when 'approved->closed', 'negotiating->closed' then ok := vice;
    -- 舊制議價中的出口：拉回已核定，仍給核決層
    when 'negotiating->approved' then ok := admin;
    when 'approved->rejected' then ok := admin;
    else ok := false;
  end case;

  if not ok then
    raise exception '不允許的簽核動作：% → %（權限不足或流程順序不對）', old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- 驗收
select 'returned_at' as item, data_type as detail
  from information_schema.columns where table_name = 'quotes' and column_name = 'returned_at'
union all
select 'transition has return branch',
       (position('approved->approved_l1' in prosrc) > 0)::text
  from pg_proc where proname = 'enforce_quote_transition';
