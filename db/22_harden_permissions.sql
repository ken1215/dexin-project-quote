-- ═══════════════════════════════════════════════════════════════
-- 22_harden_permissions.sql — 補上四個「畫面看不出來、打 API 就破」的權限缺口
--
-- 【為什麼要有這支】前面 21 支把角色與流程都拉好了，但那些界線幾乎都靠
--   「前端不顯示按鈕」在撐。實際直接打 PostgREST 會發現四條路是通的：
--   (1) 任何登入者都能直接 INSERT 一張 status='approved' 的母單——
--       quotes_insert 只驗 created_by，db/19 的轉換把關又只掛在 UPDATE。
--       這條單會立刻出現在醫院採購的可見範圍裡。
--   (2) 核定之後金額還改得動——db/10 的子表寫入政策對核決層完全不看狀態，
--       處長可以把已核定單的單價、數量改掉而不留任何簽核痕跡；
--       母單的 approved_by／approved_at 也可以由客戶端自己塞值。
--   (3) 帳號停用後舊 token 還能用——所有 owner 分支寫的是
--       `created_by = auth.uid()`，沒有一條問過這個人還在不在職。
--   (4) negotiations 的 line_id 可以指到別張單的明細（兩個 FK 各管各的），
--       round 也可以是 0 或負數。
--
-- 【作法】不逐條 patch 前面各檔的片段，一律在本檔重建這些政策的**最終版**
--   （db/01 母表與子表的 for all、db/10 拆出來的逐指令、db/15 的採購分支、
--   db/19 收回給副部長／部長的 negotiations 寫入，都在這裡合併成一份，
--   讀這支就等於看到現行全貌）。
--   函式一律 `create or replace`：db/19 掛好的 quotes_transition_guard 只換函式本體、
--   不重掛（重掛就得重寫 when 子句，多一個會走味的地方）；negotiations_guard 則原樣
--   重掛一次，讓本檔在只跑過 db/01 的環境也能獨立執行。
--   核定後的金額異動改走 security definer 的 close_quote_case()，
--   政策層直接把所有角色都擋在門外——「唯一的門」比「很多把鎖」好稽核。
--
-- 【刻意不做的取捨】
--   - 不鎖 project／dept／contact／quote_date／review_note：使用者裁示
--     「金額鎖死、非金額欄位可改」，核決層要能在定案前修正抬頭與批註。
--   - 不建 negotiations(quote_id, round, line_id) 唯一索引：我方與採購兩邊
--     都用 max(round)+1 算回合，同時送出必撞號，現行 UI 收到 23505 無法回復。
--     代價是極端併發下歷程可能出現兩個同號回合——難看但不壞資料，本輪接受。
--   - 零元品項用 trigger 擋送審而不用 table constraint：既有歷史單裡本來就有
--     零元列，加 constraint 會讓整支 migration 直接失敗。
--   - 不加「禁止任何人更改自己 role」的 trigger（db/21 已記過同一筆帳），
--     那是提權防護，不在本輪 P0 範圍。
--
-- 【執行前必讀】A0 的診斷 select 放在最前面。**請先單獨執行 A0 那一段、確認四個
--   數字都是 0，再跑整支檔案**——SQL Editor 只顯示最後一個 select 的結果，
--   整檔一起貼會被 A7 的驗收蓋掉，等於沒看過診斷。
--   **任何一項不為零就停下來問人，不要自己清資料**——整支 migration 跑在同一個
--   交易裡，約束建不起來會整批 rollback，而「該怎麼修那些髒資料」是業務決定，
--   不是工程決定。
--
-- 部署順序：db/21 → **本檔** → functions deploy admin-users → 前端。
-- 可重複執行。
-- ═══════════════════════════════════════════════════════════════


-- ═══ A0 前置診斷 ═══════════════════════════════════════════════
-- 四個數字都必須是 0。不為零＝下面的 constraint 會建不起來，
-- 請把數字回報給使用者決定怎麼處理，不要在這裡自己 update／delete。
-- ⚠️ 契約（PLAN-P0.md A0）只點名前三項，第四項是實作時補的，**尚未經使用者確認**：
--    A4 要建 negotiations_amounts_nonneg，少了這一項就會有一種髒資料
--    讓診斷顯示全綠、整批 migration 卻在 A4 rollback，等於白跑一趟診斷。
--    它是純 select、沒有任何副作用；使用者若認為超出授權，刪掉這一段 union all
--    的四行即可，其餘不受影響。
select '費率超出 0–1 的報價單' as item,
       count(*) as bad_rows
  from quotes
 where mgmt_fee_rate < 0 or mgmt_fee_rate > 1
    or tax_rate      < 0 or tax_rate      > 1
