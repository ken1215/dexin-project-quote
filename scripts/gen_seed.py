# -*- coding: utf-8 -*-
"""由 catalog-v1.json（73 份歷史報價單解析結果）產生 Supabase seed SQL。

轉換規則（都是使用者指定的口徑，不是我自己發明的）：
  1. 工資／施工費的「式」計價項目 → 停用，改由「技術工日薪 2,800/工 × 時段係數」取代。
  2. 裝修工程單位統一 m²；歷史上以「式」報價、無面積可回推的，保留但標 needs_area。
  3. 每個品項掛佐證來源（官方指數／法規／市場行情／自家歷史成交）。
"""
import io, json, os, re, sys

sys.stdout.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
CAT = json.load(io.open(os.path.join(HERE, 'catalog-v1.json'), encoding='utf-8'))
OUT = os.path.join(HERE, '..', 'db', '02_seed.sql')
TODAY = '2026-08-25'
PING = 3.3058  # 1 坪 = 3.3058 m²

q = lambda s: "'" + str(s).replace("'", "''") + "'"
n = lambda v: 'null' if v is None else str(v)


# ── 佐證來源 ────────────────────────────────────────────────────
EVIDENCE = [
    ('cci',        'index', '營造工程物價指數（CCI）總指數', '行政院主計總處',
     'https://www.stat.gov.tw/Statistics.aspx?n=3906&CaN=460',
     '政府工程物價調整條款之法定依據，基期 110年=100，每月發布'),
    ('cci_labor',  'index', 'CCI 勞務類指數', '行政院主計總處',
     'https://nstatdb.dgbas.gov.tw/dgbasAll/webMain.aspx?sys=210&funid=A030502015',
     '營造工程工資水準之官方指數'),
    ('cci_elec',   'index', 'CCI 中分類 電力設備類指數', '行政院主計總處',
     'https://nstatdb.dgbas.gov.tw/dgbasAll/webMain.aspx?sys=210&funid=A030502015',
     '對應電纜、開關、配線器材'),
    ('cci_metal',  'index', 'CCI 中分類 金屬製品類指數', '行政院主計總處',
     'https://nstatdb.dgbas.gov.tw/dgbasAll/webMain.aspx?sys=210&funid=A030502015',
     '對應風管、支撐架、鷹架、五金'),
    ('cci_plastic','index', 'CCI 中分類 塑膠製品類指數', '行政院主計總處',
     'https://nstatdb.dgbas.gov.tw/dgbasAll/webMain.aspx?sys=210&funid=A030502015',
     '對應 PVC 管料、壓條、地磚'),
    ('copper',     'market','銅金屬國內量價走勢', '經濟部 基本金屬供需情勢發展監控平台',
     'https://chart.metaltrade.tw/cu/ndomestic/',
     '電纜線之原物料佐證；2026-07 均價 13,524.5 美元/公噸，年增 38.3%'),
    ('minwage',    'law',   '基本工資（115年1月1日起適用）', '勞動部',
     'https://www.mol.gov.tw/',
     '月薪 29,500 元、時薪 196 元，調幅 3.18%（勞動部 2025-09-26 公告）。'
     '時薪 196×8h=1,568 元為單日工資法定下限'),
    ('lsa',        'law',   '勞動基準法 §24、§39 工時加給', '勞動部',
     'https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=N0030001',
     '§24 延長工時前2小時加給 1/3 以上、再延長加給 2/3 以上；§39 例假日及國定假日出勤工資加倍發給'),
    ('market_deco','market','2026 台灣室內裝修工程行情（每坪）', '公開裝修報價平台彙整',
     'https://www.pro360.com.tw/price/drywall',
     '住宅裝修行情，換算 m² 為 ÷3.3058。醫療場域規格較高，主管須覆核後調整'),
    ('history',    'history','立德新對聯新國際醫院歷史報價紀錄', '立德新股份有限公司',
     '', '2025-11 至 2026-08 共 73 份報價單、438 筆工料明細之實際成交單價'),
]

