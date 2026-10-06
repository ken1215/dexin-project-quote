-- ═══════════════════════════════════════════════════════════════
-- 29_nego_discount_display.sql — 議價簡化為「副部長直接減價定案」＋採購角色下線
--                               ＋ 定案後看得出折扣幅度
--
-- 【為什麼要有這支】使用者 2026-10-06 裁示：
--   (1) 議價簡化：已核定的單由行政管理部副部長（role='manager'）在議價頁
--       直接減價（整單打折取整或逐項微調）→ 定案。部長（admin_head）、處長、
--       同仁都不能減價、不能定案。db/28 只把「抹零」收給副部長，定案本身
--       仍是 is_admin()（副部長＋部長）——本檔把定案也收成副部長一人。
--   (2) 醫院採購角色整個拿掉：採購不再進系統對項目提異議（還價）。
--       既有 procurement 帳號停用保留、不刪；所有 RLS 的 is_procurement() 分支收掉。
--   (3) 「議價中（negotiating）」退出流程：已核定直接定案，資料庫不再允許
--       approved→negotiating。既有 negotiating 單仍可定案（不搬資料）。
--   (4) 表單要看得出折扣：quote_lines.orig_price 在定案改價時保留原報價
--       （只留第一次），列印頁／單據頁／清單才算得出「原報價 → 定案、折扣幅度」。
--       negotiations.response 多一個 'discount'（協議折價），副部長減價時一律記這個。
--
-- 【作法】比照 db/22：不逐條 patch 前面各檔，凡本檔碰到的政策／函式一律重建**最終版**，
--   全部 drop if exists／create or replace，可重複執行。
--   身分判斷新增一支 is_vice_director()，與 db/23 五支函式同款式；它是「減價＋定案＋抹零」
--   唯一的閘門，用在三處：close_quote_case、enforce_quote_transition 的 →closed 分支、
--   enforce_quote_round_off。三道一致，日後要給部長代理權只需改這一支函式。
--
-- 【本檔重建的最終版清單】
--   函式：is_vice_director（新）、retire_procurement_role（新）、guard_orig_price（新）、
--         guard_negotiation_fields（加副部長角色檢查）、
--         enforce_quote_transition（trigger 不重掛）、enforce_quote_round_off（trigger 不重掛）、
--         close_quote_case(uuid, jsonb, numeric)
--   政策：quotes_read、quote_sections_select、quote_lines_select、nego_read、settings_read
--         （皆拿掉 is_procurement 分支）；drop nego_procurement_insert、**drop nego_manager_write**
--   trigger：profiles_procurement_retired（新）、quote_lines_orig_price_guard（新）、
--            negotiations_guard（重掛）
--   欄位／約束：quote_lines.orig_price、quote_lines_orig_price_nonneg、negotiations_response_check
--   最後：drop function is_procurement()
--   不動：quotes_insert／quotes_update／quotes_delete、子表 insert/update/delete 政策、
--         profiles_*（本來就沒有採購分支）。
--
-- 【稽核軌跡的兩道鎖】「只有副部長能減價」不只是定案按鈕，還包括列印頁與議價歷程
--   顯示的那些資料本身：
--   - negotiations：drop nego_manager_write（原 for all + is_admin，部長可直接用 PostgREST
--     新增／修改／刪除歷程、偽造 response='discount'／final_price）。之後 authenticated
--     對 negotiations 只剩 nego_read；寫入唯一路徑是 close_quote_case（security definer，
--     以擁有者身分繞過 RLS）。guard_negotiation_fields 另加「有登入身分者必須是副部長」
--     當第二道鎖，日後若有人誤加回寫入政策也不會失守。
--   - quote_lines.orig_price：子表 insert/update 政策允許草稿建立者與核定前的主管寫整列，
--     若不擋，可先把 orig_price 預填成高價，定案時 coalesce 會把偽造原價保留下來，
--     所有折扣頁面都會顯示錯的「原報價」。guard_orig_price 讓客戶端角色
--     （authenticated／anon）永遠寫不動這欄，只剩 close_quote_case 能寫。
--
-- 【刻意不做的取捨】
--   - 不刪採購帳號：auth.users 與歷史議價紀錄（responded_by）都指著它，刪了歷程就斷頭。
--   - 不從 profiles_role_check 拿掉 'procurement'：既有列仍是這個 role，
--     重建 constraint 會因既有資料違反而建不起來、整支 rollback。改用 trigger 強制停用。
--   - 不回填舊單 orig_price：改版前定案的單 unit_price 已被覆寫，原價無從得知；
--     這些單一律不顯示折扣幅度（前端以 orig_price 全空判斷）。
--   - 不建 negotiations(quote_id, round, line_id) 唯一索引：沿 db/22 取捨。
--   - 不保留 closed→negotiating（db/19／22 的重開路徑，從未有 UI）：negotiating 已退出流程，
--     定案單要重開只能人工處理。若日後需要，改加 closed→approved（admin）而不是復活議價中。
--
-- 【執行前建議預檢】若線上有本 repo 沒記錄到的政策引用 is_procurement()
--   （例如有人在 Dashboard 手動加過），檔尾 drop function 會因相依失敗、整批 rollback——
--   那是「漏改政策」不是語法錯。可先單獨跑：
--     select polname from pg_policy where pg_get_expr(polqual, polrelid) like '%is_procurement%'
--        or pg_get_expr(polwithcheck, polrelid) like '%is_procurement%';
--
-- 部署順序：**本檔 → 前端 → npx supabase functions deploy admin-users**。
--   新前端對舊 DB：response='discount' 會撞 negotiations_response_check，所以 DB 一定先上。
--   舊前端對新 DB：'partial' 仍合法；「切換為議價中」會被 transition guard 擋下（可接受）。
--   admin-users 晚上的窗口內就算有人建了採購帳號，也會被本檔的 trigger 建成停用——無害。
-- 可重複執行。
-- ═══════════════════════════════════════════════════════════════


