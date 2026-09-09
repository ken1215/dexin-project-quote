"""端到端驗證：工號登入 + 兩階段簽核 + 越級留痕 + 處長／部長權限邊界 + P0 權限回歸矩陣。

為什麼是打 API 不是點畫面：畫面藏按鈕不算權限，RLS 擋下時 Supabase
不報錯只回 0 筆，只有實際看回傳筆數才知道有沒有被擋住。

跑法（需 supabase CLI 已 login 且 linked，金鑰由 CLI 現取不落地）：
    python scripts/verify_approval_flow.py
可選：--keep-negotiating 會留下一張 negotiating 狀態的測試單並印出 id，
供手動檢視議價頁版面，用完自己刪。

測試帳號 990001~990007 與測試單跑完即刪（990007 是停用帳號測試用，一律刪）。
"""
import json, subprocess, sys, urllib.request, urllib.error

REF = "xjylpaqvdxmxzehvwreg"
URL = f"https://{REF}.supabase.co"
MGR_NO = "016123"          # 行政管理部副部長
DOMAIN = "dexin.local"
KEEP = "--keep-negotiating" in sys.argv

keys = json.loads(subprocess.run(
    ["npx", "supabase", "projects", "api-keys", "--project-ref", REF, "-o", "json"],
    capture_output=True, text=True, shell=True).stdout)
ANON = next(k["api_key"] for k in keys if k["name"] == "anon")
SVC = next(k["api_key"] for k in keys if k["name"] == "service_role")

PASS, FAIL = [], []


def req(path, payload=None, method=None, key=ANON, bearer=None, prefer=None):
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(URL + path, data=data,
                               method=method or ("POST" if data else "GET"))
    r.add_header("apikey", key)
    r.add_header("Authorization", "Bearer " + (bearer or key))
    r.add_header("Content-Type", "application/json")
    if prefer:
        r.add_header("Prefer", prefer)
    try:
        with urllib.request.urlopen(r) as resp:
            body = resp.read().decode()
            return resp.status, (json.loads(body) if body.strip() else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"{'  OK ' if cond else 'FAIL'} | {name} {detail if not cond else ''}")


def login(no, pw):
    st, b = req("/auth/v1/token?grant_type=password",
                {"email": f"{no}@{DOMAIN}", "password": pw})
    return (b or {}).get("access_token") if st == 200 else None


admin_tok = login(MGR_NO, MGR_NO)
check(f"以工號 {MGR_NO} 登入", bool(admin_tok))
if not admin_tok:
    raise SystemExit("主管登入失敗（密碼可能已被更改），後續不跑")

st, users = req("/auth/v1/admin/users?page=1&per_page=200", key=SVC)
existing = {u["email"]: u["id"] for u in users["users"]}

# ── 建四個測試帳號（處長／同仁／醫院採購／部長）────────────────
created = {}
for no, name, role in (("990001", "測試處長", "dept_head"),
                       ("990002", "測試同仁", "staff"),
                       ("990003", "測試採購", "procurement"),
                       ("990006", "測試部長", "admin_head")):
    if f"{no}@{DOMAIN}" in existing:
        req(f"/auth/v1/admin/users/{existing[f'{no}@{DOMAIN}']}", method="DELETE", key=SVC)
    st, b = req("/functions/v1/admin-users",
                {"action": "create", "email": no, "full_name": name, "role": role},
                key=ANON, bearer=admin_tok)
    check(f"建 {role} 帳號 {no}（密碼留空應帶工號）", st == 200, str(b)[:200])
    tok = login(no, no)
    check(f"{no} 用工號當密碼登入", bool(tok))
    created[role] = {"no": no, "token": tok, "id": (b or {}).get("id")}

head_tok, staff_tok = created["dept_head"]["token"], created["staff"]["token"]
boss_tok = created["admin_head"]["token"]   # 行政管理部長
# Edge Function 若還沒重新部署，admin_head 不在建帳號的白名單內會被**悄悄降成 staff**，
# 建帳號一樣回 200，後面每一項部長檢查都會以看不懂的理由失敗。先直接查一次角色。
st, _b = req(f"/rest/v1/profiles?id=eq.{created['admin_head']['id']}&select=role", key=SVC)
check("990006 角色確為 admin_head（否則請先重新部署 admin-users）",
      st == 200 and _b and _b[0].get("role") == "admin_head", str(_b)[:120])


