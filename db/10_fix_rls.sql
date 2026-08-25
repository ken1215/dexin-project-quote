-- ═══════════════════════════════════════════════════════════════
-- 10_fix_rls.sql — 修正報價單子表 RLS 的兩個實害漏洞 + 退回單重送
-- 在 Supabase → SQL Editor 貼上執行（可重複執行）。
-- ⚠ 請先跑這支，再部署對應版本的前端（QuoteEditorPage 退回單重送依賴本政策）。
--
-- 修正內容：
-- (1) 同仁送審會把明細砍光：
--     前端送審流程是「母單狀態改 submitted → 刪舊明細 → 寫新明細」。
--     原 quote_sections/quote_lines 政策的 with check 只允許 q.status='draft'，
--     於是同仁按「送主管核可」時：狀態已改成 submitted → 刪除成功（USING 只看
--     擁有者）→ 重寫被拒 → 留下一張「已送審但零明細」的單，草稿內容遺失。
-- (2) 同仁可刪除已核可／已定案單的明細：
--     原政策是單一 FOR ALL，DELETE 只受 USING 管（擁有者即可，不看狀態），
--     同仁可透過 API 刪掉自己「已核可」單的明細行，讓核可後金額無聲改變。
--     改為逐指令政策：owner 僅能在 draft（寫入流程中含 submitted）動明細，
--     approved / negotiating / closed 一律只有主管能動。
-- (3) 退回(rejected)單原本誰都改不了（同仁被 status='draft' 擋住、UI 也鎖），
--     形成死路。開放建立者修改退回單；前端存檔時會把狀態改回 draft。

-- ── quotes：同仁可改自己的草稿與退回單；改後狀態只能是 draft / submitted ──
drop policy if exists quotes_update on quotes;
create policy quotes_update on quotes for update to authenticated
  using (is_manager() or (created_by = auth.uid() and status in ('draft','rejected')))
  with check (is_manager() or (created_by = auth.uid() and status in ('draft','submitted')));

-- ── 子表：由單一 FOR ALL 改為逐指令政策 ──────────────────────────
do $$
declare t text;
begin
  foreach t in array array['quote_sections','quote_lines'] loop
    execute format('drop policy if exists %I_all on %I', t, t);

    -- 讀：建立者或主管
    execute format('drop policy if exists %I_select on %I', t, t);
    execute format($f$create policy %I_select on %I for select to authenticated
      using (exists (select 1 from quotes q where q.id = quote_id
             and (q.created_by = auth.uid() or is_manager())))$f$, t, t);

    -- 寫入：主管不限；建立者限草稿，另含送審流程中的 submitted
    --（前端先把母單改成 submitted 再重寫明細；核可後 approved 起同仁即不可寫）
    execute format('drop policy if exists %I_insert on %I', t, t);
    execute format($f$create policy %I_insert on %I for insert to authenticated
      with check (exists (select 1 from quotes q where q.id = quote_id
             and (is_manager() or (q.created_by = auth.uid()
                  and q.status in ('draft','submitted')))))$f$, t, t);

    execute format('drop policy if exists %I_update on %I', t, t);
    execute format($f$create policy %I_update on %I for update to authenticated
      using (exists (select 1 from quotes q where q.id = quote_id
             and (is_manager() or (q.created_by = auth.uid() and q.status = 'draft'))))
      with check (exists (select 1 from quotes q where q.id = quote_id
             and (is_manager() or (q.created_by = auth.uid() and q.status = 'draft'))))$f$, t, t);

    execute format('drop policy if exists %I_delete on %I', t, t);
    execute format($f$create policy %I_delete on %I for delete to authenticated
      using (exists (select 1 from quotes q where q.id = quote_id
             and (is_manager() or (q.created_by = auth.uid()
                  and q.status in ('draft','submitted')))))$f$, t, t);
  end loop;
end $$;

-- 驗證：四張表的政策清單
select tablename, policyname, cmd
  from pg_policies
 where tablename in ('quotes','quote_sections','quote_lines')
 order by tablename, policyname;