union all
select 'negotiations.line_id 不屬於該 quote_id',
       count(*)
  from negotiations n
  join quote_lines l on l.id = n.line_id
 where n.line_id is not null and l.quote_id <> n.quote_id
union all
select 'negotiations.round <= 0',
       count(*)
  from negotiations
 where round <= 0
union all
select 'negotiations 金額為負數',
       count(*)
  from negotiations
 where client_offer < 0 or final_price < 0;


-- ═══ A1 P0-1：新建只能是草稿 ═══════════════════════════════════

-- 費率是母單上唯一沒有任何約束的數字欄位，前端傳 -1 或 100 都收。
-- 0–1 是比率的定義域，不是業務上限（9% 管理費寫成 0.09）。
alter table quotes drop constraint if exists quotes_rates_range;
alter table quotes add constraint quotes_rates_range
  check (mgmt_fee_rate >= 0 and mgmt_fee_rate <= 1
     and tax_rate      >= 0 and tax_rate      <= 1);

-- 政策這一道：is_internal() 內含 active 檢查，一次擋掉醫院採購與停用帳號。
drop policy if exists quotes_insert on quotes;
create policy quotes_insert on quotes for insert to authenticated
  with check (created_by = auth.uid() and is_internal() and status = 'draft');

-- trigger 這一道：政策擋得住 REST，擋不住 service_role（BYPASSRLS 不會跳過 trigger），
-- 而且 raise 出來的訊息比 RLS 的 42501 好懂。順便把核可戳記清乾淨——
-- 建立當下就自帶 approved_by 的單，等於繞過整條簽核鏈。
create or replace function enforce_quote_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from 'draft' then
    raise exception '新建報價單只能是草稿（收到「%」）；核定狀態一律只能由簽核流程推進', new.status
      using errcode = 'check_violation';
  end if;
  new.approved_by    := null;
  new.approved_at    := null;
  new.approved_l1_by := null;
  new.approved_l1_at := null;
  new.l1_skipped     := false;
  return new;
end $$;

drop trigger if exists quotes_insert_guard on quotes;
create trigger quotes_insert_guard before insert on quotes
  for each row execute function enforce_quote_insert();


-- ═══ A3 前置：什麼狀態還准動明細 ═══════════════════════════════
-- 只列「金額還沒定案」的狀態。approved 之後（含 negotiating／closed）
-- 一律不准，改走 close_quote_case()。
-- ⚠️ 這支刻意**不加** `set search_path`（與本檔其他函式的慣例相反）：
--    它不引用任何資料庫物件，沒有 search_path 可被劫持的面；而加了 SET 會讓
--    Postgres 無法把它 inline 進政策運算式，子表每一列都要付一次函式呼叫。
create or replace function quote_open_for_edit(p_status text) returns boolean
language sql immutable parallel safe as $$
  select p_status in ('draft', 'submitted', 'approved_l1', 'rejected');
$$;


-- ═══ A2 ＋ A3：報價單與子表政策的最終版 ═════════════════════════
-- 這一段把 db/01（for all）、db/10（逐指令）、db/15（採購分支）三代政策
-- 收成一份。往後要查「誰動得了報價單」看這一段就夠。
-- 三個共通改動：
--   (a) 每一個 owner 分支都補 is_active_user()——停用帳號的舊 token 立刻失權。
--   (b) 子表的核決層分支加 quote_open_for_edit()——核定後誰都寫不進去。
--   (c) 採購分支原封保留（approved／negotiating／closed 三個狀態的唯讀）。

-- ── quotes ────────────────────────────────────────────────────
drop policy if exists quotes_read on quotes;
create policy quotes_read on quotes for select to authenticated
  using (
    (is_active_user() and created_by = auth.uid())
    or is_manager()
    or (is_procurement() and status in ('approved', 'negotiating', 'closed'))
  );

