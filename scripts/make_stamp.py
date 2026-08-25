# -*- coding: utf-8 -*-
"""把報價專用章的掃描圖處理成可疊印的透明 PNG，並產生寫入 Supabase 的 SQL。

為什麼存進資料庫而不是放 repo：這個 repo 是 public 的，
公司的報價專用章（含統一編號）放進去等於公開讓人下載盜用。
存進 settings 表則受 RLS 保護，只有登入且啟用的使用者讀得到。

處理內容：
  1. 去背——掃描件的白底要變透明，否則蓋在簽核欄上會是一塊白方塊，不像蓋章。
  2. 只留藍色印泥的部分，順便把掃描的灰階雜訊濾掉。
  3. 裁掉四周空白、等比縮到合理寬度，控制 base64 體積。
"""
import base64, io, os, sys

from PIL import Image

sys.stdout.reconfigure(encoding='utf-8')

SRC = r'D:/醫院/醫院/立得新報價章.jpg'
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_SQL = os.path.join(HERE, '..', 'db', '14_quote_stamp.sql')
PREVIEW = os.path.join(HERE, '..', 'stamp-preview.png')  # 給人眼看的，不進版控
TARGET_W = 360

img = Image.open(SRC).convert('RGBA')
px = img.load()
w, h = img.size
print('原圖 %dx%d' % (w, h))

# ── 去背：印章是藍色，底是白紙。以「亮度高且不夠藍」為背景判準 ──
# 純粹用亮度門檻會把淡藍的筆畫一起吃掉，所以同時看藍色相對優勢。
kept = 0
for y in range(h):
    for x in range(w):
        r, g, b, _ = px[x, y]
        lum = (r * 299 + g * 587 + b * 114) // 1000
        blueness = b - (r + g) // 2          # 藍色印泥會明顯為正
        if lum > 205 and blueness < 25:
            px[x, y] = (0, 0, 0, 0)          # 背景 → 全透明
        else:
            # 保留筆畫，但把顏色統一成印泥藍，去掉掃描造成的灰濁
            a = 255 if lum < 170 else int(255 * (215 - lum) / 45)
            px[x, y] = (21, 71, 158, max(0, min(255, a)))
            kept += 1
print('保留筆畫像素 %d（%.1f%%）' % (kept, 100 * kept / (w * h)))

bbox = img.getbbox()
if bbox:
    img = img.crop(bbox)
    print('裁切後 %dx%d' % img.size)

ratio = TARGET_W / img.width
img = img.resize((TARGET_W, max(1, round(img.height * ratio))), Image.LANCZOS)

# 筆畫顏色單一、差別只在 alpha 深淺；把 alpha 量化成 16 階可大幅縮小 PNG
#（肉眼看不出差別，但熵降低很多）
qa = img.split()[3].point(lambda a: (a // 16) * 17)
img.putalpha(qa)

buf = io.BytesIO()
img.save(buf, 'PNG', optimize=True)
data = buf.getvalue()
img.save(PREVIEW)

b64 = base64.b64encode(data).decode('ascii')
uri = 'data:image/png;base64,' + b64
print('輸出 %dx%d，PNG %.1f KB，base64 %.1f KB' % (img.width, img.height, len(data) / 1024, len(b64) / 1024))

assert len(b64) < 900_000, 'base64 太大，settings 欄位塞不下也會拖慢載入'
assert img.mode == 'RGBA', '必須是有 alpha 的 RGBA'

with io.open(OUT_SQL, 'w', encoding='utf-8') as f:
    f.write('-- 報價專用章（由 scripts/make_stamp.py 產生，請勿手改）\n')
    f.write('-- 存在資料庫而非 repo：repo 是 public 的，印章圖放進去等於公開讓人下載盜用。\n')
    f.write('-- settings 受 RLS 保護，只有登入且啟用的使用者讀得到。\n')
    f.write('-- 蓋章時機：報價單經主管核可（approved）之後才會出現在列印版面上。\n\n')
    f.write("insert into settings (key, value) values ('quote_stamp', to_jsonb('%s'::text))\n" % uri)
    f.write('on conflict (key) do update set value = excluded.value;\n\n')
    f.write("select key, length(value #>> '{}') as base64_長度 from settings where key = 'quote_stamp';\n")

print('OK ->', os.path.abspath(OUT_SQL))
print('預覽圖 ->', os.path.abspath(PREVIEW))