def new_quote(suffix, owner=None):
    # owner 預設是測試同仁；停用帳號那段要建「別人名下」的單，才傳別的 id
    st, b = req("/rest/v1/rpc/next_quote_no", {}, key=SVC)
    no = (b if isinstance(b, str) else "DX-TEST") + suffix
    st, b = req("/rest/v1/quotes", {
        "quote_no": no, "project": f"【驗證用·可刪】{suffix}",
        "created_by": owner or created["staff"]["id"], "status": "draft",
    }, key=SVC, prefer="return=representation")
    return b[0]["id"]


def set_status(qid, tok, status):
    return req(f"/rest/v1/quotes?id=eq.{qid}", {"status": status}, method="PATCH",
               key=ANON, bearer=tok, prefer="return=representation")


# ── 正常兩關 ──────────────────────────────────────────────────
q1 = new_quote("-A")
st, b = set_status(q1, staff_tok, "submitted")
check("同仁送審 draft→submitted", st == 200 and b, str(b)[:160])
st, b = set_status(q1, staff_tok, "approved_l1")
check("【擋】同仁不能自己核可", st != 200 or not b, f"HTTP {st}")
st, b = set_status(q1, head_tok, "approved_l1")
check("處長核可 submitted→approved_l1", st == 200 and b, str(b)[:160])
if st == 200 and b:
    check("  trigger 蓋了第一關戳記", bool(b[0].get("approved_l1_at")))
st, b = set_status(q1, head_tok, "approved")
check("【擋】處長不能自己完成第二關", st != 200 or not b, f"HTTP {st}")
st, b = set_status(q1, admin_tok, "approved")
check("副部長核定 approved_l1→approved", st == 200 and b, str(b)[:160])
if st == 200 and b:
    check("  trigger 蓋了第二關戳記", bool(b[0].get("approved_at")))
    check("  未越級時 l1_skipped=false", b[0].get("l1_skipped") is False)

# ── 越級核定（處長請假時不卡單）────────────────────────────────
q2 = new_quote("-B")
set_status(q2, staff_tok, "submitted")
st, b = set_status(q2, admin_tok, "approved")
check("副部長越級 submitted→approved", st == 200 and b, str(b)[:160])
if st == 200 and b:
    check("  越級有留痕 l1_skipped=true", b[0].get("l1_skipped") is True)

# ── 權限邊界 ──────────────────────────────────────────────────
# 2026-08-27 起處長也能管帳號（範圍限 staff，細節見下方專段），所以 list 應該通
st, b = req("/functions/v1/admin-users", {"action": "list"}, key=ANON, bearer=head_tok)
check("處長可列出帳號清單", st == 200, f"HTTP {st}")
st, b = req("/rest/v1/price_items?select=id&limit=1", key=ANON, bearer=head_tok)
check("處長讀得到單價庫", st == 200 and isinstance(b, list) and len(b) == 1)
st, b = req(f"/rest/v1/quotes?id=eq.{q1}", method="DELETE",
            key=ANON, bearer=head_tok, prefer="return=representation")
check("【擋】處長不能刪報價單", st != 200 or not b, f"HTTP {st}")
# 醫院採購看不到還沒核定的單
q3 = new_quote("-C")
st, b = req(f"/rest/v1/quotes?id=eq.{q3}", key=ANON, bearer=created["procurement"]["token"])
check("【擋】醫院採購看不到未核定的單", st == 200 and b == [], str(b)[:160])

# ── 處長的帳號管理權限（2026-08-27 追加，範圍限 staff）─────────
def admin_fn(payload, tok):
    return req("/functions/v1/admin-users", payload, key=ANON, bearer=tok)


# 建同仁：可以
st, b = admin_fn({"action": "create", "email": "990004",
                  "full_name": "測試同仁B", "role": "staff"}, head_tok)
check("處長可建立「同仁」帳號", st == 200, f"HTTP {st} {str(b)[:160]}")
staff_b_id = (b or {}).get("id") if st == 200 else None
check("  該帳號可用工號當密碼登入", bool(login("990004", "990004")))

# 建其他角色：一律擋
for role, label in (("manager", "副部長"), ("dept_head", "處長"), ("procurement", "醫院採購")):
    st, b = admin_fn({"action": "create", "email": "990005",
                      "full_name": "不該被建出來", "role": role}, head_tok)
    check(f"【擋】處長不能建立「{label}」帳號（提權）", st == 403, f"HTTP {st} {str(b)[:120]}")