-- using 看舊值（能不能拿這張單來改）、with check 看新值（改完能不能長這樣）。
-- owner 只在草稿／退回單可改，改完只能停在 draft／submitted。
drop policy if exists quotes_update on quotes;
create policy quotes_update on quotes for update to authenticated
  using (is_manager()
         or (is_active_user() and created_by = auth.uid()
             and status in ('draft', 'rejected')))
  with check (is_manager()
              or (is_active_user() and created_by = auth.uid()
                  and status in ('draft', 'submitted')));

-- 刪單不可逆，維持 db/19 收回給副部長／部長的界線。
drop policy if exists quotes_delete on quotes;
create policy quotes_delete on quotes for delete to authenticated
  using (is_admin()
         or (is_active_user() and created_by = auth.uid() and status = 'draft'));

-- ── quote_sections / quote_lines ──────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['quote_sections', 'quote_lines'] loop
    -- db/01 的 for all 政策：db/10 已經清過，但本檔要能單獨重建最終版，
    -- 不能假設 db/10 跑過。政策之間是 OR，殘留一條 _all 就等於整組白鎖。
    execute format('drop policy if exists %I_all on %I', t, t);

    -- 讀：建立者（在職）／核決層／醫院採購（限已送出的單）
    execute format('drop policy if exists %I_select on %I', t, t);
    execute format($f$create policy %I_select on %I for select to authenticated
      using (exists (select 1 from quotes q where q.id = quote_id
             and ((is_active_user() and q.created_by = auth.uid())
                  or is_manager()
                  or (is_procurement() and q.status in ('approved','negotiating','closed')))))$f$, t, t);

    -- 寫入：核決層限「尚未核定」的單；建立者一律只在 draft 動得了明細。
    --（原本 owner 的 insert／delete 開到 'submitted'，是因為舊版前端「先改狀態再重寫明細」
    --  非得要這一格不可。B1 改成「寫完明細才推狀態」之後這條路已經沒人走，
    --  留著等於讓同仁可以繞過畫面、用 API 改自己**已送審**單的明細金額，故一併收掉。）
    execute format('drop policy if exists %I_insert on %I', t, t);
    execute format($f$create policy %I_insert on %I for insert to authenticated
      with check (exists (select 1 from quotes q where q.id = quote_id
             and ((is_manager() and quote_open_for_edit(q.status))
                  or (is_active_user() and q.created_by = auth.uid()
                      and q.status = 'draft'))))$f$, t, t);

    execute format('drop policy if exists %I_update on %I', t, t);
    execute format($f$create policy %I_update on %I for update to authenticated
      using (exists (select 1 from quotes q where q.id = quote_id
             and ((is_manager() and quote_open_for_edit(q.status))
                  or (is_active_user() and q.created_by = auth.uid()
                      and q.status = 'draft'))))
      with check (exists (select 1 from quotes q where q.id = quote_id
             and ((is_manager() and quote_open_for_edit(q.status))
                  or (is_active_user() and q.created_by = auth.uid()
                      and q.status = 'draft'))))$f$, t, t);

    -- DELETE 只受 using 管（沒有新值可檢查）——db/10 就是為了這件事才拆逐指令的
    execute format('drop policy if exists %I_delete on %I', t, t);
    execute format($f$create policy %I_delete on %I for delete to authenticated
      using (exists (select 1 from quotes q where q.id = quote_id
             and ((is_manager() and quote_open_for_edit(q.status))
                  or (is_active_user() and q.created_by = auth.uid()
                      and q.status = 'draft'))))$f$, t, t);
  end loop;
end $$;

-- ── negotiations ──────────────────────────────────────────────
drop policy if exists nego_read on negotiations;
create policy nego_read on negotiations for select to authenticated
  using (exists (select 1 from quotes q where q.id = quote_id
         and ((is_active_user() and q.created_by = auth.uid())
              or is_manager()
              or (is_procurement() and q.status in ('approved','negotiating','closed')))));

-- 寫入這兩條與 db/19／db/15 的最終版語意相同，在這裡原樣重建的理由跟子表一樣：
-- 本檔要能在只跑過 db/01 的環境獨立跑完，而 db/01 建的是名為 nego_write 的
-- for all 政策——政策之間是 OR，那條殘留下來就等於整組白鎖。
drop policy if exists nego_write on negotiations;            -- db/01 的舊名
drop policy if exists nego_manager_write on negotiations;
create policy nego_manager_write on negotiations for all to authenticated
  using (is_admin()) with check (is_admin());

