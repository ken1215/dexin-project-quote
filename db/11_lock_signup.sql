-- ═══════════════════════════════════════════════════════════════
-- 11_lock_signup.sql — 堵住「任何人自行註冊就能讀走整份單價庫」
--
-- 問題（實測確認）：Supabase 預設允許 email 公開註冊，anon key 又是公開的，
-- 所以網路上任何人打一次 /auth/v1/signup 就能拿到 authenticated 身分。
-- 而原本的參考資料讀取政策是 `using (true)` —— 只要是 authenticated 就給看，
-- 於是外人可以讀走：206 個品項的標準單價、歷史成交區間、
-- 工資成本基準 2,800 與加成係數 1.15、以及底價以外的全部經營資訊。
--
-- 修法（兩道，不倚賴後台設定）：
--   (1) 讀取政策從「有登入」改成「有登入 **且** profile 為啟用中」。
--   (2) 新註冊者的 profile 預設 active = false。
--       只有主管透過 admin-users Edge Function 建立的帳號才會被設成 active = true。
--   → 自行註冊的人拿得到 token，但讀不到任何一筆業務資料。
--
-- 仍建議一併到 Supabase 後台 Authentication → Sign In / Up 關閉 Email signup，
-- 那是第一道門；本檔是第二道，兩道都有才不會因為誰改了設定就破功。
-- ═══════════════════════════════════════════════════════════════

-- 啟用中的登入者（security definer 以避開 profiles 自身的 RLS 遞迴）
create or replace function is_active_user() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from profiles where id = auth.uid() and active
  );
$$;

-- 參考資料：讀取改為「啟用中的使用者」才給
do $$
declare t text;
begin
  foreach t in array array['categories','evidence_sources','material_indices',
                           'price_items','labor_rates','settings','labor_productivity'] loop
    execute format('drop policy if exists %I_read on %I', t, t);
    execute format('create policy %I_read on %I for select to authenticated
                    using (is_active_user())', t, t);
  end loop;
end $$;

-- labor_productivity 建表時的政策名稱不同，一併清掉避免兩條政策並存（OR 會放行）
drop policy if exists productivity_read on labor_productivity;

-- 新註冊者預設停用；主管在系統內建帳號時 Edge Function 會明確設成啟用
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, full_name, active)
  values (new.id,
          coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
          false)
  on conflict (id) do nothing;
  return new;
end $$;

-- 既有的正式帳號維持啟用（保險起見明確寫一次）
update profiles set active = true
 where id in (select id from auth.users
               where email in ('ken1215@gmail.com', 'staff@dexin.test'));

select p.full_name, p.role, p.active, u.email
  from profiles p join auth.users u on u.id = p.id
 order by p.created_at;