# 停用同仁：可以
if staff_b_id:
    st, b = req(f"/rest/v1/profiles?id=eq.{staff_b_id}", {"active": False}, method="PATCH",
                key=ANON, bearer=head_tok, prefer="return=representation")
    check("處長可停用同仁", st == 200 and b, f"HTTP {st} {str(b)[:160]}")
    # 把同仁升成副部長：with check 要擋
    st, b = req(f"/rest/v1/profiles?id=eq.{staff_b_id}", {"role": "manager"}, method="PATCH",
                key=ANON, bearer=head_tok, prefer="return=representation")
    check("【擋】處長不能把同仁升成副部長（提權）", st != 200 or not b, f"HTTP {st} {str(b)[:120]}")

# 動副部長那一列：using 要擋
st, us2 = req("/auth/v1/admin/users?page=1&per_page=200", key=SVC)
mgr_id = next(u["id"] for u in us2["users"] if u["email"] == f"{MGR_NO}@{DOMAIN}")
st, b = req(f"/rest/v1/profiles?id=eq.{mgr_id}", {"active": False}, method="PATCH",
            key=ANON, bearer=head_tok, prefer="return=representation")
check("【擋】處長不能停用副部長", st != 200 or not b, f"HTTP {st} {str(b)[:120]}")

# 自己升自己：using 也要擋（處長那一列 role 不是 staff）
st, b = req(f"/rest/v1/profiles?id=eq.{created['dept_head']['id']}", {"role": "manager"},
            method="PATCH", key=ANON, bearer=head_tok, prefer="return=representation")
check("【擋】處長不能把自己升成副部長", st != 200 or not b, f"HTTP {st} {str(b)[:120]}")

# 重設密碼：同仁可以、副部長不行
if staff_b_id:
    st, b = admin_fn({"action": "reset_password", "id": staff_b_id, "password": "990004"}, head_tok)
    check("處長可重設同仁密碼", st == 200, f"HTTP {st} {str(b)[:120]}")
st, b = admin_fn({"action": "reset_password", "id": mgr_id, "password": "zzzzzz"}, head_tok)
check("【擋】處長不能重設副部長密碼", st == 403, f"HTTP {st} {str(b)[:120]}")

# 刪帳號：一律擋（不可逆，留給副部長；處長請改用停用）
if staff_b_id:
    st, b = admin_fn({"action": "delete", "id": staff_b_id}, head_tok)
    check("【擋】處長不能刪除帳號（改用停用）", st == 403, f"HTTP {st} {str(b)[:120]}")

# 管理單價：處長本來就有（db/19 的 is_manager() 語意擴大），這裡實證而非假設
st, items = req("/rest/v1/price_items?select=id,sort&limit=1", key=ANON, bearer=head_tok)
if st == 200 and items:
    it = items[0]
    st, b = req(f"/rest/v1/price_items?id=eq.{it['id']}", {"sort": it["sort"]},
                method="PATCH", key=ANON, bearer=head_tok, prefer="return=representation")
    check("處長可寫入單價庫 price_items", st == 200 and b, f"HTTP {st} {str(b)[:120]}")
st, floors = req("/rest/v1/price_floors?select=item_id,floor_price&limit=1", key=ANON, bearer=head_tok)
check("處長讀得到底價 price_floors", st == 200 and isinstance(floors, list), f"HTTP {st}")

# ── 行政管理部長（admin_head）：等同副部長，但單價唯讀（db/21）──
# 1) 核決權：走完整第二關，證明他確實等同副部長
q4 = new_quote("-D")
set_status(q4, staff_tok, "submitted")
st, b = set_status(q4, head_tok, "approved_l1")
check("（前置）處長核可 -D 單", st == 200 and b, f"HTTP {st}")
st, b = set_status(q4, boss_tok, "approved")
check("部長核定 approved_l1→approved", st == 200 and b, f"HTTP {st} {str(b)[:160]}")
# 2) 帳號管理：與副部長同級
st, b = admin_fn({"action": "list"}, boss_tok)
check("部長可列出帳號清單", st == 200, f"HTTP {st}")
# 3) 單價：讀得到、寫不進去（這是這個角色唯一的差別）
st, items = req("/rest/v1/price_items?select=id,sort&limit=1", key=ANON, bearer=boss_tok)
check("部長讀得到單價庫 price_items",
      st == 200 and isinstance(items, list) and len(items) == 1, f"HTTP {st}")