drop policy if exists nego_procurement_insert on negotiations;
create policy nego_procurement_insert on negotiations for insert to authenticated
  with check (
    is_procurement()
    and responded_by = auth.uid()
    and exists (select 1 from quotes q where q.id = quote_id
                and q.status in ('approved', 'negotiating'))
  );
-- responded_by = auth.uid() 這一條刻意留著，即使 A4 的 trigger 已經一律覆寫：
-- RLS 的 with check 是在 BEFORE trigger 跑完之後才驗新值，所以蓋過的值必然通過，
-- 留著等於多一層「政策自己讀得懂」的敘述，拿掉反而是無謂的語意變更。
--
-- 這兩條都不另外掛 is_active_user()：is_admin()（db/21）與 is_procurement()（db/15）
-- 的定義裡本來就有 `and active`，停用帳號在函式層就已經是 false。多寫一次不會更安全，
-- 反而會讓後人誤以為那兩支函式沒查在職。RLS 管不到的路徑由下面 A4 的 trigger 補。


-- ═══ A3 P0-2：母單不可變欄位 ═══════════════════════════════════
-- ⚠️ trigger 命名有意義，改名前先讀完這段：
--    Postgres 的 BEFORE ROW trigger 依「trigger 名稱字母序」依次執行，
--    後一支拿到的 NEW 是前一支改過的版本。
--    quotes_immutable_guard（i）排在 quotes_transition_guard（t）之前，
--    所以本 trigger 看到的 NEW 還沒被簽核邏輯寫入戳記 —— 合法簽核時
--    new.approved_by 仍等於 old.approved_by，檢查通過；接著轉換把關才蓋戳記。
--    反過來若本 trigger 排在後面，每一次合法核可都會被自己擋下來。
create or replace function enforce_quote_immutable() returns trigger
language plpgsql security definer set search_path = public as $$
declare bad text;
begin
  -- 永遠不可由客戶端改：單號是對外文件編號，其餘是簽核軌跡
  bad := case
    when new.quote_no       is distinct from old.quote_no       then 'quote_no'
    when new.created_by     is distinct from old.created_by     then 'created_by'
    when new.approved_by    is distinct from old.approved_by    then 'approved_by'
    when new.approved_at    is distinct from old.approved_at    then 'approved_at'
    when new.approved_l1_by is distinct from old.approved_l1_by then 'approved_l1_by'
    when new.approved_l1_at is distinct from old.approved_l1_at then 'approved_l1_at'
    when new.l1_skipped     is distinct from old.l1_skipped     then 'l1_skipped'
  end;
  if bad is not null then
    raise exception '欄位 % 不可由客戶端修改：單號與核可戳記只由系統寫入', bad
      using errcode = 'check_violation';
  end if;

  -- 核定之後金額鎖死。母單這一層是費率，明細那一層由子表政策擋。
  if old.status in ('approved', 'negotiating', 'closed') then
    bad := case
      when new.mgmt_fee_rate is distinct from old.mgmt_fee_rate then 'mgmt_fee_rate'
      when new.tax_rate      is distinct from old.tax_rate      then 'tax_rate'
    end;
    if bad is not null then
      raise exception '本單狀態為「%」，% 不可再修改（金額異動請退回重簽）', old.status, bad
        using errcode = 'check_violation';
    end if;
  end if;

  -- project／dept／contact／quote_date／review_note／updated_at／status 刻意不鎖：
  -- 使用者裁示「金額鎖死、非金額欄位可改」，核決層要能修正抬頭與批註。
  return new;
end $$;

drop trigger if exists quotes_immutable_guard on quotes;
create trigger quotes_immutable_guard before update on quotes
  for each row execute function enforce_quote_immutable();


