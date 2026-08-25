# -*- coding: utf-8 -*-
"""把 workflow 產出的「複合品項拆解」與「工率基準」灌進資料庫。

產出 db/06_unitize_and_productivity.sql，再用
  npx supabase db query --linked -f db/06_unitize_and_productivity.sql
執行。

入庫規則（不是我自己發明的，是交叉審查與使用者定案的結果）：
  1. 交叉審查抓到 2 筆 critical 面積誤讀，在此強制修正（見 CORRECTIONS）。
  2. 單位一律正規化：M2 → m²（使用者要求裝修統一 m²）。
  3. action=remove → 刪除。品項刪除已改為 on delete set null，不影響已開出的報價單。
  4. action=convert/split → 刪掉原本的包價品項，改成拆解後的單項。
  5. **price_confidence=low 的決策，其新品項預設停用**，evidence_note 標明待主管核定。
     理由與空調清潔那批一致：沒把握的單價不要讓同仁直接報出去。
  6. 工資 2,800 是「成本基準」（使用者 2026-08-25 定案），另加 labor_markup 係數才是報價值。
"""
import io, json, os, re, sys

sys.stdout.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
V2 = r'C:/Users/linchy/AppData/Local/Temp/claude/C--Users-linchy/5e4427fc-fe20-4c20-bf99-eb42805f9130/scratchpad/v2'
OUT = os.path.join(HERE, '..', 'db', '06_unitize_and_productivity.sql')

q = lambda s: "'" + str(s).replace("'", "''") + "'"
n = lambda v: 'null' if v is None else str(v)

# ── 交叉審查抓到的 critical 修正 ────────────────────────────────
# 「約2.35坪」「約8.3坪」是施作總面積的註記，不是每箱/每加崙的覆蓋率。
# 用市場行情反推可確認：總面積讀法得到的單價落在行情區間內，每單位讀法遠低於行情。
CORRECTIONS = {
    'fn-pvc-floor-labor-m2': dict(
        std_price=772,
        note='260818 急診更衣室：PVC地磚「約2.35坪」為施作總面積 7.77 m²（非每箱），'
             '6,000 ÷ 7.77 = 772 元/m²。對照市場塑膠地板連工帶料 726~1,089 元/m²（含拆除）合理'),
    'fn-wall-plaster-paint-m2': dict(
        std_price=364,
        note='260818 急診更衣室：水性漆「約8.3坪」為粉刷總面積 27.44 m²（非每加崙），'
             '10,000 ÷ 27.44 = 364 元/m²。對照市場舊牆整平粉刷 303~408 元/m² 合理'),
}

CONF_LABEL = {'high': '高', 'medium': '中', 'low': '低'}


def norm_unit(u):
    u = (u or '').strip()
    return 'm²' if u.upper() in ('M2', 'M²') else u


uni = json.load(io.open(os.path.join(V2, 'unitize.json'), encoding='utf-8'))
prod = json.load(io.open(os.path.join(V2, 'productivity.json'), encoding='utf-8'))

removed_ids, new_rows = [], []
stats = {'keep': 0, 'remove': 0, 'convert': 0, 'split': 0,
         'new_active': 0, 'new_inactive': 0, 'corrected': 0}

for dec in uni['decisions']:
    act = dec['action']
    stats[act] = stats.get(act, 0) + 1
    if act == 'keep':
        continue
    removed_ids.append(dec['id'])
    conf = dec.get('price_confidence', 'medium')
    active = conf != 'low'
    for ni in dec.get('new_items', []):
        price = ni['std_price']
        note_parts = []
        if ni['id'] in CORRECTIONS:
            c = CORRECTIONS[ni['id']]
            price = c['std_price']
            note_parts.append(c['note'])
            stats['corrected'] += 1
        else:
            note_parts.append(ni.get('evidence', '') or dec.get('rationale', ''))
        note_parts.append('由「%s」拆解／換算而來（信心：%s）' % (dec.get('name', dec['id']), CONF_LABEL.get(conf, conf)))
        if not active:
            note_parts.insert(0, '【待主管核定】拆解依據不足，暫予停用')
        new_rows.append(dict(
            id=ni['id'],
            category_id=ni.get('category') or dec.get('category') or 'other',
            name=ni['name'], spec=ni.get('spec', ''), unit=norm_unit(ni['unit']),
            cost_type=ni.get('cost_type', 'material'), std_price=price,
            note='；'.join(p for p in note_parts if p)[:900],
            active=active))
        stats['new_active' if active else 'new_inactive'] += 1