-- ═══ A. 身分函式：副部長 ═══════════════════════════════════════
-- 唯一能減價／定案／抹零的人；部長（admin_head）不在內。
-- 與 db/23 五支函式同款式：停用或待改密碼一律 false。
create or replace function is_vice_director() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and active and not must_change_password
      and role = 'manager'
  );
$$;


-- ═══ B. 欄位與約束 ═════════════════════════════════════════════
alter table quote_lines add column if not exists orig_price numeric;

comment on column quote_lines.orig_price is
  '定案改價前的原報價。只由 close_quote_case 在第一次改價時寫入（coalesce），之後不覆蓋；'
  'null＝從未被議價改價，或改版（db/29）前就已定案的舊單。';

alter table quote_lines drop constraint if exists quote_lines_orig_price_nonneg;
alter table quote_lines add constraint quote_lines_orig_price_nonneg
  check (orig_price is null or orig_price >= 0);

-- ── orig_price 只准定案流程寫 ────────────────────────────────
-- 子表 insert/update 政策（db/22）開給草稿建立者與核定前的主管寫整列，欄位層無法單獨收權
-- （Postgres 在有表層 grant 時 revoke 欄位權限無效）。改用 trigger：
--   呼叫者是客戶端角色（authenticated／anon）→ insert 一律清成 null、update 一律沿用舊值。
-- 為什麼用 current_user 判斷而不是 auth.uid()：close_quote_case 是 security definer，
--   函式內的 DML 以擁有者身分執行，current_user 就不是 authenticated，這條路照常寫得進去；
--   但 auth.uid() 在函式內仍是呼叫者，用它分不出「直接打 PostgREST」與「走 RPC」。
--   ⚠️ 因此本 trigger 函式**不可**宣告 security definer，否則 current_user 永遠是擁有者、整道鎖失效。
-- 為什麼靜默改寫而不 raise：前端整段重寫明細時若把讀回來的列原樣送回，raise 會讓正常存檔失敗；
--   改寫後偽造值不會落地，效果相同。service_role 修補腳本不受影響。
create or replace function guard_orig_price() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.orig_price := null;
    else
      new.orig_price := old.orig_price;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists quote_lines_orig_price_guard on quote_lines;