# ── 指數現值（主管每月更新；此為建置日查得之基準） ──────────────
INDICES = [
    ('cci',        'CCI 總指數',        'cci',        '指數', '110年=100', 100, '待主管更新', 100),
    ('cci_labor',  'CCI 勞務類指數',    'cci_labor',  '指數', '110年=100', 100, '待主管更新', 100),
    ('cci_elec',   'CCI 電力設備類',    'cci_elec',   '指數', '110年=100', 100, '待主管更新', 100),
    ('cci_metal',  'CCI 金屬製品類',    'cci_metal',  '指數', '110年=100', 100, '待主管更新', 100),
    ('cci_plastic','CCI 塑膠製品類',    'cci_plastic','指數', '110年=100', 100, '待主管更新', 100),
    ('copper',     '銅價（國內）',      'copper',     '美元/公噸', '2026-07', 13524.5, '2026-07', 13524.5),
]

# ── 工資時段加成（勞基法） ──────────────────────────────────────
LABOR_RATES = [
    ('weekday',  '平日（正常工時）',        1.00, '基準日薪', 1),
    ('overtime', '平日延長工時／夜間',      1.34, '勞基法 §24 加給 1/3 以上', 2),
    ('restday',  '休息日出勤',              1.67, '勞基法 §24-1 休息日出勤加給', 3),
    ('holiday',  '例假日／國定假日',        2.00, '勞基法 §39 工資加倍發給', 4),
]

# ── 裝修工程 m² 標準品項（新建，取代「式」報價） ────────────────
DECO_M2 = [
    ('fn-floor-pvc-m2', 'PVC 同質透心地磚鋪設', '含整地、膠料、收邊', 900,
     847, 968, '醫療級同質透心；行情 2,800~3,200 元/坪 ÷3.3058'),
    ('fn-floor-spc-m2', '塑膠地板鋪設（連工帶料）', 'SPC/長條塑膠地板', 820,
     726, 1089, '行情 2,400~3,600 元/坪 ÷3.3058'),
    ('fn-paint-new-m2', '牆面水泥漆（新作面．全批土）', '一底二度', 480,
     424, 545, '行情 1,400~1,800 元/坪 ÷3.3058'),
    ('fn-paint-old-m2', '牆面水泥漆（舊作面．批土修補）', '一底二度', 350,
     303, 408, '行情 1,000~1,350 元/坪 ÷3.3058'),
    ('fn-ceil-cs-m2',   '矽酸鈣板天花板（連工帶料）', '含輕鋼架', 950,
     756, 1210, '行情 2,500~4,000 元/坪 ÷3.3058'),
    ('fn-partition-m2', '輕隔間（矽酸鈣板雙面）', '含骨料、隔音棉', 1500,
     1059, 2420, '行情 3,500~8,000 元/坪 ÷3.3058；依填充材料差異大'),
]

# 材料 → 指數連動對照（關鍵字比對，連動係數 = 該項成本中原物料佔比之估計）
INDEX_MAP = [
    (('電纜', '電線', '銅'), 'copper',      0.55),
    (('風管', '鍍鋅', '鷹架', '支撐', '五金', '角鐵'), 'cci_metal',   0.40),
    (('PVC', '壓條', '塑膠', '管'),      'cci_plastic', 0.35),
    (('開關', '插座', '配電', 'NFB', '電盤', '燈'), 'cci_elec', 0.30),
]


def pick_index(name, spec, cost_type):
    if cost_type != 'material':
        return None, 0
    hay = name + spec
    for kws, idx, coeff in INDEX_MAP:
        if any(k in hay for k in kws):
            return idx, coeff
    return None, 0


EV_NAME = dict((e[0], e[2]) for e in EVIDENCE)