if st == 200 and items:
    it = items[0]
    st, b = req(f"/rest/v1/price_items?id=eq.{it['id']}", {"sort": it["sort"]},
                method="PATCH", key=ANON, bearer=boss_tok, prefer="return=representation")
    # RLS 擋下不報錯，只回 0 筆——所以看的是筆數不是狀態碼
    check("【擋】部長不能寫入單價庫 price_items", st != 200 or not b, f"HTTP {st} {str(b)[:120]}")
st, floors = req("/rest/v1/price_floors?select=item_id,floor_price&limit=1",
                 key=ANON, bearer=boss_tok)
check("部長讀得到底價 price_floors", st == 200 and isinstance(floors, list), f"HTTP {st}")
st, idxs = req("/rest/v1/material_indices?select=id,value&limit=1", key=ANON, bearer=boss_tok)
if st == 200 and idxs:
    st, b = req(f"/rest/v1/material_indices?id=eq.{idxs[0]['id']}", {"value": idxs[0]["value"]},
                method="PATCH", key=ANON, bearer=boss_tok, prefer="return=representation")
    check("【擋】部長不能寫入物價指數 material_indices", st != 200 or not b, f"HTTP {st}")

# 收掉本段建出來的帳號（990005 理論上都被擋下沒建成，保險起見一併清）
st, us3 = req("/auth/v1/admin/users?page=1&per_page=200", key=SVC)
for u in us3["users"]:
    if u["email"].startswith(("990004@", "990005@")):
        req(f"/auth/v1/admin/users/{u['id']}", method="DELETE", key=SVC)

# ══════════════════════════════════════════════════════════════
# P0 權限回歸矩陣（對應 db/22_harden_permissions.sql）
#
# 這一段測的是「資料庫擋不擋得住」，不是畫面藏不藏得住按鈕，所以一律打 REST。
# 三個容易做出假通過的地方，先講清楚：
#   1) new_quote() 產出的是**零明細**的單。要測明細、零元送審、定案寫回，
#      得先用 SVC 金鑰把 quote_sections ＋ quote_lines 補進去，
#      否則零元檢查掃到空單一定過、定案也沒東西可寫回。
#   2) 停用帳號要**先登入拿 token 再停用**。先停用再登入只測到「登不進去」，
#      測不到「舊 session 還能不能操作」——後者才是 P0-3 真正要防的。
#   3) INSERT 成功回的是 201 不是 200，「被擋」的斷言不能只寫 st != 200，
#      否則新建成功會被誤判成被擋——INSERT 一律用 st not in (200, 201)。
#      PATCH 帶 return=representation 則不管成功或被 RLS 擋下都回 200（只差回不回空陣列），
#      201 永遠不會出現，所以 PATCH 沿用既有斷言風格 st != 200 or not b，別跟 INSERT 混用。
# ══════════════════════════════════════════════════════════════
p0_quotes = []          # 本段建出來的測試單，收尾一併刪


def raw_insert_quote(tok, uid, status, suffix):
    """以「使用者本人」的 token 直接 INSERT 母單。
    刻意不走 new_quote()——那支用 SVC 金鑰會繞過 RLS，測不到 quotes_insert 的把關。"""
    st, no = req("/rest/v1/rpc/next_quote_no", {}, key=SVC)
    return req("/rest/v1/quotes", {
        "quote_no": (no if isinstance(no, str) else "DX-TEST") + suffix,
        "project": f"【驗證用·可刪】{suffix}", "created_by": uid, "status": status,
    }, key=ANON, bearer=tok, prefer="return=representation")


def add_lines(qid, lines):
    """替測試單補一個大項與若干明細（SVC 金鑰，繞過 RLS），回傳明細 id 清單。
    逐筆寫入而非整批，是為了讓回傳順序等同傳入順序，後面才敢用索引取用。"""
    st, sec = req("/rest/v1/quote_sections",
                  {"quote_id": qid, "title": "測試大項", "sort": 0},
                  key=SVC, prefer="return=representation")
    if st not in (200, 201) or not sec:
        return []
    ids = []
    for i, ln in enumerate(lines):
        st, b = req("/rest/v1/quote_lines",
                    {"quote_id": qid, "section_id": sec[0]["id"], "unit": "式",
                     "sort": i, **ln}, key=SVC, prefer="return=representation")
        if st in (200, 201) and b:
            ids.append(b[0]["id"])
    return ids


