-- ═══════════════════════════════════════════════════════════════
-- 22a_preflight.sql — db/22 的前置診斷（唯讀，不改任何資料）
--
-- 為什麼要獨立成一支：SQL Editor 只顯示**最後一個** select 的結果，
-- db/22 整支貼進去的話，開頭的診斷會被結尾的 A7 驗收 select 蓋掉，
-- 等於沒看過診斷就把約束建下去了。
--
-- 【怎麼判讀】四列的 cnt 必須**全部是 0** 才可以跑 db/22_harden_permissions.sql。
--   任何一列不是 0 就停下來討論，不要自己清資料——db/22 跑在同一個交易裡，
--   約束建不起來會整批 rollback，但你會浪費一輪來回。
-- ═══════════════════════════════════════════════════════════════

-- 第四項（金額為負數）原本不在審查包列的三項裡，是實作時補的：
-- db/22 的 A4 要建 negotiations_amounts_nonneg，少了這一項就會出現
-- 「診斷全綠、整批 migration 卻在 A4 rollback」的白跑一趟。
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


