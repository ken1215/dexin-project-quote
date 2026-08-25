# 建置手冊 — 德新物業(立德新)專案工程報價系統

> **✅ 2026-08-25：第一、二段（Supabase）已經做完了。**
> 專案 `dexin-quote` 已建立（ref `xjylpaqvdxmxzehvwreg`，Singapore），
> schema 與 seed 已執行（201 品項），主管與測試同仁帳號已建立，
> RLS 權限已實測通過。**你只需要做第三、四段。**
> 下方第一、二段保留作為日後重建或搬家的參考。

---

## 一、建立 Supabase 專案（後端：帳號 + 資料庫）

1. 到 <https://supabase.com> → 用 GitHub 帳號登入（就是你現有那個 `ken1215`）。
2. **New project**
   - Name：`dexin-quote`
   - Database Password：自己設一組並**存起來**（之後幾乎不會用到，但遺失只能重設）
   - Region：**Southeast Asia (Singapore)**（離台灣最近）
   - Plan：Free
3. 等 1～2 分鐘，專案建好。

> 免費方案上限 2 個 active 專案。你已有 `chinyi-rental`，這是第 2 個，剛好用完。
> 免費專案閒置 7 天會被暫停，進 Dashboard 按一下即可喚醒——工務處天天在用就不會發生。

### 建立資料表

左側 **SQL Editor** → **New query**，依序做兩次：

1. 貼上 `db/01_schema.sql` 全部內容 → **Run**
2. 貼上 `db/02_seed.sql` 全部內容 → **Run**

**怎麼確認成功**：左側 **Table Editor** 應該看得到 `price_items`（201 筆）、`categories`（8 筆）、
`labor_rates`（4 筆）、`evidence_sources`（10 筆）、`material_indices`（6 筆）。

> 兩個 SQL 都可以重複執行，不會把資料弄壞（`on conflict do update`）。

### 拿連線金鑰

**Project Settings → API**，複製兩個值：

| 名稱 | 長相 | 用途 |
|---|---|---|
| Project URL | `https://xxxxx.supabase.co` | 前端連線位址 |
| `anon` `public` key | `eyJhbGci...`（很長） | 前端公開金鑰 |

> `anon key` 是**設計上就要公開**的，放進 GitHub 沒問題——真正的權限由資料庫的 RLS 規則把關。
> **絕對不要**動到 `service_role` key，那支是萬能鑰匙，只能留在伺服器端（本系統沒有伺服器端，所以根本用不到）。

---

## 二、建立第一個主管帳號

1. Supabase 左側 **Authentication → Users → Add user → Create new user**
   - Email：填工務處主管的信箱
   - Password：設一組
   - **勾選 Auto Confirm User**（不然要收信認證）
2. 回到 **SQL Editor**，把這個帳號升成主管（把信箱換成你剛建的）：

```sql
update profiles set role = 'manager', full_name = '工務處主管'
where id = (select id from auth.users where email = 'manager@example.com');
```

**怎麼確認成功**：Table Editor → `profiles`，該列 `role` 應為 `manager`。

### 之後怎麼加同仁

同一個地方 **Add user** 建帳號即可，新帳號**預設是「同仁」**，
主管登入系統後在「人員權限」頁可改角色、停用離職人員。

---

## 三、本機先跑起來看看

```bash
cd C:\Users\linchy\Documents\CODE\dexin-project-quote
cp .env.example .env.local     # 然後把 URL 與 anon key 填進去
npm install
npm run dev
```

瀏覽器開 <http://localhost:5173>，用剛建的主管帳號登入。

**怎麼確認成功**：登入後看得到 201 筆品項、右上角顯示「主管」。

---

## 四、部署到 GitHub Pages

### 1. 建 repo 並推上去

```bash
cd C:\Users\linchy\Documents\CODE\dexin-project-quote
git init
git add -A
git commit -m "德新物業專案工程報價系統 初版"
gh repo create dexin-project-quote --public --source=. --push
```

> 用 **public**：GitHub Pages 對 private repo 需要付費方案。程式碼公開沒有安全問題——
> 單價資料在資料庫裡不在程式碼裡，權限由 RLS 把關。

### 2. 設定金鑰（給自動建置用）

repo 頁面 → **Settings → Secrets and variables → Actions → New repository secret**，建兩個：

| Name | Value |
|---|---|
| `VITE_SUPABASE_URL` | 你的 Project URL |
| `VITE_SUPABASE_ANON_KEY` | 你的 anon key |

### 3. 開啟 Pages

repo → **Settings → Pages → Source** 選 **GitHub Actions**。

推上去之後 `.github/workflows/deploy.yml` 會自動建置並發布。
網址是 **`https://ken1215.github.io/dexin-project-quote/`**

**怎麼確認成功**：repo 的 **Actions** 分頁那次 workflow 是綠勾，開上面網址看得到登入頁。

### 之後怎麼改版

改完程式 `git push` 就好，GitHub Actions 會自動重新建置上線。
**資料庫的異動（新增欄位之類）要自己去 Supabase SQL Editor 跑**，不會自動跑。

---

## 五、日常維運

| 事情 | 誰做 | 在哪做 | 頻率 |
|---|---|---|---|
| 調整標準單價 | 主管 | 系統「單價維護」 | 隨時 |
| 更新物價指數（CCI／銅價） | 主管 | 系統「物價指數」 | 每月初 |
| 補齊佐證（目前覆蓋率 48%） | 主管 | 系統「單價維護」→ 勾「只看無佐證」 | 逐步 |
| 裝修類改 m² 單價 | 主管 | 系統「單價維護」→ 勾「只看待轉 m²」 | 逐步 |
| 新增／停用人員 | 主管 | Supabase 建帳號 → 系統「人員權限」設角色 | 需要時 |
| 資料備份 | — | Supabase 免費方案有每日自動備份，保留 7 天 | 自動 |

---

## 附錄：物價指數的官方查詢入口

主管每月更新指數時，從這裡抄數字：

| 指數 | 查詢網址 |
|---|---|
| 營造工程物價指數（總指數／各中類） | <https://nstatdb.dgbas.gov.tw/dgbasAll/webMain.aspx?sys=210&funid=A030502015> |
| 主計總處 CCI 統計表下載 | <https://www.stat.gov.tw/Statistics.aspx?n=3906&CaN=460> |
| 工程會 工程採購物價指數查詢 | <https://www.pcc.gov.tw/content/index?type=C&eid=1767> |
| 銅金屬國內量價走勢 | <https://chart.metaltrade.tw/cu/ndomestic/> |

工資的法源與行情依據：勞動部基本工資公告（115/1/1 起月薪 29,500、時薪 196）、
勞基法 §24 及 §39 的加班加給規定，已內建在「物價指數」頁的工資時段加成表。
