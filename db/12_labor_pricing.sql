-- ═══════════════════════════════════════════════════════════════
-- 12_labor_pricing.sql — 工資計價改為「牌價 3,000 × 物管合約 9 折」
--
-- 使用者 2026-08-25 定案，取代先前的「成本 2,800 × 加成係數 1.15」。
--
-- 為什麼這樣算比較好：
--   1. 牌價 3,000 元/工 直接對齊臺北市政府工程預算參考單價之技術工單價
--      （375 元/時 × 8 小時），是官方公開數字，對院方採購最好解釋。
--   2. 這些師傅的薪資已由院方透過物業管理合約月費支付。同一批人做專案，
--      報價再收全額工資，等於向同一個客戶為同一段工時收第二次錢——
--      這與德新 2026-08-25「自行承攬不得再收管理費」的收費界線是同一個道理。
--      改以「9 折優惠」呈現，界線講得清楚，而且每張報價單都在展示物管合約的價值。
--   3. 折扣是給客戶的好處，可以（也應該）印在報價單上；
--      先前的「成本 + 加成」則是自家底牌，印出去等於把利潤率交給對方。
--
-- 實際計價：3,000 × 0.9 × 勞基法時段係數
--   平日 ×1.00 → 2,700    平日延時 ×1.34 → 3,618
--   休息日 ×1.67 → 4,509  例假日/國定假日 ×2.00 → 5,400
-- ═══════════════════════════════════════════════════════════════

-- 牌價改為 3,000（原 2,800 是成本基準，語意已不同）
update settings set value = '3000'::jsonb where key = 'labor_base_daily';

-- 加成係數 → 物業合約優惠折數
delete from settings where key = 'labor_markup';
insert into settings (key, value) values ('labor_discount', '0.9'::jsonb)
on conflict (key) do update set value = excluded.value;

-- 單一工資品項：時段由開單時的下拉決定，不要一個時段一個品項
update price_items
   set name = '技術工日薪',
       spec = '含勞健保、勞退等雇主法定負擔；時段加成於開單時選擇',
       std_price = 2700,
       evidence_note =
         '牌價 3,000 元/工，對齊臺北市政府工程預算參考單價之技術工單價（375 元/時 × 8 小時）；'
         '因本院已訂有物業管理合約，本項按牌價 9 折計價為 2,700 元/工。'
         '法定下限為勞動部基本工資時薪 196 元 × 8 小時 = 1,568 元/工。'
         '夜間、休息日及例假日之加成依勞動基準法第 24、39 條計算'
 where id = 'lb-tech-day';

-- 這四項與時段下拉重複，且單價是舊口徑，停用避免同仁選錯
update price_items
   set active = false,
       evidence_note = '【已停用】與開單時的「時段」下拉功能重複，請改用「技術工日薪」並於該列選擇時段'
 where id in ('lb-tech-day-regular', 'lb-tech-day-ot',
              'lb-tech-day-restday', 'lb-tech-day-holiday');

-- 檢查
select key, value from settings where key in ('labor_base_daily', 'labor_discount')
union all
select id, to_jsonb(std_price) from price_items where unit = '工' and active;
