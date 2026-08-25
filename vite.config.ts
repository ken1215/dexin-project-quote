import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// GitHub Pages 走 /<repo>/ 子路徑，本機開發走根路徑
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/dexin-project-quote/' : '/',
  plugins: [react(), tailwindcss()],
}))
