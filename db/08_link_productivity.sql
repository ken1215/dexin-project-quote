-- 由 scripts/link_productivity.py 產生：品項 ↔ 工率基準 對接
-- 對接後報價單會自動附上「工率分析」頁

update price_items set productivity_id = 'lp-009' where id = 'nw-cable-cat6';  -- 訊號線(網路線) CAT-6 ← CAT-6 網路線天花板內配線
update price_items set productivity_id = 'lp-013' where id = 'nw-rj45-crimp';  -- 網路接頭壓接 ← RJ45 接頭壓接
update price_items set productivity_id = 'lp-014' where id = 'nw-lan-cable';  -- 網路線路測試(網路測線器) ← 網路線路測試（導通測試）
update price_items set productivity_id = 'lp-000' where id = 'pw-cable-3-5-3c';  -- 電纜線 3.5mm² 3C ← 電纜線 3.5mm² 3C 明管／壓條配線
update price_items set productivity_id = 'lp-002' where id = 'pw-cable-2-0-3c';  -- 電纜線 2.0mm² 3C ← 電纜線天花板內／線槽架配線
update price_items set productivity_id = 'lp-002' where id = 'pw-cable-2-0mm';  -- 電纜線2.0mm ← 電纜線天花板內／線槽架配線
update price_items set productivity_id = 'lp-003' where id = 'pw-trunking-pvc-1m';  -- PVC壓條(1M) ← PVC壓條（1號／2號）明線裝設
update price_items set productivity_id = 'lp-003' where id = 'pw-trunking-plain';  -- 壓條 ← PVC壓條（1號／2號）明線裝設
update price_items set productivity_id = 'lp-003' where id = 'pw-trunking-1';  -- 1號壓條(米白色) ← PVC壓條（1號／2號）明線裝設
update price_items set productivity_id = 'lp-004' where id = 'pw-outlet-2';  -- 明盒插座及標示 ← 電源插座出口新增（單點零星作業、明線）
update price_items set productivity_id = 'lp-004' where id = 'pw-outlet-grounded-duplex';  -- 插座(接地雙插附蓋) ← 電源插座出口新增（單點零星作業、明線）
update price_items set productivity_id = 'lp-004' where id = 'pw-outlet-110';  -- 110V雙連插座 ← 電源插座出口新增（單點零星作業、明線）
update price_items set productivity_id = 'lp-004' where id = 'pw-outlet-4';  -- 塑膠插座明盒 ← 電源插座出口新增（單點零星作業、明線）
update price_items set productivity_id = 'lp-004' where id = 'nw-info-socket-cat6';  -- 資訊插座 8pin8c CAT-6 ← 電源插座出口新增（單點零星作業、明線）
update price_items set productivity_id = 'lp-004' where id = 'nw-net-socket-cat6';  -- 網路插座 國際NRF CAT-6 ← 電源插座出口新增（單點零星作業、明線）
update price_items set productivity_id = 'lp-004' where id = 'pw-socket-250v-20a-t';  -- 星光 250V 20A T型插座 ← 電源插座出口新增（單點零星作業、明線）
update price_items set productivity_id = 'lp-004' where id = 'pw-socket-duplex-starlight';  -- 星光雙連插座(附蓋板) ← 電源插座出口新增（單點零星作業、明線）
update price_items set productivity_id = 'lp-004' where id = 'nw-info-socket-module-cat6';  -- 資訊插座模組 CAT-6(單孔) ← 電源插座出口新增（單點零星作業、明線）
update price_items set productivity_id = 'lp-007' where id = 'pw-switch-1p';  -- 無熔絲開關 NFB 1P20A ← 無熔絲開關（NFB）盤內裝設
update price_items set productivity_id = 'lp-007' where id = 'pw-switch-1p-2';  -- 士林1P 20A無熔絲開關 ← 無熔絲開關（NFB）盤內裝設
update price_items set productivity_id = 'lp-007' where id = 'pw-switch';  -- 無熔絲開關 ← 無熔絲開關（NFB）盤內裝設
update price_items set productivity_id = 'lp-007' where id = 'pw-nfb-3p-100a';  -- 無熔絲開關 NFB 3P/100A(含增 ← 無熔絲開關（NFB）盤內裝設
update price_items set productivity_id = 'lp-008' where id = 'pw-surface-box';  -- 明盒 ← 明盒／接線盒裝設
update price_items set productivity_id = 'lp-015' where id = 'hv-insulation-10';  -- 10"鍍鋅管及保溫 ← 圓形鍍鋅風管安裝（管徑≦12英吋，含吊架）
update price_items set productivity_id = 'lp-015' where id = 'hv-gi-duct-12';  -- 12"鍍鋅管 ← 圓形鍍鋅風管安裝（管徑≦12英吋，含吊架）
update price_items set productivity_id = 'lp-015' where id = 'hv-insulation-4';  -- 4"鍍鋅管及保溫 ← 圓形鍍鋅風管安裝（管徑≦12英吋，含吊架）
update price_items set productivity_id = 'lp-015' where id = 'hv-gi-duct-6';  -- 6"鍍鋅管 ← 圓形鍍鋅風管安裝（管徑≦12英吋，含吊架）
update price_items set productivity_id = 'lp-015' where id = 'hv-gi-duct-8';  -- 8"鍍鋅管 ← 圓形鍍鋅風管安裝（管徑≦12英吋，含吊架）
update price_items set productivity_id = 'lp-020' where id = 'hv-insul-hose-10-2';  -- 10"尼龍保溫軟管 ← 冰水／冷媒管路橡塑保溫新作（管徑≦2英吋，含外覆
update price_items set productivity_id = 'lp-020' where id = 'hv-insul-hose-4';  -- 4"尼龍保溫軟管 ← 冰水／冷媒管路橡塑保溫新作（管徑≦2英吋，含外覆
update price_items set productivity_id = 'lp-020' where id = 'hv-insul-wool-1-3';  -- 保溫棉 1"*1"t ← 冰水／冷媒管路橡塑保溫新作（管徑≦2英吋，含外覆
update price_items set productivity_id = 'lp-020' where id = 'hv-insul-wool-1';  -- 保溫棉 1-1/2"*1-1/4"t ← 冰水／冷媒管路橡塑保溫新作（管徑≦2英吋，含外覆
update price_items set productivity_id = 'lp-020' where id = 'hv-insul-wool-1-2';  -- 保溫棉 1-1/4"*1-1/4"t ← 冰水／冷媒管路橡塑保溫新作（管徑≦2英吋，含外覆
update price_items set productivity_id = 'lp-020' where id = 'hv-insul-wool-2';  -- 保溫棉 2"*1-1/4"t ← 冰水／冷媒管路橡塑保溫新作（管徑≦2英吋，含外覆
update price_items set productivity_id = 'lp-020' where id = 'hv-insul-wool-3';  -- 保溫棉 3/4"*1"t ← 冰水／冷媒管路橡塑保溫新作（管徑≦2英吋，含外覆
update price_items set productivity_id = 'lp-020' where id = 'hv-insul-pipe-3';  -- 保溫管3/4" ← 冰水／冷媒管路橡塑保溫新作（管徑≦2英吋，含外覆
update price_items set productivity_id = 'lp-020' where id = 'hv-insul-mat-per-m';  -- 橡塑發泡保溫材(管用) ← 冰水／冷媒管路橡塑保溫新作（管徑≦2英吋，含外覆
update price_items set productivity_id = 'lp-020' where id = 'hv-insul-ancillary-per-m';  -- 保溫另料(膠水、收邊、束帶) ← 冰水／冷媒管路橡塑保溫新作（管徑≦2英吋，含外覆
update price_items set productivity_id = 'lp-020' where id = 'hv-insul-labor-per-m';  -- 管路保溫施作工資(基本) ← 冰水／冷媒管路橡塑保溫新作（管徑≦2英吋，含外覆
update price_items set productivity_id = 'lp-020' where id = 'hv-insul-saddle-per-m';  -- 保溫管墊施作(含料) ← 冰水／冷媒管路橡塑保溫新作（管徑≦2英吋，含外覆
update price_items set productivity_id = 'lp-020' where id = 'hv-insul-pvc-wrap-per-m';  -- 保溫外覆白色PVC帶(含料工) ← 冰水／冷媒管路橡塑保溫新作（管徑≦2英吋，含外覆
update price_items set productivity_id = 'lp-020' where id = 'hv-insul-demo-per-m';  -- 舊保溫層拆除工資 ← 冰水／冷媒管路橡塑保溫新作（管徑≦2英吋，含外覆
update price_items set productivity_id = 'lp-020' where id = 'hv-insul-labor-full-m';  -- 管路保溫施作工資(加強版) ← 冰水／冷媒管路橡塑保溫新作（管徑≦2英吋，含外覆
update price_items set productivity_id = 'lp-020' where id = 'hv-insul-saddle-mat-m';  -- 保溫管墊材料 ← 冰水／冷媒管路橡塑保溫新作（管徑≦2英吋，含外覆
update price_items set productivity_id = 'lp-022' where id = 'hv-install';  -- 室內機安裝定位 ← 分離式冷氣室內機吊掛定位
update price_items set productivity_id = 'lp-022' where id = 'hc-split-indoor';  -- 分離式冷氣室內機清洗 ← 分離式冷氣室內機吊掛定位
update price_items set productivity_id = 'lp-022' where id = 'hv-refrig-piping-per-iu';  -- 冷媒配管工程(每台室內機) ← 分離式冷氣室內機吊掛定位
update price_items set productivity_id = 'lp-017' where id = 'hv-box-fan-1';  -- 1/2hp箱型風機 ← 箱型風機吊掛安裝（≦1HP）
update price_items set productivity_id = 'lp-017' where id = 'hv-box-fan-1hp';  -- 1hp箱型風機 ← 箱型風機吊掛安裝（≦1HP）
update price_items set productivity_id = 'lp-017' where id = 'hv-fan-duct-hanger-set';  -- 風機及風管吊架固定架(每台風機) ← 箱型風機吊掛安裝（≦1HP）
update price_items set productivity_id = 'lp-018' where id = 'hv-blower-800cfm';  -- 送風機 800CFM ← 小型送風機（800CFM級）汰換
update price_items set productivity_id = 'lp-018' where id = 'hv-blower-800';  -- 鑫國小型送風機800型/左接 ← 小型送風機（800CFM級）汰換
update price_items set productivity_id = 'lp-018' where id = 'hv-blower-1000cfm';  -- 送風機1000CFM (左接1) ← 小型送風機（800CFM級）汰換
update price_items set productivity_id = 'lp-018' where id = 'hv-blower-1200cfm';  -- 送風機1200CFM (左接1) ← 小型送風機（800CFM級）汰換
update price_items set productivity_id = 'lp-018' where id = 'hv-blower-600cfm';  -- 送風機600CFM (右接1) ← 小型送風機（800CFM級）汰換
update price_items set productivity_id = 'lp-018' where id = 'hv-blower-accessory-kit';  -- 小型送風機配件包(銅閘閥、控制線、銜接保 ← 小型送風機（800CFM級）汰換
update price_items set productivity_id = 'lp-025' where id = 'fn-floor-pvc-m2';  -- PVC 同質透心地磚鋪設 ← PVC地磚鋪設（面積≧20m²，不含舊地板拆除）
update price_items set productivity_id = 'lp-027' where id = 'fn-paint-new-m2';  -- 牆面水泥漆（新作面．全批土） ← 內牆批土刷水泥漆（新牆、面積≧50m²、一底二度
update price_items set productivity_id = 'lp-027' where id = 'fn-paint-old-m2';  -- 牆面水泥漆（舊作面．批土修補） ← 內牆批土刷水泥漆（新牆、面積≧50m²、一底二度
update price_items set productivity_id = 'lp-028' where id = 'fn-wall-plaster-paint-m2';  -- 牆面整平及粉刷工資 ← 舊牆整平粉刷含水泥漆（小面積、含補土修補）
update price_items set productivity_id = 'lp-029' where id = 'fn-ceil-cs-m2';  -- 矽酸鈣板天花板（連工帶料） ← 輕鋼架明架天花板（礦纖／PVC／矽酸鈣板）
update price_items set productivity_id = 'lp-032' where id = 'fn-partition-m2';  -- 輕隔間（矽酸鈣板雙面） ← 輕隔間（輕鋼架矽酸鈣板乾式雙面封板）
update price_items set productivity_id = 'lp-035' where id = 'fn-pvc-floor-labor-m2';  -- PVC地板拆除及鋪設工資 ← 輕隔間／天花板人工拆除（含裝袋）
update price_items set productivity_id = 'lp-036' where id = 'cm-waste-truck';  -- 營建廢棄物清運(3.5噸車) ← 事業廢棄物人工裝車（3.5噸車）

select count(*) as 已對接 from price_items where productivity_id is not null and active;