def evidence_for(it, idx_id):
    """佐證優先序：官方指數連動 > 自家歷史成交(樣本足) > 待補"""
    if idx_id:
        return idx_id, '單價隨 %s 連動調整；歷史成交 %s 筆（%s~%s 元）' % (
            EV_NAME[idx_id], it.get('samples', 0), it.get('price_min'), it.get('price_max'))
    if (it.get('samples') or 0) >= 3:
        return 'history', '依本公司對聯新國際醫院歷史成交 %s 筆，區間 %s~%s 元，中位數 %s 元' % (
            it['samples'], it.get('price_min'), it.get('price_max'), it.get('price_median'))
    return None, ''


LUMP_LABOR = re.compile(r'^(工資|施工費)')

rows_items = []
deactivated, need_area, no_evidence = [], [], []

for i, it in enumerate(CAT['items']):
    cid, name, unit = it['category'], it['name'], it['unit']
    cost = it.get('cost_type', 'material')
    active = True
    needs_area = False
    note_extra = ''

    # (1) 統包式工資 → 停用，改走日薪制
    if LUMP_LABOR.match(name) and unit in ('式', '工'):
        active = False
        note_extra = '【已停用】改由「技術工日薪 2,800 元/工 × 時段係數」計價'
        deactivated.append(name)

    # (2) 裝修類：以「式」報價且無面積者標記待轉 m²
    if cid == 'finish' and unit in ('式', '座', '樘', '處'):
        needs_area = True
        need_area.append(name)

    idx_id, coeff = pick_index(name, it.get('spec', ''), cost)
    ev_id, ev_note = evidence_for(it, idx_id)
    if note_extra:
        ev_note = (note_extra + ('；' + ev_note if ev_note else ''))
    if not ev_id and active:
        no_evidence.append(name)

    rows_items.append((it['id'], cid, name, it.get('spec', ''), unit, cost,
                       it['std_price'], ev_id, ev_note, idx_id, coeff,
                       it.get('price_min'), it.get('price_max'), it.get('price_median'),
                       it.get('samples', 0), it.get('last_seen', ''), it.get('last_price'),
                       needs_area, active, i))

# (3) 新增裝修 m² 標準品項
base = len(rows_items)
for k, (iid, nm, spec, price, lo, hi, note) in enumerate(DECO_M2):
    rows_items.append((iid, 'finish', nm, spec, 'm²', 'material', price,
                       'market_deco', note + '（查詢日 %s）' % TODAY, 'cci_plastic', 0.25,
                       lo, hi, price, 0, '', None, False, True, base + k))

# (4) 新增技術工日薪
rows_items.append(('lb-tech-day', 'common', '技術工日薪', '水電／空調／裝修技術工', '工',
                   'labor', 2800, 'minwage',
                   '法定下限：基本時薪 196 元 × 8 小時 = 1,568 元/日（勞動部 115/1/1 起）；'
                   '本價為營造技術工市場行情，依 CCI 勞務類指數連動。時段加成依勞基法 §24、§39',
                   'cci_labor', 0.80, 2800, 2800, 2800, 0, '', None, False, True, 9000))

CATS = [(c['id'], c['name'], c['name'], k * 10) for k, c in enumerate(CAT['categories'])]

# ── 輸出 SQL ────────────────────────────────────────────────────
w = io.open(OUT, 'w', encoding='utf-8')
w.write('-- 由 scripts/gen_seed.py 產生，請勿手改；改資料請改 catalog-v1.json 或直接在系統內維護\n')
w.write('-- 產生日期：%s\n\n' % TODAY)

w.write('insert into evidence_sources (id,kind,name,publisher,url,note) values\n')
w.write(',\n'.join('  (%s,%s,%s,%s,%s,%s)' % tuple(q(x) for x in e) for e in EVIDENCE))
w.write('\non conflict (id) do update set name=excluded.name, publisher=excluded.publisher,\n'
        '  url=excluded.url, note=excluded.note, kind=excluded.kind;\n\n')