# ── 停用帳號 990007：務必先建、先登入，停用留到用得到 token 之後 ──
if f"990007@{DOMAIN}" in existing:
    req(f"/auth/v1/admin/users/{existing[f'990007@{DOMAIN}']}", method="DELETE", key=SVC)
st, b = admin_fn({"action": "create", "email": "990007",
                  "full_name": "測試停用帳號", "role": "staff"}, admin_tok)
check("建停用測試帳號 990007", st == 200, f"HTTP {st} {str(b)[:160]}")
dead_id = (b or {}).get("id") if st == 200 else None
dead_tok = login("990007", "990007")
check("990007 停用前可正常登入（之後才停用）", bool(dead_tok))

# ── P0-1：新建只能是草稿 ──────────────────────────────────────
for i, (label, tok, uid) in enumerate((
        ("同仁", staff_tok, created["staff"]["id"]),
        ("處長", head_tok, created["dept_head"]["id"]),
        ("副部長", admin_tok, mgr_id),
        ("部長", boss_tok, created["admin_head"]["id"]),
        ("醫院採購", created["procurement"]["token"], created["procurement"]["id"]))):
    st, b = raw_insert_quote(tok, uid, "approved", f"-P0I{i}")
    blocked = st not in (200, 201) or not b
    check(f"【擋】{label} 不能直接建立 approved 母單", blocked, f"HTTP {st} {str(b)[:120]}")
    if not blocked:
        p0_quotes.append(b[0]["id"])   # 擋不住的話至少別把髒單留在資料庫

st, b = raw_insert_quote(created["procurement"]["token"],
                         created["procurement"]["id"], "draft", "-P0IP")
blocked = st not in (200, 201) or not b
check("【擋】醫院採購連 draft 母單都不能建", blocked, f"HTTP {st} {str(b)[:120]}")
if not blocked:
    p0_quotes.append(b[0]["id"])

# ── P0-3：停用帳號立即失權（拿的是停用前發出的舊 token）────────
if dead_id and dead_tok:
    q5 = new_quote("-E", owner=dead_id)
    p0_quotes.append(q5)
    st, b = req(f"/rest/v1/profiles?id=eq.{dead_id}", {"active": False}, method="PATCH",
                key=SVC, prefer="return=representation")
    check("（前置）990007 已被停用", st == 200 and b, f"HTTP {st} {str(b)[:120]}")
    # RLS 擋下不報錯只回 0 筆，所以讀取這項看的是「空陣列」不是狀態碼
    st, b = req(f"/rest/v1/quotes?id=eq.{q5}", key=ANON, bearer=dead_tok)
    check("【擋】停用帳號讀不到自己建立的單", st == 200 and b == [], f"HTTP {st} {str(b)[:120]}")
    st, b = req(f"/rest/v1/quotes?id=eq.{q5}", {"project": "停用後不該改得動"},
                method="PATCH", key=ANON, bearer=dead_tok, prefer="return=representation")
    check("【擋】停用帳號改不動自己建立的單", st != 200 or not b,
          f"HTTP {st} {str(b)[:120]}")
    st, b = set_status(q5, dead_tok, "submitted")
    check("【擋】停用帳號不能送審自己建立的單", st != 200 or not b, f"HTTP {st} {str(b)[:120]}")

# ── P0-2：核定後鎖死金額（q6 是唯一帶明細走完兩關的單）──────────
q6 = new_quote("-F")
p0_quotes.append(q6)
line_ids = add_lines(q6, [{"name": "測試品項A", "unit_price": 1000, "qty": 2},
                          {"name": "測試品項B", "unit_price": 500, "qty": 1}])
check("（前置）測試單補上兩筆明細", len(line_ids) == 2, str(line_ids)[:160])
set_status(q6, staff_tok, "submitted")
set_status(q6, head_tok, "approved_l1")
st, b = set_status(q6, admin_tok, "approved")
check("（前置）帶明細的單走到 approved", st == 200 and b, f"HTTP {st} {str(b)[:160]}")

