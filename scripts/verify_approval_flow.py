"""端到端驗證：工號登入 + 兩階段簽核 + 越級留痕 + 處長權限邊界。

為什麼是打 API 不是點畫面：畫面藏按鈕不算權限，RLS 擋下時 Supabase
不報錯只回 0 筆，只有實際看回傳筆數才知道有沒有被擋住。

跑法（需 supabase CLI 已 login 且 linked，金鑰由 CLI 現取不落地）：
    python scripts/verify_approval_flow.py
可選：--keep-negotiating 會留下一張 negotiating 狀態的測試單並印出 id，
供手動檢視議價頁版面，用完自己刪。

測試帳號 990001/990002/990003 與測試單跑完即刪。
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

# ── 建三個測試帳號（處長／同仁／醫院採購）──────────────────────
created = {}
for no, name, role in (("990001", "測試處長", "dept_head"),
                       ("990002", "測試同仁", "staff"),
                       ("990003", "測試採購", "procurement")):
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


def new_quote(suffix):
    st, b = req("/rest/v1/rpc/next_quote_no", {}, key=SVC)
    no = (b if isinstance(b, str) else "DX-TEST") + suffix
    st, b = req("/rest/v1/quotes", {
        "quote_no": no, "project": f"【驗證用·可刪】{suffix}",
        "created_by": created["staff"]["id"], "status": "draft",
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
st, b = req("/functions/v1/admin-users", {"action": "list"}, key=ANON, bearer=head_tok)
check("【擋】處長呼叫帳號管理", st == 403, f"HTTP {st}")
st, b = req("/rest/v1/price_items?select=id&limit=1", key=ANON, bearer=head_tok)
check("處長讀得到單價庫", st == 200 and isinstance(b, list) and len(b) == 1)
st, b = req(f"/rest/v1/quotes?id=eq.{q1}", method="DELETE",
            key=ANON, bearer=head_tok, prefer="return=representation")
check("【擋】處長不能刪報價單", st != 200 or not b, f"HTTP {st}")
# 醫院採購看不到還沒核定的單
q3 = new_quote("-C")
st, b = req(f"/rest/v1/quotes?id=eq.{q3}", key=ANON, bearer=created["procurement"]["token"])
check("【擋】醫院採購看不到未核定的單", st == 200 and b == [], str(b)[:160])

# ── 收尾 ──────────────────────────────────────────────────────
keep_id = None
if KEEP:
    set_status(q1, admin_tok, "negotiating")
    keep_id = q1
for q in (q1, q2, q3):
    if q != keep_id:
        req(f"/rest/v1/quotes?id=eq.{q}", method="DELETE", key=SVC)
if not KEEP:
    for r in created.values():
        if r["id"]:
            req(f"/auth/v1/admin/users/{r['id']}", method="DELETE", key=SVC)
    print("\n測試帳號與測試單已刪除")
else:
    print(f"\n保留議價中測試單 id={keep_id}，測試帳號 990001-990003 亦保留（記得刪）")

print(f"\n通過 {len(PASS)} 項，失敗 {len(FAIL)} 項")
if FAIL:
    print("失敗項目：" + "、".join(FAIL))
    sys.exit(1)
