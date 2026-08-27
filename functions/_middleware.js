/**
 * Cloudflare Pages Function — 把 Supabase 藏到自有域名底下的反向代理。
 *
 * 為什麼需要它：聯新的網路過濾把 `github.io`（個人網頁／程式碼託管類）與
 * `supabase.co`（雲端服務類）整類擋掉，所以「只把網頁換個地方放」沒有用——
 * 畫面出得來，但登入與讀單價庫的請求照樣被擋在牆外。
 *
 * 這支讓瀏覽器全程只連 `quote.<自有域名>` 一個位址：
 *   /rest/v1/*      單價庫、報價單等資料表
 *   /auth/v1/*      登入、換 token、改密碼
 *   /functions/v1/* 帳號管理 Edge Function
 *   /storage/v1/*   （目前未用，先留著）
 *   /realtime/v1/*  （目前未用，先留著）
 * 其餘路徑（`/`、`/assets/*`）交還給 Pages 出靜態檔。
 *
 * 部署：Cloudflare Pages 專案設定 → 環境變數加 `SUPABASE_URL`
 *       （值＝ https://xjylpaqvdxmxzehvwreg.supabase.co），本檔隨 repo 一起部署。
 * 前端：`VITE_SUPABASE_URL` 改成自有域名本身（例：https://quote.example.com），
 *       anon key 不變——它本來就是公開的，真正的把關在 RLS。
 *
 * ⚠️ 這支只換傳輸路徑，不做任何權限判斷。所有權限仍由資料庫 RLS 決定，
 *    所以「多一層代理」不會讓任何人多拿到一筆資料。
 */

/** 要轉發給 Supabase 的路徑前綴；其餘一律交還給靜態站 */
const PROXY_PREFIXES = ['/rest/', '/auth/', '/functions/', '/storage/', '/realtime/']

export async function onRequest(context) {
  const { request, env, next } = context
  const url = new URL(request.url)

  if (!PROXY_PREFIXES.some((p) => url.pathname.startsWith(p))) {
    return next()
  }

  const upstream = env.SUPABASE_URL
  if (!upstream) {
    // 寧可整個壞掉並講清楚，也不要靜默回 404 讓人以為是程式錯
    return new Response(
      'Pages 專案缺少環境變數 SUPABASE_URL，代理無法運作。\n' +
      '請到 Cloudflare Pages → Settings → Environment variables 補上。',
      { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
    )
  }

  const target = upstream.replace(/\/+$/, '') + url.pathname + url.search

  // 原樣轉發標頭（apikey / Authorization / Prefer / Content-Type 都要留），
  // 只拿掉 Host——留著會讓 Supabase 收到錯的主機名而拒絕。
  const headers = new Headers(request.headers)
  headers.delete('host')

  const resp = await fetch(target, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'manual',
  })

  // 回應原樣帶回。因為瀏覽器認定是同源請求，這裡不需要也不應該加 CORS 標頭。
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  })
}