-- ═══ A2 ＋ A3 ＋ A5：狀態轉換把關（改寫 db/19 的同名函式）═══════
-- 沿用 db/19 掛好的 quotes_transition_guard，這裡只 replace 函式本體，
-- 不重掛 trigger（重掛就要重寫 when 子句，多一個會走味的地方）。
-- 相對 db/19 的三處改動：
--   (a) owner 補 is_active_user()——停用帳號不能再推自己的單。
--   (b) approved_l1 -> approved 明確寫 l1_skipped := false，
--       否則越級核定後又被退回、重走正常流程時會殘留 true。
--   (c) 送審時擋下「零元又沒寫理由」的明細（A5）。
create or replace function enforce_quote_transition() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  owner    boolean := (old.created_by = auth.uid()) and is_active_user();
  head     boolean := is_dept_head();
  admin    boolean := is_admin();
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
        -- ⚠️ 依賴前端 persist() 的順序：明細必須在改狀態**之前**就寫進資料庫，
        --    否則這裡掃到的是空單，檢查永遠通過。
        --    不要為了省一次 round-trip 把「先改狀態再寫明細」改回去。
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
    -- 核定之後的議價與定案：只有副部長／部長
    when 'approved->negotiating', 'approved->closed',
         'negotiating->closed',   'negotiating->approved' then ok := admin;
    -- 定案後要重啟只能由副部長／部長退回
    when 'closed->negotiating', 'approved->rejected' then ok := admin;
    else ok := false;
  end case;

  if not ok then
    raise exception '不允許的簽核動作：% → %（權限不足或流程順序不對）', old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end $$;


-- ═══ A4 P0-4：議價資料的約束與欄位把關 ═════════════════════════
alter table negotiations drop constraint if exists negotiations_round_positive;
alter table negotiations add constraint negotiations_round_positive
  check (round > 0);

alter table negotiations drop constraint if exists negotiations_amounts_nonneg;
alter table negotiations add constraint negotiations_amounts_nonneg
  check ((client_offer is null or client_offer >= 0)
     and (final_price  is null or final_price  >= 0));

-- 改寫 db/15 的同名函式，沿用 negotiations_guard 這個 trigger（不新增第二支：
-- 兩支都寫 responded_by 會互相覆蓋，出事時查不出是誰蓋的）。
-- 原本「採購送出的列清掉我方回應」的行為完整保留，另外加三件事：
--   (1) 停用帳號一律擋下（A2「停用帳號立即失權」在寫入路徑上的最後一道）。
--   (2) line_id 必須屬於同一張報價單——quote_id 與 line_id 各有自己的 FK，
--       沒有任何一個 FK 管得到「這兩者要一致」，只能在這裡兜。
--   (3) responded_by／responded_at 一律由資料庫蓋，客戶端送什麼都覆寫。
--       （responded_by 目前沒有任何畫面在顯示，是純稽核欄，覆寫不影響 UI。）
create or replace function guard_negotiation_fields() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_owner uuid;
begin
  -- 走 PostgREST 的話政策層就已經擋掉了（is_admin()／is_procurement() 本身含 active），
  -- 這一道是給「繞過 RLS 的路」用的：BYPASSRLS 不會跳過 trigger，日後若有人加了
  -- security definer 的寫入函式，也不必再記得補一次在職檢查。
  -- ⚠️ `auth.uid() is not null` 這個前提是必要的，不可寫成無條件 raise——
  --    service_role 與 anon 的 auth.uid() 都是 null，無條件擋會連帶把日後的
  --    資料修補腳本一起鎖死（目前程式碼裡沒有任何 service_role 寫 negotiations 的路徑，
  --    所以現在拿掉這個前提也測得過，但那是在替後人埋陷阱）。
  if auth.uid() is not null and not is_active_user() then
    raise exception '帳號已停用，不可寫入議價紀錄'
      using errcode = 'insufficient_privilege';
  end if;

  if is_procurement() then
    new.response    := null;   -- 接受／部分讓步／堅持 是我方的判斷
    new.final_price := null;   -- 定案價只有副部長／部長能給
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

  -- auth.uid() 為 null＝用 service_role 直接灌資料（維運腳本、資料修補），
  -- 這種情況不要覆寫，否則會把既有的作者資訊蓋成 null。一般 API 呼叫一律覆寫。
  if auth.uid() is not null then
    new.responded_by := auth.uid();
  end if;
  new.responded_at := now();
  return new;
end $$;

-- trigger 本體沿用 db/15 建立的那一支；這裡重掛一次只是為了讓本檔可獨立執行，
-- 名稱與定義與 db/15 完全相同（negotiations 上只有這一支 trigger，無排序問題）。
drop trigger if exists negotiations_guard on negotiations;
create trigger negotiations_guard before insert or update on negotiations
  for each row execute function guard_negotiation_fields();


