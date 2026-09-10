-- ═══════════════════════════════════════════════════════════════
-- 24_company_naming.sql — 對外名稱統一為「德新物業」
--
-- 介面與文件一律用「德新物業」；法人抬頭（報價單、登入頁、佐證來源
-- 的發布單位）保留登記名稱並加註，寫成「立德新股份有限公司(德新物業)」。
-- 歷史報價單的檔名引用（catalog-v1.json、db/06 的 evidence_note）
-- 一律不動——那是佐證要回頭找的實際檔名。
--
-- 種子檔（db/02_seed.sql）已同步改過，這支是給既有線上資料庫補改。
-- ═══════════════════════════════════════════════════════════════

update settings
   set value = '"立德新股份有限公司(德新物業)"'::jsonb
 where key = 'company';

update evidence_sources
   set name      = '德新物業對聯新國際醫院歷史報價紀錄',
       publisher = '立德新股份有限公司(德新物業)'
 where id = 'history';

-- 檢查
select key, value from settings where key = 'company';
select id, name, publisher from evidence_sources where id = 'history';