# 新品項的分類若原決策沒帶，用 id 前綴推回去
PREFIX_CAT = {'pw-': 'power', 'nw-': 'network', 'hv-': 'hvac', 'fn-': 'finish',
              'ac-': 'access', 'fr-': 'fire', 'cm-': 'common', 'hc-': 'hvac_clean'}
for r in new_rows:
    if r['category_id'] in (None, '', 'other'):
        for p, c in PREFIX_CAT.items():
            if r['id'].startswith(p):
                r['category_id'] = c
                break

w = io.open(OUT, 'w', encoding='utf-8')
w.write('-- 由 scripts/apply_v2.py 產生：複合品項拆解 + 工率基準\n')
w.write('-- 交叉審查抓到的 2 筆面積誤讀已在此修正；低信心新品項預設停用\n\n')

w.write('-- ══ 1. 工資加成係數（2,800 是成本基準，報價 = 成本 × 係數）══\n')
w.write("insert into settings (key, value) values ('labor_markup', '1.15'::jsonb)\n"
        "on conflict (key) do nothing;\n\n")

w.write('-- ══ 2. 刪除被拆解／換算／判定無法單價化的原包價品項 ══\n')
w.write('delete from price_items where id in (\n  %s\n);\n\n'
        % ',\n  '.join(q(i) for i in sorted(set(removed_ids))))

w.write('-- ══ 3. 拆解後的單項單價 ══\n')
w.write('insert into price_items (id, category_id, name, spec, unit, cost_type,\n'
        '  std_price, evidence_id, evidence_note, samples, active, sort) values\n')
w.write(',\n'.join(
    '  (%s,%s,%s,%s,%s,%s,%s,%s,%s,0,%s,%d)' % (
        q(r['id']), q(r['category_id']), q(r['name']), q(r['spec']), q(r['unit']),
        q(r['cost_type']), n(r['std_price']), q('history'), q(r['note']),
        str(r['active']).lower(), 300 + i)
    for i, r in enumerate(new_rows)))
w.write('\non conflict (id) do update set name=excluded.name, unit=excluded.unit,\n'
        '  std_price=excluded.std_price, evidence_note=excluded.evidence_note,\n'
        '  cost_type=excluded.cost_type, active=excluded.active;\n\n')

w.write('-- ══ 4. 工率基準 ══\n')
w.write('insert into labor_productivity (id, trade, work_item, unit, output_per_manday,\n'
        '  crew, basis, source, confidence, note, sort) values\n')
b = prod['benchmarks']
w.write(',\n'.join(
    '  (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%d)' % (
        q(x.get('id') or ('lp-%03d' % i)), q(x['trade']), q(x['work_item']),
        q(norm_unit(x['unit'])), n(x['output_per_manday']),
        q(x.get('crew', '技術工 1 名')), q(x.get('basis', 'estimate')),
        q((x.get('source', ''))[:900]), q(x.get('confidence', 'medium')),
        q((x.get('note', ''))[:900]), i * 10)
    for i, x in enumerate(b)))
w.write('\non conflict (id) do update set output_per_manday=excluded.output_per_manday,\n'
        '  source=excluded.source, confidence=excluded.confidence, note=excluded.note;\n')
w.close()

print('OK ->', os.path.abspath(OUT))
print('  決策 %d：keep %d / remove %d / convert %d / split %d'
      % (len(uni['decisions']), stats['keep'], stats['remove'], stats['convert'], stats['split']))
print('  刪除原品項 %d 個' % len(set(removed_ids)))
print('  新增單項 %d 個（啟用 %d / 待核定停用 %d）'
      % (len(new_rows), stats['new_active'], stats['new_inactive']))
print('  critical 面積誤讀修正 %d 筆' % stats['corrected'])
print('  工率基準 %d 筆' % len(b))

# ── 自我檢查 ────────────────────────────────────────────────────
ids = [r['id'] for r in new_rows]
assert len(ids) == len(set(ids)), '新品項 id 重複'
assert all(r['std_price'] is not None and r['std_price'] >= 0 for r in new_rows), '有非法單價'
assert all(r['unit'] and r['unit'] != 'M2' for r in new_rows), '仍有未正規化的 M2 單位'
assert not (set(ids) & set(removed_ids)), '新品項 id 與被刪除的 id 相撞'
bad_math = [x for x in b if abs(x['labor_cost_per_unit'] - round(2800 / x['output_per_manday'])) > 1]
assert not bad_math, '工率換算算術不符：%s' % bad_math[:3]
print('  自我檢查：id 唯一 / 單價合法 / 單位已正規化 / 無 id 相撞 / 工率算術相符 全部 PASS')