create trigger quote_lines_orig_price_guard before insert or update on quote_lines
  for each row execute function guard_orig_price();

-- db/01 的行內 check 自動命名就是 negotiations_response_check。
-- accept／partial／hold 保留給舊歷程，新寫入一律是 discount（協議折價）。
alter table negotiations drop constraint if exists negotiations_response_check;
alter table negotiations add constraint negotiations_response_check
  check (response in ('accept', 'partial', 'hold', 'discount'));


-- ═══ C. 採購角色下線 ═══════════════════════════════════════════

-- ── C1. 既有採購帳號停用（不刪帳號、不改 role）────────────────
-- profiles_password_flag_guard 只在 must_change_password 變動時觸發，不會誤擋。
update profiles set active = false where role = 'procurement' and active;

-- ── C2. 之後不管誰、從哪條路寫，採購列永遠停用 ────────────────
-- 為什麼不直接 raise：UsersPage「儲存變更」是逐列 update，一 raise 就讓同一批裡
-- 只是改姓名的列一起失敗；靜默壓回 false、搭配前端把採購列的啟用框鎖死即可。
-- service_role（Edge Function admin-users）也會經過這支——BYPASSRLS 不跳過 trigger。
create or replace function retire_procurement_role() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.role = 'procurement' then
    new.active := false;   -- 角色已下線：採購列永遠停用
  end if;
  return new;
end $$;

drop trigger if exists profiles_procurement_retired on profiles;
create trigger profiles_procurement_retired before insert or update on profiles
  for each row execute function retire_procurement_role();

-- ── C3. 政策最終版：拿掉 is_procurement 分支 ──────────────────
drop policy if exists quotes_read on quotes;
create policy quotes_read on quotes for select to authenticated
  using ((is_active_user() and created_by = auth.uid()) or is_manager());

do $$
declare t text;
begin
  foreach t in array array['quote_sections', 'quote_lines'] loop
    -- 讀：建立者（在職）／核決層。insert／update／delete 沿用 db/22，不動。
    execute format('drop policy if exists %I_select on %I', t, t);
    execute format($f$create policy %I_select on %I for select to authenticated
      using (exists (select 1 from quotes q where q.id = quote_id
             and ((is_active_user() and q.created_by = auth.uid())
                  or is_manager())))$f$, t, t);
  end loop;
end $$;

drop policy if exists nego_read on negotiations;
create policy nego_read on negotiations for select to authenticated
  using (exists (select 1 from quotes q where q.id = quote_id
         and ((is_active_user() and q.created_by = auth.uid())
              or is_manager())));

-- 採購還價的寫入路徑整條收掉。
drop policy if exists nego_procurement_insert on negotiations;

-- 核決層直寫路徑也收掉（理由見檔頭【稽核軌跡的兩道鎖】）：
-- db/22 的 nego_manager_write 是 for all + is_admin()，部長（admin_head）可繞過議價頁
-- 直接對歷程 insert／update／delete。前端早已沒有直接寫 negotiations 的程式碼
-- （useQuoteDraft／NegotiationPage 都只 select），drop 掉不影響任何畫面；
-- 讀取由上面的 nego_read 負責，寫入只剩 close_quote_case。
drop policy if exists nego_manager_write on negotiations;

-- settings（db/15）：原本開給採購讀費率／抬頭幾列，現在只剩自家人。
drop policy if exists settings_read on settings;
create policy settings_read on settings for select to authenticated
  using (is_internal());