if line_ids:
    for label, tok in (("處長", head_tok), ("副部長", admin_tok), ("部長", boss_tok)):
        st, b = req(f"/rest/v1/quote_lines?id=eq.{line_ids[0]}", {"unit_price": 1},
                    method="PATCH", key=ANON, bearer=tok, prefer="return=representation")
        check(f"【擋】approved 之後 {label} 不能改明細單價",
              st != 200 or not b, f"HTTP {st} {str(b)[:120]}")

st, b = req(f"/rest/v1/quotes?id=eq.{q6}", {"mgmt_fee_rate": 0.12}, method="PATCH",
            key=ANON, bearer=admin_tok, prefer="return=representation")
check("【擋】approved 之後不能改管理費率", st != 200 or not b,
      f"HTTP {st} {str(b)[:120]}")
st, b = req(f"/rest/v1/quotes?id=eq.{q6}", {"project": "【驗證用·可刪】-F 核定後改名"},
            method="PATCH", key=ANON, bearer=admin_tok, prefer="return=representation")
check("approved 之後仍可修正非金額欄位（專案名）", st == 200 and b, f"HTTP {st} {str(b)[:160]}")
st, b = req(f"/rest/v1/quotes?id=eq.{q6}", {"approved_by": created["staff"]["id"]},
            method="PATCH", key=ANON, bearer=admin_tok, prefer="return=representation")
check("【擋】客戶端自帶 approved_by 的 PATCH 被擋下", st != 200 or not b,
      f"HTTP {st} {str(b)[:120]}")

# ── A5：零元品項擋送審（明細必須先寫進資料庫才測得到）──────────
q7 = new_quote("-G")
p0_quotes.append(q7)
zero_ids = add_lines(q7, [{"name": "零元測試品項", "unit_price": 0, "qty": 1}])
check("（前置）建立零元且理由留白的明細", len(zero_ids) == 1, str(zero_ids)[:160])
st, b = set_status(q7, staff_tok, "submitted")
check("【擋】零元且無理由的明細不得送審", st != 200 or not b, f"HTTP {st} {str(b)[:160]}")
if zero_ids:
    req(f"/rest/v1/quote_lines?id=eq.{zero_ids[0]}", {"reason": "業主自購"},
        method="PATCH", key=SVC)
    st, b = set_status(q7, staff_tok, "submitted")
    check("補上理由後零元明細可送審", st == 200 and b, f"HTTP {st} {str(b)[:160]}")

# ── 同仁在自己「已送審」的單上動明細：db/22 把 owner 分支收到只剩 draft ──
# （舊政策開到 submitted，是舊版前端「先改狀態再重寫明細」逼出來的；
#   B1 改成「寫完明細才推狀態」之後那條路沒人走，留著等於能繞過畫面改已送審單的金額）
if zero_ids:
    st, b = req(f"/rest/v1/quote_lines?id=eq.{zero_ids[0]}", {"unit_price": 999},
                method="PATCH", key=ANON, bearer=staff_tok, prefer="return=representation")
    check("【擋】同仁不能改自己已送審單的明細單價", st != 200 or not b, f"HTTP {st} {str(b)[:120]}")
    st, b = req(f"/rest/v1/quote_lines?id=eq.{zero_ids[0]}", method="DELETE",
                key=ANON, bearer=staff_tok, prefer="return=representation")
    check("【擋】同仁不能刪掉自己已送審單的明細", st != 200 or not b, f"HTTP {st} {str(b)[:120]}")

# ── A4：議價資料約束（line_id 必須屬於同一張單，FK 管不到）──────
if line_ids and zero_ids:
    st, b = req("/rest/v1/negotiations",
                {"quote_id": q6, "line_id": zero_ids[0], "round": 1, "client_offer": 100},
                key=ANON, bearer=admin_tok, prefer="return=representation")
    check("【擋】議價 line_id 不屬於該報價單時寫入失敗",
          st not in (200, 201) or not b, f"HTTP {st} {str(b)[:120]}")

# ── 採購寫入路徑：可還價，但我方欄位一律被 trigger 清掉 ─────────
if line_ids:
    proc = created["procurement"]
    st, b = req("/rest/v1/negotiations",
                {"quote_id": q6, "line_id": line_ids[0], "round": 1, "client_offer": 900,
                 # response／final_price／responded_by 故意亂填，看 trigger 有沒有蓋掉
                 "response": "accept", "final_price": 800, "rationale": "採購還價測試",
                 "responded_by": created["staff"]["id"]},
                key=ANON, bearer=proc["token"], prefer="return=representation")
    ok = st in (200, 201) and bool(b)
    check("採購可對 approved 單登錄還價", ok, f"HTTP {st} {str(b)[:160]}")
    if ok:
        row = b[0]
        check("  trigger 清掉採購送來的 response／final_price",
              row.get("response") is None and row.get("final_price") is None, str(row)[:160])
        check("  responded_by 被蓋成採購本人", row.get("responded_by") == proc["id"],
              str(row)[:160])

