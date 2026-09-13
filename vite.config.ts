import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
) as { version: string }

// 建置時間一律記台北時間，登入頁要顯示給同仁看。
// sv-SE 的地區格式剛好是 `YYYY-MM-DD HH:mm:ss`，截到分鐘即可，不必自己拼字串。
const buildTime = new Date()
  .toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' })
  .slice(0, 16)

// 資產路徑的前綴。三個部署目標不一樣，弄錯會是「畫面全白、console 說
// MIME type 是 text/html」——因為 index.html 去要一個不存在的路徑，
// 伺服器回了 SPA fallback 的 HTML 當成 JS/CSS。
//   本機開發        → /
//   GitHub Pages    → /dexin-project-quote/（走 repo 子路徑）
//   Cloudflare Pages→ /（自有站台的根目錄，由 VITE_BASE 指定）
export default defineConfig(({ command }) => ({
  base: process.env.VITE_BASE ?? (command === 'build' ? '/dexin-project-quote/' : '/'),
  plugins: [react(), tailwindcss()],
  // 版次與建置時間在打包當下被替換成字面值，所以線上看到的必定是那一版的值，
  // 不會出現「改了版號但畫面還是舊的」。版次正本是 package.json 的 version。
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
}))