-- ── C4. 議價寫入 trigger：拿掉採購分支，其餘照 db/22 A4 ───────
create or replace function guard_negotiation_fields() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_owner uuid;
begin
  -- 給「繞過 RLS 的路」用的在職檢查（理由見 db/22 A4）。
  -- ⚠️ `auth.uid() is not null` 這個前提不可拿掉：service_role 的 auth.uid() 是 null，
  --    無條件擋會把日後的資料修補腳本一起鎖死。
  if auth.uid() is not null and not is_active_user() then
    raise exception '帳號已停用，不可寫入議價紀錄'
      using errcode = 'insufficient_privilege';
  end if;

  -- （db/15／22 的「採購送出的列清掉 response／final_price」已隨採購角色下線移除）

  -- 第二道鎖：有登入身分的寫入一律要是副部長。正常路徑 close_quote_case 內
  -- auth.uid() 仍是呼叫者（副部長），會通過；部長或其他人就算日後有人誤加回寫入政策，
  -- 也在這裡被擋下，歷程不會被偽造。service_role（auth.uid() 為 null）照舊放行給修補腳本。
  if auth.uid() is not null and not is_vice_director() then
    raise exception '議價紀錄只能由行政管理部副部長在定案時寫入'
      using errcode = 'insufficient_privilege';
  end if;

  if new.line_id is not null then
    select quote_id into v_owner from quote_lines where id = new.line_id;
    if v_owner is null then
      raise exception '議價紀錄指到不存在的明細：%', new.line_id
        using errcode = 'foreign_key_violation';
    end if;
    if v_owner <> new.quote_id then
      raise exception '議價紀錄的明細 % 不屬於報價單 %', new.line_id, new.quote_id
        using errcode = 'check_violation';
    end if;
  end if;

  -- auth.uid() 為 null＝service_role 直接灌資料，不覆寫既有作者資訊。
  if auth.uid() is not null then
    new.responded_by := auth.uid();
  end if;
  new.responded_at := now();
  return new;
end $$;

-- 名稱與定義與 db/15／22 相同，重掛只為讓本檔可獨立執行。
drop trigger if exists negotiations_guard on negotiations;
create trigger negotiations_guard before insert or update on negotiations
  for each row execute function guard_negotiation_fields();


-- ═══ D. 狀態轉換把關（改寫 db/22 的同名函式，trigger 不重掛）════
-- 相對 db/22 的改動：
--   (a) approved／negotiating → closed 只認 is_vice_director()（部長失去定案權）。
--   (b) 刪 approved→negotiating：議價中退出流程，不能再進入。
--   (c) 刪 closed→negotiating：定案單沒有重開路徑（見檔頭取捨）。
--   (d) negotiating→approved 保留給 admin：把卡在舊制議價中的單拉回已核定的出口。
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


-- ═══ E. 抹零把關（與 db/28 同語意，改用 is_vice_director）═══════
-- 多出 not must_change_password 條件，與其他身分函式一致。trigger 不重掛。
create or replace function enforce_quote_round_off() returns trigger
language plpgsql security definer set search_path = public as $$
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
  end if;
  return new;
end $$;


-- ═══ F. close_quote_case：副部長減價定案的唯一入口 ══════════════
-- 先 drop 兩參數版（db/22），否則會留下兩個 overload，PostgREST 依參數名挑函式時會撞名。
drop function if exists close_quote_case(uuid, jsonb);

-- p_rows 每個元素：{line_id, response, final_price, rationale}（client_offer 仍收，相容舊 payload）
-- 前端規則：只有變價的列送 response='discount'＋final_price＋rationale，
--           其餘列送全空，本函式就不寫歷程、不改價。
create or replace function close_quote_case(p_quote_id uuid, p_rows jsonb, p_round_off numeric default 0)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_status  text;
  v_round   int;
  r         jsonb;
  v_line    uuid;
  v_owner   uuid;
  v_offer   numeric;
  v_resp    text;
  v_final   numeric;
  v_rat     text;
  v_dup     boolean;
  v_logged  int := 0;
  v_updated int := 0;
