-- ════════════════════════════════════════════════════════════════
-- 27_round_off.sql — 議價「整單打折並取整數」的抹零金額
--
-- 副部長在議價頁一鍵把每項單價 × 折數（取整到元），合計再往下抹到整百／千／萬。
-- 逐項單價取整後的合計不會剛好是整數，差的零頭記在 quotes.round_off（含稅金額、正數），
-- 合計 = 工程小計 + 管理費 + 營業稅 − round_off，列印頁印成一列「整單折讓（取整）」。
--
-- 只有 close_quote_case() 寫得進去：
--   - 函式本身已有 is_admin() 閘門（副部長／部長）。
--   - quotes_round_off_guard 擋掉其他路徑：round_off 只准在「→ 定案」那一次 update 改。
--     （名稱排在 immutable_guard 與 transition_guard 之間，→closed 仍由 transition_guard 驗 is_admin）
--
-- 部署順序：本檔 → 前端。舊前端呼叫 close_quote_case(p_quote_id, p_rows) 仍可用（p_round_off 預設 0）。
-- 可重複執行。
-- ════════════════════════════════════════════════════════════════

alter table quotes add column if not exists round_off numeric not null default 0;
alter table quotes drop constraint if exists quotes_round_off_nonneg;
alter table quotes add constraint quotes_round_off_nonneg check (round_off >= 0);

create or replace function enforce_quote_round_off() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.round_off is distinct from old.round_off
     and not (new.status = 'closed' and old.status in ('approved', 'negotiating')) then
    raise exception '整單折讓只能在定案時由副部長／部長寫入'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists quotes_round_off_guard on quotes;
create trigger quotes_round_off_guard before update on quotes
  for each row execute function enforce_quote_round_off();

-- ── close_quote_case：多一個 p_round_off ─────────────────────────
-- 先 drop 兩參數版，否則會留下兩個 overload，PostgREST 依參數名挑函式時會撞名。
drop function if exists close_quote_case(uuid, jsonb);

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
  if not is_admin() then
    raise exception '只有行政管理部副部長／部長可以定案本案'
      using errcode = 'insufficient_privilege';
  end if;

  if coalesce(p_round_off, 0) < 0 or p_round_off <> trunc(p_round_off) then
    raise exception '整單折讓須為 0 以上的整數元（收到 %）', p_round_off
      using errcode = 'check_violation';
  end if;

  select status into v_status from quotes where id = p_quote_id for update;
  if not found then
    raise exception '查無此報價單：%', p_quote_id using errcode = 'check_violation';
  end if;
  if v_status not in ('approved', 'negotiating') then
    raise exception '本單狀態為「%」，只有已核定或議價中的單可以定案', v_status
      using errcode = 'check_violation';
  end if;

  select coalesce(max(round), 0) + 1 into v_round
    from negotiations where quote_id = p_quote_id;

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

  for r in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_line  := (r ->> 'line_id')::uuid;
    v_offer := nullif(r ->> 'client_offer', '')::numeric;
    v_resp  := nullif(btrim(coalesce(r ->> 'response', '')), '');
    v_final := nullif(r ->> 'final_price', '')::numeric;
    v_rat   := coalesce(r ->> 'rationale', '');

    if v_offer is not null or v_resp is not null
       or v_final is not null or btrim(v_rat) <> '' then
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

  update quotes set status = 'closed', round_off = coalesce(p_round_off, 0), updated_at = now()
   where id = p_quote_id;

  return jsonb_build_object('round', v_round,
                            'rows_logged', v_logged,
                            'lines_updated', v_updated);
end $$;

grant execute on function close_quote_case(uuid, jsonb, numeric) to authenticated;