w.write('insert into material_indices (id,name,source_id,unit,base_period,base_value,period,value) values\n')
w.write(',\n'.join('  (%s,%s,%s,%s,%s,%s,%s,%s)' % (q(a), q(b), q(c), q(d), q(e), f, q(g), h)
                   for a, b, c, d, e, f, g, h in INDICES))
w.write('\non conflict (id) do nothing;\n\n')

w.write('insert into categories (id,name,section_title,sort) values\n')
w.write(',\n'.join('  (%s,%s,%s,%d)' % (q(a), q(b), q(c), d) for a, b, c, d in CATS))
w.write('\non conflict (id) do update set name=excluded.name, section_title=excluded.section_title;\n\n')

w.write('insert into labor_rates (id,name,multiplier,legal_basis,sort) values\n')
w.write(',\n'.join('  (%s,%s,%s,%s,%d)' % (q(a), q(b), c, q(d), e) for a, b, c, d, e in LABOR_RATES))
w.write('\non conflict (id) do update set multiplier=excluded.multiplier, legal_basis=excluded.legal_basis;\n\n')

w.write("insert into settings (key,value) values\n"
        "  ('mgmt_fee_rate','0.09'::jsonb),\n"
        "  ('tax_rate','0.05'::jsonb),\n"
        "  ('labor_base_daily','2800'::jsonb),\n"
        "  ('catalog_version','\"v2\"'::jsonb),\n"
        "  ('company','\"立德新股份有限公司\"'::jsonb),\n"
        "  ('client','\"聯新國際醫院\"'::jsonb)\n"
        "on conflict (key) do nothing;\n\n")

w.write('insert into price_items (id,category_id,name,spec,unit,cost_type,std_price,'
        'evidence_id,evidence_note,index_id,index_coeff,price_min,price_max,price_median,'
        'samples,last_seen,last_price,needs_area,active,sort) values\n')
w.write(',\n'.join(
    '  (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%d,%s,%s,%s,%s,%d)' % (
        q(r[0]), q(r[1]), q(r[2]), q(r[3]), q(r[4]), q(r[5]), n(r[6]),
        (q(r[7]) if r[7] else 'null'), q(r[8]), (q(r[9]) if r[9] else 'null'), n(r[10]),
        n(r[11]), n(r[12]), n(r[13]), r[14], q(r[15]), n(r[16]),
        str(bool(r[17])).lower(), str(bool(r[18])).lower(), r[19])
    for r in rows_items))
w.write('\non conflict (id) do update set std_price=excluded.std_price, unit=excluded.unit,\n'
        '  evidence_id=excluded.evidence_id, evidence_note=excluded.evidence_note,\n'
        '  index_id=excluded.index_id, index_coeff=excluded.index_coeff,\n'
        '  needs_area=excluded.needs_area, active=excluded.active;\n')
w.close()

# ── 自我檢查：id 唯一、價格為正、分類存在 ──────────────────────
ids = [r[0] for r in rows_items]
assert len(ids) == len(set(ids)), 'price_items id 重複'
assert all(r[6] is not None and r[6] >= 0 for r in rows_items), '有非正數單價'
cat_ids = {c[0] for c in CATS}
assert all(r[1] in cat_ids for r in rows_items), '有品項指向不存在的分類'

print('OK ->', os.path.abspath(OUT))
print('  品項 %d（含裝修 m² 新品 %d、技術工日薪 1）' % (len(rows_items), len(DECO_M2)))
print('  停用統包工資項 %d：%s' % (len(deactivated), '、'.join(deactivated)))
print('  裝修待轉 m² %d 項' % len(need_area))
print('  無佐證待補 %d 項（佐證覆蓋率 %.0f%%）' % (
    len(no_evidence), 100 * (1 - len(no_evidence) / len(rows_items))))
print('  自我檢查：id 唯一 / 單價為正 / 分類存在 全部 PASS')
