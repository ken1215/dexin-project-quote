-- 單位與品名清理
--
-- 1. 大寫 M / M2 是原始 PDF 的寫法，正規化成 米 / m²（使用者要求裝修統一 m²）。
-- 2. 品名裡的「約 X 坪」是當初那一案的施作面積註記，不是品項規格。
--    留在單價庫裡會讓同仁誤以為「一箱就是 2.35 坪」，而這正是拆解時誤讀的來源。
--    移到 spec 欄並改寫成中性描述。

update price_items set unit = 'm²' where unit in ('M2', 'M²', 'm2');
update price_items set unit = '米'  where unit = 'M';

update price_items
   set name = '虹牌水性漆',
       spec = '一加崙裝；塗佈面積依牆面狀況與塗裝道數而異，報價時以實際 m² 計'
 where id = (select id from price_items where name like '虹牌水性漆%' and unit = '加崙' limit 1);

update price_items
   set name = 'PVC 地磚（材料）',
       spec = '一箱裝；鋪設面積以實際 m² 計，勿以箱數推估面積'
 where id = (select id from price_items where name like 'PVC地磚 約%' and unit = '箱' limit 1);

-- 「開維修孔」單位「口」語意不明（是「處」的誤植），一併正名
update price_items set unit = '處' where unit = '口';

-- 檢查結果
select unit, count(*) as n
  from price_items where active
 group by unit order by n desc;
