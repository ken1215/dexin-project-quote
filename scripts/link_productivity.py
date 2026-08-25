# -*- coding: utf-8 -*-
"""把 labor_productivity 的工率基準對接到 price_items。

對接後報價單才會出現「工率分析」那一頁。
比對用關鍵詞規則而不是字串相似度——工程品名的用詞差異太大
（「電纜線 3.5mm² 3C」vs「電纜線 3.5mm² 3C 明管／壓條配線」），
相似度演算法會給出一堆看似合理但錯的配對，那比沒對接更糟。

產出 db/08_link_productivity.sql；未對接的會列出來讓主管手動指定。
"""
import io, json, os, subprocess, sys

sys.stdout.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..')
OUT = os.path.join(ROOT, 'db', '08_link_productivity.sql')
SCRATCH = r'C:/Users/linchy/AppData/Local/Temp/claude/C--Users-linchy/5e4427fc-fe20-4c20-bf99-eb42805f9130/scratchpad'

q = lambda s: "'" + str(s).replace("'", "''") + "'"


def db(sql, tag):
    """跑 SQL 並取回 rows（CLI 輸出前面有雜訊，要從第一個 { 開始切）"""
    p = os.path.join(SCRATCH, tag + '.json')
    with io.open(p, 'w', encoding='utf-8') as f:
        subprocess.run(['npx', '--yes', 'supabase', 'db', 'query', '--linked', sql],
                       cwd=ROOT, stdout=f, stderr=subprocess.STDOUT, shell=True, timeout=300)
    raw = io.open(p, encoding='utf-8', errors='replace').read()
    i = raw.find('{')
    return json.loads(raw[i:raw.rfind('}') + 1]).get('rows', [])


items = db("select id, category_id, name, spec, unit, cost_type from price_items where active", 'li_items')
prods = db("select id, trade, work_item, unit from labor_productivity", 'li_prods')
print('啟用品項 %d、工率基準 %d' % (len(items), len(prods)))

# (工率 id 關鍵詞, 品項必須含的關鍵詞, 品項單位須相符)
# 關鍵詞用「且」的關係：品項名要全部包含才算命中。寧可漏配也不要錯配。
RULES = [
    ('CAT-6 網路線天花板內配線', ['網路線'], ['米']),
    ('CAT-6 網路線明線壓條配線', ['網路線'], ['米']),
    ('網路孔新增（明架天花板／管路可及）', ['網路孔'], ['處', '只', '組']),
    ('RJ45 接頭壓接', ['接頭'], ['點', '只']),
    ('網路線路測試（導通測試）', ['測試'], ['點']),
    ('電纜線 3.5mm² 3C 明管／壓條配線', ['電纜線', '3.5'], ['米']),
    ('電纜線天花板內／線槽架配線', ['電纜線', '2.0'], ['米']),
    ('PVC壓條（1號／2號）明線裝設', ['壓條'], ['米', '支']),
    ('電源插座出口新增（單點零星作業、明線）', ['插座'], ['只', '個', '組', '處']),
    ('專用迴路新增（盤側接線＋NFB＋標示＋送電測試）', ['迴路'], ['迴路', '處', '組']),
    ('無熔絲開關（NFB）盤內裝設', ['無熔絲'], ['只', 'PC', '個']),
    ('明盒／接線盒裝設', ['明盒'], ['個', '只']),
    ('圓形鍍鋅風管安裝（管徑≦12英吋，含吊架）', ['鍍鋅'], ['米', '支']),
    ('冰水／冷媒管路橡塑保溫新作（管徑≦2英吋，含外覆）', ['保溫'], ['米']),
    ('舊管路保溫拆除', ['保溫', '拆除'], ['米']),
    ('分離式冷氣室內機吊掛定位', ['室內機'], ['台']),
    ('箱型風機吊掛安裝（≦1HP）', ['箱型風機'], ['台']),
    ('小型送風機（800CFM級）汰換', ['送風機'], ['台']),
    ('PVC地磚鋪設（面積≧20m²，不含舊地板拆除）', ['地磚', '鋪設'], ['m²']),
    ('內牆批土刷水泥漆（新牆、面積≧50m²、一底二度）', ['水泥漆'], ['m²']),
    ('舊牆整平粉刷含水泥漆（小面積、含補土修補）', ['粉刷'], ['m²']),
    ('輕鋼架明架天花板（礦纖／PVC／矽酸鈣板）', ['天花板'], ['m²']),
    ('輕隔間（輕鋼架矽酸鈣板乾式雙面封板）', ['隔間'], ['m²']),
    ('輕隔間／天花板人工拆除（含裝袋）', ['拆除'], ['m²']),
    ('事業廢棄物人工裝車（3.5噸車）', ['清運'], ['車', '趟']),
]
by_item = {p['work_item']: p for p in prods}
links, used = [], set()

for wi, kws, units in RULES:
    p = by_item.get(wi)
    if not p:
        continue
    for it in items:
        if it['id'] in used:
            continue
        hay = it['name'] + ' ' + (it['spec'] or '')
        if all(k in hay for k in kws) and it['unit'] in units:
            links.append((it['id'], p['id'], it['name'], p['work_item']))
            used.add(it['id'])

w = io.open(OUT, 'w', encoding='utf-8')
w.write('-- 由 scripts/link_productivity.py 產生：品項 ↔ 工率基準 對接\n')
w.write('-- 對接後報價單會自動附上「工率分析」頁\n\n')
for iid, pid, iname, pname in links:
    w.write('update price_items set productivity_id = %s where id = %s;  -- %s ← %s\n'
            % (q(pid), q(iid), iname[:20], pname[:24]))
w.write('\nselect count(*) as 已對接 from price_items where productivity_id is not null and active;\n')
w.close()

unmatched = [p for p in prods if p['id'] not in {l[1] for l in links}]
print('OK ->', os.path.abspath(OUT))
print('  對接 %d 個品項' % len(links))
print('  未被用到的工率基準 %d 筆（主管可在單價維護手動指定）：' % len(unmatched))
for p in unmatched[:12]:
    print('    -', p['work_item'][:40])
assert len({l[0] for l in links}) == len(links), '同一品項被對接兩次'
print('  自我檢查：無重複對接 PASS')
