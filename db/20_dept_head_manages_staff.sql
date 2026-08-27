-- ═══════════════════════════════════════════════════════════════
-- 20_dept_head_manages_staff.sql — 工務處長可管「同仁」帳號
--
-- 使用者 2026-08-27 追加：工務處長要能新增／停用工務處同仁的帳號。
-- 範圍刻意收在 staff，理由是**提權**：若處長能建立或改成 manager 角色，
-- 他就能把自己（或任何人）升成副部長，接著取得議價定案與刪報價單的權限，
-- 那麼「兩關簽核」與「不可逆三件事只留副部長」這兩條界線同時形同虛設。
--
-- 處長可以：建立同仁帳號、停用／啟用同仁、改同仁姓名、重設同仁密碼。
-- 處長不可以：碰處長／副部長／醫院採購的任何一列、改自己的角色、**刪除帳號**。
--   （刪除不可逆，與既有「不可逆的事只留副部長」一致；停用就進不來了，且可回復。）
--
-- 單價庫這邊不必動：處長早在 db/19 就因 is_manager() 語意擴大而取得
-- price_items／price_floors／settings／material_indices／labor_rates／
-- labor_productivity 的完整寫入權（本檔末尾有驗收查詢佐證）。
--
-- 這裡是資料庫這一道；Edge Function `admin-users` 另有同樣界線的第二道
-- （建帳號與重設密碼需要 service_role，只能在伺服器端做）。兩道都要有。
-- ═══════════════════════════════════════════════════════════════

-- 處長只能改「目前是 staff、改完還是 staff」的那些列。
-- UPDATE 的 using 看的是舊值、with check 看的是新值，兩邊都釘住 'staff'：
--   using  擋掉「拿別的角色的列來改」
--   check  擋掉「把同仁升成 dept_head / manager」
-- 兩者缺一都會漏。既有的 profiles_manage（is_admin）不動，政策之間是 OR。
drop policy if exists profiles_dept_head_staff on profiles;
create policy profiles_dept_head_staff on profiles for update to authenticated
  using (is_dept_head() and role = 'staff')
  with check (is_dept_head() and role = 'staff');

-- 明確不給處長 delete：不新增任何 delete 政策，
-- profiles 的刪除仍只有 profiles_manage(is_admin) 那一條。

-- ── 驗收 ──────────────────────────────────────────────────────
select c.relname as tbl, p.polname, p.polcmd,
       pg_get_expr(p.polqual, p.polrelid)      as using_expr,
       pg_get_expr(p.polwithcheck, p.polrelid) as check_expr
  from pg_policy p join pg_class c on c.oid = p.polrelid
 where c.relname in ('profiles','price_items','price_floors','settings')
   and p.polcmd in ('*','w','a','d')
 order by c.relname, p.polname;
