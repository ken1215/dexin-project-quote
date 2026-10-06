-- ════════════════════════════════════════════════════════════════
-- 28_round_off_manager_only.sql — 整單打折取整只限行政管理部副部長
--
-- db/27 讓 round_off 跟著定案權限走（is_admin＝副部長＋部長）。
-- 使用者 2026-10-06 裁示：總價打折／去尾數只有副部長能做，部長也不行。
-- 部長仍可定案（p_round_off = 0 的定案不受影響），只是帶不了抹零金額。
-- 閘門放在 trigger：不管從 RPC 還是任何路徑，round_off 要變成非 0 都得是在職副部長。
-- 可重複執行。
-- ════════════════════════════════════════════════════════════════

create or replace function enforce_quote_round_off() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.round_off is distinct from old.round_off then
    if not (new.status = 'closed' and old.status in ('approved', 'negotiating')) then
      raise exception '整單折讓只能在定案時寫入'
        using errcode = 'check_violation';
    end if;
    if new.round_off <> 0 and not exists (
      select 1 from profiles where id = auth.uid() and role = 'manager' and active
    ) then
      raise exception '總價打折取整只有行政管理部副部長可以執行'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end $$;
