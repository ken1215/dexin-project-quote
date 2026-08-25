-- 新增工程大項：空調清潔保養工程
--
-- 與既有「空調通風工程」的分別：那個是新建／汰換／管路施作（一次性工程），
-- 這個是週期性的清潔、保養、濾網更換。以院內小型設備為主：
-- 小冷（分離式）、小型送風機、四方吹（嵌入式）等。
--
-- ⚠ 品項分兩批，理由寫在這裡免得日後有人以為是漏填：
--   【啟用】有公開市場行情可依（洗冷氣屬消費性服務，行情公開）。
--   【停用．待核定】小型送風機、箱型風機、濾網清洗這類**沒有公開行情**，
--     自家 73 份歷史報價單裡也只有「汰換」沒有「清洗」的紀錄。
--     單價留 0 且預設停用，同仁選不到；主管核定後自行啟用。
--     evidence_note 裡寫的是「怎麼核定」的方法（工率法），不是我猜的數字——
--     寧可空著讓主管填，也不要給一個編出來的價格上戰場。

insert into categories (id, name, section_title, sort) values
  ('hvac_clean', '空調清潔保養工程', '空調清潔保養工程', 25)
on conflict (id) do update set name = excluded.name, section_title = excluded.section_title;

insert into evidence_sources (id, kind, name, publisher, url, note) values
  ('market_hvac_clean', 'market', '2026 台灣冷氣清洗服務行情', '公開清潔服務平台彙整',
   'https://www.jackercleaning.com/blog/286',
   '分離式 1,999~3,500 元/台；四方吹（嵌入式）、箱型因需拆卸面板或機殼，行情較高。'
   '此為住宅／商辦行情，醫療場域另有感控要求與停機時段限制，主管須覆核後調整')
on conflict (id) do update set name = excluded.name, url = excluded.url, note = excluded.note;

-- ══ 【啟用】有市場行情依據 ═══════════════════════════════════
insert into price_items
  (id, category_id, name, spec, unit, cost_type, std_price,
   evidence_id, evidence_note, price_min, price_max, price_median, samples, active, sort)
values
  ('hc-split-indoor', 'hvac_clean', '分離式冷氣室內機清洗',
   '含拆蓋、蒸發器藥洗、排水盤清理、風輪清潔', '台', 'labor', 2000, 'market_hvac_clean',
   '公開行情 1,999~3,500 元/台（2026）。取區間下緣；醫療場域若須感控管制或限夜間施作另計',
   1999, 3500, 2400, 0, true, 10),

  ('hc-split-outdoor', 'hvac_clean', '分離式冷氣室外機清洗',
   '含冷凝器高壓沖洗、外殼清潔', '台', 'labor', 1200, 'market_hvac_clean',
   '室外機單獨施作行情約 1,000~1,500 元/台', 1000, 1500, 1200, 0, true, 20),

  ('hc-cassette-4way', 'hvac_clean', '四方吹（嵌入式）冷氣清洗',
   '含拆卸出風面板、風輪與盤管藥洗、排水盤清理', '台', 'labor', 3500, 'market_hvac_clean',
   '須拆卸天花板出風面板與風輪，工時明顯高於分離式；行情 3,000~4,500 元/台',
   3000, 4500, 3500, 0, true, 30),

  ('hc-ducted-split', 'hvac_clean', '吊隱式冷氣清洗',
   '含拆卸維修口、盤管藥洗、排水處理', '台', 'labor', 3500, 'market_hvac_clean',
   '須自天花板維修口進入施作；行情 3,000~4,500 元/台', 3000, 4500, 3500, 0, true, 40),

  ('hc-window-package', 'hvac_clean', '窗型／箱型冷氣清洗',
   '含機殼拆卸、盤管藥洗', '台', 'labor', 3000, 'market_hvac_clean',
   '機殼拆卸費工，行情高於分離式；行情 2,500~4,000 元/台', 2500, 4000, 3000, 0, true, 50)
on conflict (id) do update set
  category_id = excluded.category_id, name = excluded.name, spec = excluded.spec,
  unit = excluded.unit, std_price = excluded.std_price, evidence_id = excluded.evidence_id,
  evidence_note = excluded.evidence_note, price_min = excluded.price_min,
  price_max = excluded.price_max, price_median = excluded.price_median,
  active = excluded.active, sort = excluded.sort;

