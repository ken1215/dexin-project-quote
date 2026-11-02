-- ═══════════════════════════════════════════════════════════════
-- 31_review_hardening.sql — 2026-11-02 例行審查的三個資料庫漏洞＋抹零上限
--
-- 【只改規則，不動資料】本檔只有 create or replace function 與重建政策，
--   沒有任何 insert／update／delete，已核定、已定案的單內容一個字都不會變。
--
--   1. 零元檢查補到三個核可分支：審核者改成 0 元、不寫理由就核不過
--   2. 明細寫入權限：處長只在「待處長核可」能改，「處長已核可」只剩副部長／部長
--      （09-13 實際發生過處長核可後再改明細；前端早已鎖，這裡補資料庫那道）
--   3. approved→rejected、negotiating→approved 收回給副部長（原本 is_admin 連部長都放）
--   4. 抹零不得把合計抹到 0 元以下（小額單選「抹到萬元」會變 0 元）
--
-- 【作法】比照 db/30：enforce_quote_transition 整支重建最終版，trigger 不重掛。
-- ═══════════════════════════════════════════════════════════════

-- ═══ 1＋3. 狀態機 ══════════════════════════════════════════════
create or replace function quote_zero_unexplained(p_quote_id uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from quote_lines
   where quote_id = p_quote_id and unit_price <= 0 and btrim(reason) = '';
$$;

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

  -- 送審與三個核可都要過零元檢查（db/31 起核可也查，審核者改過明細一樣擋）
  -- ⚠️ 依賴前端 persist() 的順序：明細必須在改狀態**之前**就寫進資料庫（見 db/22）。
  if new.status in ('submitted', 'approved_l1', 'approved')
     and old.status in ('draft', 'rejected', 'submitted', 'approved_l1') then
    zero_cnt := quote_zero_unexplained(new.id);
    if zero_cnt > 0 then
      raise exception '有 % 項明細單價為 0 元且未填理由，請在理由欄註明（贈送／業主自購／待報價）', zero_cnt
        using errcode = 'check_violation';
    end if;
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
    -- db/31：核定後的退回／拉回一律只給副部長（部長不行，與 db/30 口徑一致）
    when 'negotiating->approved' then ok := vice;
    when 'approved->rejected' then ok := vice;
    else ok := false;
  end case;

  if not ok then
    raise exception '不允許的簽核動作：% → %（權限不足或流程順序不對）', old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end $$;


-- ═══ 2. 誰在什麼狀態能改明細 ═══════════════════════════════════
-- 取代子表政策裡的 `is_manager() and quote_open_for_edit(status)`：
--   草稿／退回 → 核決層（維持原狀）
--   待處長核可 → 處長、副部長、部長
--   處長已核可 → 只剩副部長、部長（處長已經簽過，不能再改自己簽過的內容）
create or replace function reviewer_may_edit(p_status text) returns boolean
language sql stable security definer set search_path = public as $$
  select (is_manager() and p_status in ('draft', 'rejected'))
      or (is_dept_head() and p_status = 'submitted')
      or (is_admin() and p_status in ('submitted', 'approved_l1'));
$$;

do $$
declare t text;
begin
  foreach t in array array['quote_sections', 'quote_lines'] loop
    execute format('drop policy if exists %I_insert on %I', t, t);
    execute format($f$create policy %I_insert on %I for insert to authenticated
      with check (exists (select 1 from quotes q where q.id = quote_id
             and (reviewer_may_edit(q.status)
                  or (is_active_user() and q.created_by = auth.uid()
                      and q.status = 'draft'))))$f$, t, t);

    execute format('drop policy if exists %I_update on %I', t, t);
    execute format($f$create policy %I_update on %I for update to authenticated
      using (exists (select 1 from quotes q where q.id = quote_id
             and (reviewer_may_edit(q.status)
                  or (is_active_user() and q.created_by = auth.uid()
                      and q.status = 'draft'))))
      with check (exists (select 1 from quotes q where q.id = quote_id
             and (reviewer_may_edit(q.status)
                  or (is_active_user() and q.created_by = auth.uid()
                      and q.status = 'draft'))))$f$, t, t);

    execute format('drop policy if exists %I_delete on %I', t, t);
    execute format($f$create policy %I_delete on %I for delete to authenticated
      using (exists (select 1 from quotes q where q.id = quote_id
             and (reviewer_may_edit(q.status)
                  or (is_active_user() and q.created_by = auth.uid()
                      and q.status = 'draft'))))$f$, t, t);
  end loop;
end $$;

-- 表頭同一條界線：處長不能再動「處長已核可」以後的單（舊值看 using）。
-- with check 不收：處長核可時新值就是 approved_l1，收了會核不過；狀態機另有 trigger 把關。
drop policy if exists quotes_update on quotes;
create policy quotes_update on quotes for update to authenticated
  using (is_admin()
         or (is_manager() and status in ('draft', 'rejected', 'submitted'))
         or (is_active_user() and created_by = auth.uid()
             and status in ('draft', 'rejected')))
  with check (is_manager()
              or (is_active_user() and created_by = auth.uid()
                  and status in ('draft', 'submitted')));


-- ═══ 4. 抹零上限 ═══════════════════════════════════════════════
-- 合計公式與 src/lib/calc.ts calcTotals 同一套（每層四捨五入到元）。
-- close_quote_case 先改明細單價、最後才更新 quotes，所以這裡讀到的已是定案價。
create or replace function enforce_quote_round_off() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  works numeric;
  sub   numeric;
  gross numeric;
begin
  if new.round_off is distinct from old.round_off then
    if not (new.status = 'closed' and old.status in ('approved', 'negotiating')) then
      raise exception '整單折讓只能在定案時寫入'
        using errcode = 'check_violation';
    end if;
    if new.round_off <> 0 and not is_vice_director() then
      raise exception '總價打折取整只有行政管理部副部長可以執行'
        using errcode = 'insufficient_privilege';
    end if;
    if new.round_off > 0 then
      select coalesce(sum(round(unit_price * qty)), 0) into works
        from quote_lines where quote_id = new.id;
      sub   := works + round(works * coalesce(new.mgmt_fee_rate, 0));
      gross := sub + round(sub * coalesce(new.tax_rate, 0));
      if new.round_off >= gross then
        raise exception '整單折讓 % 元已達含稅合計 % 元，抹零後合計不得為 0 元', new.round_off, gross
          using errcode = 'check_violation';
      end if;
    end if;
  end if;
  return new;
end $$;


-- 驗收
select 'transition: approved->rejected 收回副部長' as item,
       (position('when ''approved->rejected'' then ok := vice' in prosrc) > 0)::text as detail
  from pg_proc where proname = 'enforce_quote_transition'
union all
select 'quote_lines_update 用 reviewer_may_edit',
       (position('reviewer_may_edit' in qual) > 0)::text
  from pg_policies where tablename = 'quote_lines' and policyname = 'quote_lines_update'
union all
select 'round_off 有上限', (position('gross' in prosrc) > 0)::text
  from pg_proc where proname = 'enforce_quote_round_off';
