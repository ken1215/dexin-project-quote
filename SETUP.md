# 建置手冊 — 德新物業(立德新)專案工程報價系統

> **✅ 2026-08-25：正式環境已建置完成並上線。**
> Supabase 專案 `dexin-quote`（ref `xjylpaqvdxmxzehvwreg`，Singapore）、
> 資料表與 RLS、Edge Function、GitHub Actions 自動部署都已就緒。
> 系統網址：<https://ken1215.github.io/dexin-project-quote/>
>
> 本文件保留完整重建步驟，供日後換帳號、搬家或災難復原時照做。

---

## 一、Supabase 專案

1. <https://supabase.com> 登入 → **New project**
   - Name `dexin-quote`／Region **Southeast Asia (Singapore)**／Plan Free
   - Database Password 自己設一組並存起來（只有直連 Postgres 備份時會用到）
2. 專案建好後，用 CLI 連上（比在網頁貼 SQL 快，而且可重複執行）：
   ```bash
   npx supabase login          # 要在真正的終端機跑，非 TTY 環境會失敗
   npx supabase link --project-ref <你的 ref> --password "<DB 密碼>"
   ```

### 依序執行資料庫腳本

**順序不能跳**，每一支都可重複執行：

```bash
cd C:\Users\linchy\Documents\CODE\dexin-project-quote
for f in db/01_schema.sql db/02_seed.sql db/03_allow_item_delete.sql \
         db/04_labor_productivity.sql db/05_hvac_clean.sql \
         db/06_unitize_and_productivity.sql db/07_cleanup_units.sql \
         db/08_link_productivity.sql db/09_fix_labor_cost_fn.sql \
         db/10_fix_rls.sql db/11_lock_signup.sql; do
  npx supabase db query --linked -f "$f"
done
```

| 檔案 | 做什麼 |
|---|---|
| `01_schema.sql` | 14 張表、RLS 政策、調價軌跡觸發器、單號產生器 |
| `02_seed.sql` | 初始單價庫、佐證來源、物價指數、工資時段係數、系統參數 |
| `03_allow_item_delete.sql` | `quote_lines.item_id` 改 `on delete set null`，讓品項可刪而不動歷史單 |
| `04_labor_productivity.sql` | 工率基準表 ＋ `price_items.productivity_id` |
| `05_hvac_clean.sql` | 新增「空調清潔保養工程」大項 |
| `06_unitize_and_productivity.sql` | 複合品項拆解入庫 ＋ 38 筆工率基準 ＋ 工資加成係數 |
| `07_cleanup_units.sql` | 單位正規化（M/M2 → 米/m²）、品名去除案件註記 |
| `08_link_productivity.sql` | 品項 ↔ 工率對接（報價單的工率分析頁靠這個） |
| `09_fix_labor_cost_fn.sql` | `labor_cost_per_unit()` 補上加成係數 |
| `10_fix_rls.sql` | **修送審會刪光明細、同仁可刪已核可單明細、退回單死路** |
| `11_lock_signup.sql` | **堵住自行註冊者讀走單價庫**：讀取需 profile 啟用；新註冊預設停用 |

**怎麼確認成功**：Table Editor 應看到 `price_items` 約 206 筆、`labor_productivity` 38 筆、
`categories` 9 筆、`settings` 7 筆（含 `labor_markup`）。

### 部署 Edge Function（帳號管理用）

```bash
npx supabase functions deploy admin-users --project-ref <你的 ref>
```

這支在伺服器端用 `service_role` 建立／刪除帳號、重設密碼，並且每次呼叫都重查
`profiles` 確認呼叫者是「啟用中的主管」。**`service_role` 絕不能進前端**——
前端是 public repo 上的靜態網站，任何人都看得到原始碼。

### 建立第一個主管帳號

Edge Function 需要一個既有主管才能用，所以第一個要手動建：

1. **Authentication → Users → Add user**，勾 **Auto Confirm User**
2. SQL Editor 升權（`11_lock_signup.sql` 之後新帳號預設停用，所以要一併開啟用）：
   ```sql
   update profiles set role = 'manager', active = true, full_name = '工務處主管'
    where id = (select id from auth.users where email = 'manager@example.com');
   ```

之後所有同仁帳號都在系統的「人員權限」頁建立，不用再進 Supabase 後台。

### 建議一併關閉公開註冊（第二道鎖）

**Authentication → Sign In / Up → 關閉 Email signup**。

`11_lock_signup.sql` 已經讓自行註冊的人讀不到任何資料（實測驗證過），
但關掉註冊可以連帳號都建不成，兩道鎖都有比較安心。

---

## 二、本機開發

```bash
cd C:\Users\linchy\Documents\CODE\dexin-project-quote
cp .env.example .env.local     # 填入 Project URL 與 anon key
npm install
npm run dev                    # http://localhost:5173
npm test                       # 金額邏輯自我檢查
```

> `anon key` 是**設計上就要公開**的，權限由資料庫 RLS 把關。
> 但 `.env.local` 仍列在 `.gitignore`，正式建置的金鑰走 GitHub Secrets。

---

## 三、部署

### 自動（現行做法）

`git push` → GitHub Actions 自動建置上線。需要先設好兩個 Secret：

repo → **Settings → Secrets and variables → Actions**：
`VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`

Pages 來源設為 **GitHub Actions**（Settings → Pages → Source）。

### 手動備援

```bash
npm run deploy     # build + 推 gh-pages
```

會先檢查產出裡真的帶到專案專屬的 Supabase 網址、且 localhost fallback 已消失，
否則拒絕部署——避免推上一個連不到後端的空殼。

> **資料庫異動不會自動跑**，新增的 `db/*.sql` 要自己用 CLI 執行。

---

## 四、日常維運

| 事情 | 誰做 | 在哪做 | 頻率 |
|---|---|---|---|
| 調整標準單價、批次調價 | 主管 | 系統「單價維護」 | 隨時 |
| 刪除／停用品項 | 主管 | 系統「單價維護」（刪除前會顯示被幾張單用過） | 需要時 |
| 更新物價指數（CCI／銅價） | 主管 | 系統「物價指數」 | 每月初 |
| 調整工資加成係數 | 主管 | 系統「物價指數」（頁面附官方與自家歷史對照） | 少 |
| 補齊佐證 | 主管 | 「單價維護」勾「只看無佐證」 | 逐步 |
| 核定停用品項的單價 | 主管 | 「單價維護」找標【待主管核定】者 | 逐步 |
| 新增／停用／刪除帳號 | 主管 | 系統「人員權限」 | 需要時 |
| 資料備份 | — | Supabase 免費方案每日自動備份，保留 7 天 | 自動 |

---

## 附錄：物價指數官方查詢入口

| 指數 | 網址 |
|---|---|
| 營造工程物價指數（總指數／各中類／勞務類） | <https://nstatdb.dgbas.gov.tw/dgbasAll/webMain.aspx?sys=210&funid=A030502015> |
| 主計總處 CCI 統計表下載 | <https://www.stat.gov.tw/Statistics.aspx?n=3906&CaN=460> |
| 工程會 工程採購物價指數查詢 | <https://www.pcc.gov.tw/content/index?type=C&eid=1767> |
| 銅金屬國內量價走勢 | <https://chart.metaltrade.tw/cu/ndomestic/> |

工資的法源依據（已內建在「物價指數」頁）：勞動部基本工資（115/1/1 起月薪 29,500、時薪 196）、
勞基法 §24 及 §39 加班加給、臺北市政府工程預算參考單價（技術工 375 元/時）。