-- ══ 【停用．待主管核定】無公開行情，用工率法核定 ══════════════
-- 核定方法：單價 = 技術工日薪(2,800) ÷ 一個工日可施作台數
--   例：若一個工可洗 4 台小型送風機 → 2,800 ÷ 4 = 700 元/台（再加耗材）
-- 主管在「單價維護」填入單價並勾選啟用後，同仁才選得到。
insert into price_items
  (id, category_id, name, spec, unit, cost_type, std_price, evidence_note, samples, active, sort)
values
  ('hc-blower-small', 'hvac_clean', '小型送風機清洗保養',
   '600~1200CFM，含葉輪、機殼、濾網清洗、軸承檢查', '台', 'labor', 0,
   '【待主管核定】無公開行情，歷史報價單僅有汰換（10,200~15,750 元/台）無清洗紀錄。'
   '建議以工率法核定：2,800 元 ÷ 一個工日可施作台數，再加耗材', 0, false, 60),

  ('hc-blower-box', 'hvac_clean', '箱型風機清洗保養',
   '1/2HP~1HP，含葉輪、機殼、防震布管檢查', '台', 'labor', 0,
   '【待主管核定】同上，歷史僅有汰換價（19,500~22,000 元/台）。以工率法核定', 0, false, 70),

  ('hc-exhaust-fan', 'hvac_clean', '排風機清洗保養',
   '含葉輪、機殼、軸承檢查', '台', 'labor', 0,
   '【待主管核定】依機型與吊掛位置（是否需高空作業）以工率法核定', 0, false, 80),

  ('hc-filter-wash', 'hvac_clean', '濾網清洗（可重複使用）',
   '含拆裝、水洗、晾乾、回裝', '只', 'labor', 0,
   '【待主管核定】以工率法核定；回風箱濾網、回風口抽取式濾網皆適用', 0, false, 90),

  ('hc-filter-replace', 'hvac_clean', '濾網更換',
   '含新品、拆裝、舊品清運', '只', 'material', 0,
   '【待主管核定】依尺寸規格核定；參考回風口附抽取式濾網 ABS600*600 新品 1,170 元/台', 0, false, 100),

  ('hc-drain-clean', 'hvac_clean', '排水盤清理與排水管疏通',
   '含排水盤刷洗、排水管高壓疏通、滴水測試', '台', 'labor', 0,
   '【待主管核定】以工率法核定。此項是病房漏水客訴的主因，建議獨立計價便於追蹤', 0, false, 110),

  ('hc-refrigerant-check', 'hvac_clean', '冷媒壓力檢測',
   '含高低壓量測、記錄', '台', 'labor', 0,
   '【待主管核定】以工率法核定；冷媒補充另計（冷媒屬材料，依公斤計）', 0, false, 120),

  ('hc-belt-replace', 'hvac_clean', '風機皮帶更換',
   '含新品、張力調整', '條', 'material', 0,
   '【待主管核定】依皮帶規格核定', 0, false, 130),

  ('hc-inspection', 'hvac_clean', '空調設備定期巡檢',
   '含運轉紀錄、異音振動檢查、巡檢報告', '次', 'labor', 0,
   '【待主管核定】依巡檢台數與頻率核定，建議以「元/次」搭配巡檢清單', 0, false, 140),

  -- 以下為院內大型設備，非本大項主要用途，一併備著
  ('hc-ahu', 'hvac_clean', '空調箱(AHU)清洗保養',
   '含濾網、盤管、風機、排水盤', '台', 'labor', 0,
   '【待主管核定】依機型噸數與感控要求個案核定', 0, false, 200),

  ('hc-cooling-tower', 'hvac_clean', '冷卻水塔清洗',
   '含填充材、集水盤、散水器', '台', 'labor', 0,
   '【待主管核定】依水塔噸數與登高作業條件核定', 0, false, 210),

  ('hc-duct-clean', 'hvac_clean', '風管內部清洗',
   '含刷洗、集塵、前後對照紀錄', '米', 'labor', 0,
   '【待主管核定】依管徑與作業條件核定，以「元/米」計價便於逐案比對', 0, false, 220)
on conflict (id) do update set
  category_id = excluded.category_id, name = excluded.name, spec = excluded.spec,
  unit = excluded.unit, evidence_note = excluded.evidence_note,
  active = excluded.active, sort = excluded.sort;