# ── A6：close_quote_case 定案（只有核決層能按）──────────────────
if len(line_ids) == 2:
    rows = [{"line_id": line_ids[0], "client_offer": 900, "response": "partial",
             "final_price": 880, "rationale": "定案測試A"},
            {"line_id": line_ids[1], "client_offer": 450, "response": "accept",
             "final_price": 450, "rationale": "定案測試B"}]
    st, b = req("/rest/v1/rpc/close_quote_case", {"p_quote_id": q6, "p_rows": rows},
                key=ANON, bearer=staff_tok)
    # 認 400／403 而不是「非 200」：RPC 還沒部署時會回 404，
    # 寫成非 200 的話「函式根本不存在」也會被當成擋得住
    check("【擋】同仁不能呼叫 close_quote_case 定案", st in (400, 403),
          f"HTTP {st} {str(b)[:160]}")
    st, b = req("/rest/v1/rpc/close_quote_case", {"p_quote_id": q6, "p_rows": rows},
                key=ANON, bearer=admin_tok)
    ok = st == 200 and isinstance(b, dict)
    check("副部長可用 close_quote_case 定案", ok, f"HTTP {st} {str(b)[:200]}")
    if ok:
        check("  RPC 回報有寫入議價紀錄", (b.get("rows_logged") or 0) >= 1, str(b)[:160])
        check("  RPC 回報有把定案價寫回明細", (b.get("lines_updated") or 0) >= 1, str(b)[:160])
    # RPC 說什麼不算數，用 SVC 金鑰回頭看資料真的落地沒
    st, b = req(f"/rest/v1/quotes?id=eq.{q6}&select=status", key=SVC)
    check("  定案後母單狀態為 closed",
          st == 200 and bool(b) and b[0].get("status") == "closed", f"HTTP {st} {str(b)[:160]}")
    st, b = req(f"/rest/v1/quote_lines?id=eq.{line_ids[0]}&select=unit_price", key=SVC)
    got = b[0].get("unit_price") if st == 200 and b else None
    check("  明細單價被寫回定案價 880",
          got is not None and abs(float(got) - 880) < 0.01, f"HTTP {st} {str(b)[:160]}")
    # 只認 round > 1 的列：round 1 是上面採購自己寫的，算進來的話
    # 就算 RPC 一筆都沒寫也會通過，等於白測
    st, b = req(f"/rest/v1/negotiations?quote_id=eq.{q6}&round=gt.1&select=id", key=SVC)
    check("  議價歷程留下本輪（round>1）紀錄",
          st == 200 and isinstance(b, list) and len(b) >= 1, f"HTTP {st} {str(b)[:160]}")

# ── 收尾 ──────────────────────────────────────────────────────
keep_id = None
if KEEP:
    set_status(q1, admin_tok, "negotiating")
    keep_id = q1
for q in (q1, q2, q3, q4, *p0_quotes):
    if q != keep_id:
        req(f"/rest/v1/quotes?id=eq.{q}", method="DELETE", key=SVC)
# 990007 已被停用，留著也登不進去用不到，KEEP 與否一律刪。
# 必須排在測試單刪除**之後**：quotes.created_by 參照 profiles，
# 先刪帳號會因為 FK 還被那張單綁著而默默失敗。
if dead_id:
    req(f"/auth/v1/admin/users/{dead_id}", method="DELETE", key=SVC)
if not KEEP:
    for r in created.values():
        if r["id"]:
            req(f"/auth/v1/admin/users/{r['id']}", method="DELETE", key=SVC)
    print("\n測試帳號與測試單已刪除")
else:
    print(f"\n保留議價中測試單 id={keep_id}，測試帳號 990001-990003、990006 亦保留（記得刪）")

print(f"\n通過 {len(PASS)} 項，失敗 {len(FAIL)} 項")
if FAIL:
    print("失敗項目：" + "、".join(FAIL))
    sys.exit(1)
