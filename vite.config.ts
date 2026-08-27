import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// 資產路徑的前綴。三個部署目標不一樣，弄錯會是「畫面全白、console 說
// MIME type 是 text/html」——因為 index.html 去要一個不存在的路徑，
// 伺服器回了 SPA fallback 的 HTML 當成 JS/CSS。
//   本機開發        → /
//   GitHub Pages    → /dexin-project-quote/（走 repo 子路徑）
//   Cloudflare Pages→ /（自有站台的根目錄，由 VITE_BASE 指定）
export default defineConfig(({ command }) => ({
  base: process.env.VITE_BASE ?? (command === 'build' ? '/dexin-project-quote/' : '/'),
  plugins: [react(), tailwindcss()],
}))