begin
  -- 1. 權限閘門：2026-10-06 起只有副部長（部長不能定案——本輪核心變更）。
  --    anon 與 service_role 的 auth.uid() 都是 null，is_vice_director() 直接 false。
  if not is_vice_director() then
    raise exception '只有行政管理部副部長可以定案本案'
      using errcode = 'insufficient_privilege';
  end if;

  if coalesce(p_round_off, 0) < 0 or p_round_off <> trunc(p_round_off) then
    raise exception '整單折讓須為 0 以上的整數元（收到 %）', p_round_off
      using errcode = 'check_violation';
  end if;

  -- 2. for update：定案期間不讓別人同時推狀態
  select status into v_status from quotes where id = p_quote_id for update;
  if not found then
    raise exception '查無此報價單：%', p_quote_id using errcode = 'check_violation';
  end if;
  if v_status not in ('approved', 'negotiating') then
    raise exception '本單狀態為「%」，只有已核定（或舊制議價中）的單可以定案', v_status
      using errcode = 'check_violation';
  end if;

  -- 3. 本輪回合
  select coalesce(max(round), 0) + 1 into v_round
    from negotiations where quote_id = p_quote_id;

  -- 4. 先整批驗證再寫，任何一列不合就整批不寫
  for r in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_line := nullif(r ->> 'line_id', '')::uuid;
    if v_line is null then
      raise exception '議價資料缺少 line_id' using errcode = 'check_violation';
    end if;
    select quote_id into v_owner from quote_lines where id = v_line;
    if v_owner is null or v_owner <> p_quote_id then
      raise exception '明細 % 不屬於本報價單', v_line using errcode = 'check_violation';
    end if;
    if nullif(r ->> 'client_offer', '')::numeric < 0 then
      raise exception '院方還價不可為負數（明細 %）', v_line using errcode = 'check_violation';
    end if;
    if nullif(r ->> 'final_price', '')::numeric < 0 then
      raise exception '定案單價不可為負數（明細 %）', v_line using errcode = 'check_violation';
    end if;
    -- 比 check constraint 的錯誤訊息好懂
    v_resp := nullif(btrim(coalesce(r ->> 'response', '')), '');
    if v_resp is not null and v_resp not in ('accept', 'partial', 'hold', 'discount') then
      raise exception '不合法的回應代碼 %（明細 %）', v_resp, v_line using errcode = 'check_violation';
    end if;
  end loop;

  -- 5. 寫歷程、寫回單價
  for r in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_line  := (r ->> 'line_id')::uuid;
    v_offer := nullif(r ->> 'client_offer', '')::numeric;
    v_resp  := nullif(btrim(coalesce(r ->> 'response', '')), '');
    v_final := nullif(r ->> 'final_price', '')::numeric;
    v_rat   := coalesce(r ->> 'rationale', '');

    if v_offer is not null or v_resp is not null
       or v_final is not null or btrim(v_rat) <> '' then
      -- 去重：與該列最近一筆完全相同就不再記一輪（舊單可能先存過議價）
      select (n.client_offer is not distinct from v_offer
              and n.response    is not distinct from v_resp
              and n.final_price is not distinct from v_final
              and n.rationale   is not distinct from v_rat)
        into v_dup
        from negotiations n
       where n.quote_id = p_quote_id and n.line_id = v_line
       order by n.round desc, n.responded_at desc
       limit 1;

      if not coalesce(v_dup, false) then
        insert into negotiations
               (quote_id, line_id, round, client_offer, response, final_price, rationale)
        values (p_quote_id, v_line, v_round, v_offer, v_resp, v_final, v_rat);
        v_logged := v_logged + 1;
      end if;
    end if;

    if v_final is not null then
      update quote_lines
         set orig_price = coalesce(orig_price, unit_price),   -- 第一次改價才留原價，之後不覆蓋
             unit_price = v_final
       where id = v_line and unit_price is distinct from v_final;  -- 沒變價就不動，orig_price 不會被塞成等於現價
      if found then v_updated := v_updated + 1; end if;   -- 語意：改價幾項
    end if;
  end loop;

  -- 6. quotes_transition_guard 以 vice 把關、quotes_round_off_guard 以 vice 把關，三道一致
  update quotes set status = 'closed', round_off = coalesce(p_round_off, 0), updated_at = now()
   where id = p_quote_id;

  return jsonb_build_object('round', v_round,
                            'rows_logged', v_logged,
                            'lines_updated', v_updated);