-- ═══ A6 close_quote_case：核定後唯一能改金額的門 ════════════════
-- 政策層已經把 approved 之後的 quote_lines 對所有角色關死，定案只能走這裡。
-- security definer ＋ 全程單一交易：不會再出現「單價已寫回但狀態沒改」。
-- p_rows 每個元素：{line_id, client_offer, response, final_price, rationale}
--   後四者可為 null 或空字串（前端沒填的欄位就是空字串）。
create or replace function close_quote_case(p_quote_id uuid, p_rows jsonb)
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
  -- 1. 定案會把金額寫回報價單，不可逆，只留最終核決層。
  --    這一行就是本函式的權限閘門——所以不必 revoke public：
  --    anon 與 service_role 的 auth.uid() 都是 null，is_admin() 直接 false。
  if not is_admin() then
    raise exception '只有行政管理部副部長／部長可以定案本案'
      using errcode = 'insufficient_privilege';
  end if;

  -- 2. for update：定案期間不讓別人同時推狀態
  select status into v_status from quotes where id = p_quote_id for update;
  if not found then
    raise exception '查無此報價單：%', p_quote_id using errcode = 'check_violation';
  end if;
  if v_status not in ('approved', 'negotiating') then
    raise exception '本單狀態為「%」，只有已核定或議價中的單可以定案', v_status
      using errcode = 'check_violation';
  end if;

  -- 3. 本輪回合
  select coalesce(max(round), 0) + 1 into v_round
    from negotiations where quote_id = p_quote_id;

  -- 4. 先整批驗證再寫，任何一列不合就整批不寫
  --    （不能邊驗邊寫——raise 雖然會 rollback，但錯誤訊息裡的「已寫幾筆」會騙人）
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
  end loop;

  -- 5. ＋ 6. 寫歷程、寫回單價
  for r in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_line  := (r ->> 'line_id')::uuid;
    -- 正規化必須與前端「儲存本輪議價」寫進來的形狀一致，否則第 5 步的去重永遠不成立
    v_offer := nullif(r ->> 'client_offer', '')::numeric;
    v_resp  := nullif(btrim(coalesce(r ->> 'response', '')), '');
    v_final := nullif(r ->> 'final_price', '')::numeric;
    v_rat   := coalesce(r ->> 'rationale', '');

    if v_offer is not null or v_resp is not null
       or v_final is not null or btrim(v_rat) <> '' then
      -- 使用者常常先按「儲存本輪議價」再按「定案」，不去重會在歷程上
      -- 多出一筆一模一樣的回合，看起來像談了兩輪。
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
      update quote_lines set unit_price = v_final where id = v_line;
      if found then v_updated := v_updated + 1; end if;
    end if;
  end loop;

  -- 7. 沿用 quotes_transition_guard 把關（approved／negotiating -> closed 需 is_admin）
  update quotes set status = 'closed', updated_at = now() where id = p_quote_id;

  -- 8.
  return jsonb_build_object('round', v_round,
                            'rows_logged', v_logged,
                            'lines_updated', v_updated);
end $$;

grant execute on function close_quote_case(uuid, jsonb) to authenticated;


-- ═══ A7 驗收 ═══════════════════════════════════════════════════
-- 四段各自要有輸出：15 條政策、4 支 trigger、3 條約束、1 個 close_quote_case。
select 'policy' as kind, c.relname::text as tbl, p.polname::text as name
  from pg_policy p join pg_class c on c.oid = p.polrelid
 where p.polname in ('quotes_read', 'quotes_insert', 'quotes_update', 'quotes_delete',
                     'quote_sections_select', 'quote_sections_insert',
                     'quote_sections_update', 'quote_sections_delete',
                     'quote_lines_select', 'quote_lines_insert',
                     'quote_lines_update', 'quote_lines_delete',
                     'nego_read', 'nego_manager_write', 'nego_procurement_insert')
union all
select 'trigger', c.relname::text, t.tgname::text
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
 where t.tgname in ('quotes_insert_guard', 'quotes_immutable_guard',
                    'quotes_transition_guard', 'negotiations_guard')
union all
select 'constraint', 'quotes/negotiations', conname::text
  from pg_constraint
 where conname in ('quotes_rates_range', 'negotiations_round_positive',
                   'negotiations_amounts_nonneg')
union all
select 'function', 'public',
       case when exists (select 1 from pg_proc where proname = 'close_quote_case')
            then 'close_quote_case 已建立' else '✗ 缺少 close_quote_case' end
 order by 1, 2, 3;
