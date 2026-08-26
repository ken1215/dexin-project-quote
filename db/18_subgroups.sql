-- ═══════════════════════════════════════════════════════════════
-- 18_subgroups.sql — 單價庫加一層「子分類」，同質品項收在一起
--
-- 大類底下是一長串平表：空調通風 96 項、配電 34 項，同仁要在 96 列裡
-- 找一顆 6" 鍍鋅管。加一層子分類把同質的收在一起，並把 sort 重排成
-- 「子分類基數 + 組內序號」，既有的 order by sort 就自動分組。
--
-- 只有品項多到需要分的大類才給子分類；消防(3)、共通費用(5)、其他(4)
-- 維持空字串＝不分組。
-- ═══════════════════════════════════════════════════════════════

alter table price_items add column if not exists subgroup text not null default '';

with g(sub, base, ids) as (values
  -- ── 配電工程 ──
  ('導線與電纜', 1010, array['pw-cable-3-5-3c','pw-cable-2-0-3c','pw-cable-1-25-2','pw-cable-1-25','pw-cable-2-0mm-2','pw-cable-1-25mm','pw-cable-2-0mm-3','pw-cable-2-0mm','pw-power-supply-2']),
  ('管槽與配件', 1020, array['pw-trunking-pvc-1m','pw-trunking-plain','pw-trunking-1','pw-trunking-5','pw-pvc','pw-conduit-3','pw-flex-hose','pw-junction-box-zhengya','pw-junction-box','pw-surface-box','pw-outlet-4']),
  ('插座與面板', 1030, array['pw-outlet-2','pw-outlet-grounded-duplex','pw-outlet-110','pw-socket-250v-20a-t','pw-socket-duplex-starlight','pw-outlet-3']),
  ('開關與保護裝置', 1040, array['pw-switch-1p','pw-switch-1p-2','pw-switch','pw-nfb-3p-100a']),
  ('電源設備與指示', 1050, array['pw-transformer-2','pw-transformer-5','pw-lamp-set','pw-panel']),

  -- ── 網路通訊工程 ──
  ('線材與接頭', 2010, array['nw-cable-cat6','nw-patch-cord','nw-jumper-cord','nw-rj45-plug-6']),
  ('插座與面板', 2020, array['nw-info-panel','nw-info-socket-cat6','nw-net-socket-cat6','nw-info-socket-module-cat6']),
  ('施工與測試', 2030, array['nw-rj45-crimp','nw-lan-cable']),

  -- ── 空調通風工程 ──
  ('空調主機與冷媒', 3010, array['hv-fdc140vnat-w-140','hv-fdt140vht-140','hv-fdt50vht-50','hv-t-psae-5','hv-rc-ext3-3','hv-compressor-21','hv-air-curtain-110','hv-refrigerant-134a','hv-refrigerant-22','hv-refrig-oil','hv-refrigerant','hv-piping-5','hv-piping-4','hv-copper-pipe','hv-refrig-piping-per-iu']),
  ('風管與板金管件', 3020, array['hv-gi-duct-4','hv-gi-duct-6','hv-gi-duct-8','hv-gi-duct-10','hv-gi-duct-10-2','hv-gi-duct-12','hv-insulation-4','hv-insulation-10','hv-elbow-12-gi','hv-sq-to-rd-12','hv-tee-12','hv-fitting-adder-6','hv-fitting-adder-8','hv-nylon-hose-6','hv-nylon-hose-10','hv-insul-hose-10','hv-insul-hose-10-2','hv-insul-hose-4','hv-flex-hose-6','hv-duct-2','hv-box-fan','hv-sus304-304-2','hv-sus304-304-3','hv-sus304-plate-400x300']),
  ('風口與風箱', 3030, array['hv-return-grille-abs600','hv-supply-diffuser-600','hv-air-grille','hv-return-box-600cfm','hv-return-box-800cfm','hv-return-box-1000cfm','hv-return-box-1200cfm','hv-plenum-600cfm','hv-plenum-800cfm','hv-plenum-1000cfm','hv-plenum-1200cfm','hv-plenum-800']),
  ('送風機與風機', 3040, array['hv-blower-600cfm','hv-blower-800cfm','hv-blower-1000cfm','hv-blower-1200cfm','hv-blower-800','hv-box-fan-1','hv-box-fan-1hp','hv-blower-accessory-kit']),
  ('水路與閥件', 3050, array['hv-motor-valve-honeywell-34','hv-gate-valve-2','hv-two-way-valve','hv-expansion-tank-800','hv-piping-8','hv-cw-pipe-cut','hv-cw-pipe-cap','hv-cw-drain-recovery','hv-drain-piping-per-iu','hv-sus304-304','hv-elbow-304']),
  ('保溫材料與施作', 3060, array['hv-insul-wool-3','hv-insul-wool-1-3','hv-insul-wool-1-2','hv-insul-wool-1','hv-insul-wool-2','hv-insul-pipe-3','hv-insul-mat-per-m','hv-insul-ancillary-per-m','hv-insul-saddle-per-m','hv-insul-saddle-mat-m','hv-insul-pvc-wrap-per-m','hv-insul-adhesive-per-m','hv-insul-labor-per-m','hv-insul-labor-full-m','hv-insul-demo-per-m','hv-pipe-marking-per-m']),
  ('控制與電氣', 3070, array['hv-temp-controller-723','hv-controller','hv-sensor','hv-wired-controller','hv-control-commission-per-ahu']),
  ('安裝、拆除與搬運', 3080, array['hv-install','hv-install-2','hv-install-3','hv-ahu','hv-ahu-2']),

  -- ── 空調清潔保養工程 ──
  ('冷氣機清洗', 4010, array['hc-split-indoor','hc-split-outdoor','hc-cassette-4way','hc-ducted-split','hc-window-package']),
  ('風機與風管清洗', 4020, array['hc-blower-small','hc-blower-box','hc-exhaust-fan','hc-duct-clean']),
  ('濾網與排水', 4030, array['hc-filter-wash','hc-filter-replace','hc-drain-clean']),
  ('大型設備保養', 4040, array['hc-ahu','hc-cooling-tower']),
  ('檢測與巡檢', 4050, array['hc-refrigerant-check','hc-inspection']),

  -- ── 裝修工程 ──
  ('地坪工程', 5010, array['fn-floor-tile-2-35','fn-floor-pvc-m2','fn-floor-spc-m2','fn-pvc-floor-labor-m2']),
  ('牆面與天花', 5020, array['fn-paint-new-m2','fn-paint-old-m2','fn-wall-plaster-paint-m2','fn-ceil-cs-m2','fn-partition-m2']),
  ('油漆材料', 5030, array['fn-paint-8-3','fn-paint-hong-5gal']),
  ('泥作與土方', 5040, array['fn-wire-mesh-3','fn-concrete-3000p','fn-concrete-place-m2','fn-water-barrier','fn-site-clear-grade-m2','fn-trench-conduit-tile-m']),
  ('雜項與收邊', 5050, array['fn-maintenance-opening','fn-acrylic','fn-silicone','fn-woodwork']),

  -- ── 門禁保全工程 ──
  ('門禁設備', 6010, array['ac-mag-lock-0600p','ac-mag-lock','ac-card-reader-721','ac-fingerprint-30']),
  ('感測與警報', 6020, array['ac-switch','ac-sensor-601','ac-call-bell-receiver','ac-call-bell-button'])
)
update price_items p
   set subgroup = g.sub,
       sort = g.base + u.idx::int
  from g, unnest(g.ids) with ordinality as u(id, idx)
 where p.id = u.id;

-- 檢查 1：每個大類的子分類與筆數
select category_id, subgroup, count(*) from price_items
 group by category_id, subgroup order by min(sort);