end $$;

grant execute on function close_quote_case(uuid, jsonb, numeric) to authenticated;


-- ═══ C5. 最後一步：拿掉 is_procurement() ══════════════════════
-- 放在所有政策重建之後。若報「other objects depend on it」＝還有政策漏改，
-- 整批 rollback，正好當偵測（預檢 SQL 見檔頭）。
drop function if exists is_procurement();


-- ═══ G. 驗收 ═══════════════════════════════════════════════════
-- 每一列 detail 都應該是「OK」開頭；出現「✗」就是沒到位。
select 'policy' as kind, p.polname::text as name,
       case when coalesce(pg_get_expr(p.polqual, p.polrelid), '') like '%is_procurement%'
            then '✗ 仍含 is_procurement' else 'OK 無採購分支' end as detail
  from pg_policy p
 where p.polname in ('quotes_read', 'quote_sections_select', 'quote_lines_select',
                     'nego_read', 'settings_read')
union all
select 'policy', 'nego_procurement_insert',
       case when count(*) = 0 then 'OK 已移除' else '✗ 仍存在' end
  from pg_policy where polname = 'nego_procurement_insert'
union all
select 'policy', 'negotiations 寫入政策',
       case when count(*) = 0 then 'OK 只剩讀取（寫入走 close_quote_case）'
            else '✗ 仍有 ' || string_agg(polname::text, ',') end
  from pg_policy p join pg_class c on c.oid = p.polrelid
 where c.relname = 'negotiations' and p.polcmd <> 'r'
union all
select 'trigger', 'quote_lines_orig_price_guard',
       case when count(*) = 1 then 'OK 已建立' else '✗ 缺少' end
  from pg_trigger where tgname = 'quote_lines_orig_price_guard'
union all
select 'function', 'guard_orig_price 非 security definer',
       case when bool_and(not prosecdef) and count(*) = 1 then 'OK invoker'
            else '✗ 是 security definer，current_user 判斷會失效' end
  from pg_proc where proname = 'guard_orig_price'
union all
select 'function', 'is_vice_director',
       case when count(*) = 1 then 'OK 已建立' else '✗ 缺少' end
  from pg_proc where proname = 'is_vice_director'
union all
select 'function', 'is_procurement',
       case when count(*) = 0 then 'OK 已移除' else '✗ 仍存在' end
  from pg_proc where proname = 'is_procurement'
union all
select 'function', 'close_quote_case',
       case when bool_and(pg_get_functiondef(oid) like '%is_vice_director%'
                          and pg_get_functiondef(oid) like '%orig_price%')
                 and count(*) = 1
            then 'OK 副部長閘門＋orig_price' else '✗ 定義不對或有多個 overload' end
  from pg_proc where proname = 'close_quote_case'
union all
select 'trigger', 'profiles_procurement_retired',
       case when count(*) = 1 then 'OK 已建立' else '✗ 缺少' end
  from pg_trigger where tgname = 'profiles_procurement_retired'
union all
select 'data', '在職的採購帳號',
       case when count(*) = 0 then 'OK 0 筆' else '✗ ' || count(*) || ' 筆' end
  from profiles where role = 'procurement' and active
union all
select 'column', 'quote_lines.orig_price',
       case when count(*) = 1 then 'OK 已建立' else '✗ 缺少' end
  from information_schema.columns
 where table_name = 'quote_lines' and column_name = 'orig_price'
union all
select 'constraint', 'negotiations_response_check',
       case when bool_and(pg_get_constraintdef(oid) like '%discount%')
            then 'OK 含 discount' else '✗ 缺 discount' end
  from pg_constraint where conname = 'negotiations_response_check'
 order by 1, 2;
