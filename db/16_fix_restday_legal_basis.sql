-- ═══════════════════════════════════════════════════════════════
-- 16_fix_restday_legal_basis.sql — 休息日加給的條號改正
--
-- 勞動基準法沒有「第 24 條之 1」。休息日出勤加給的條文是
-- 第 24 條第 2 項（工作 2 小時內另給 1⅓ 以上，2 小時後 1⅔ 以上）。
-- 這串字會印在給聯新國際醫院採購看的報價單上，引錯條號會被挑。
-- ═══════════════════════════════════════════════════════════════

update labor_rates
   set legal_basis = '勞基法 §24 II 休息日出勤加給'
 where id = 'restday';

-- 檢查
select id, name, multiplier, legal_basis from labor_rates order by sort;
