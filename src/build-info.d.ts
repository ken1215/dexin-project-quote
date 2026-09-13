/**
 * 建置期由 vite.config.ts 的 define 灌進來的常數。
 * 不是執行期變數，打包時就被替換成字面值，所以不會有「版次顯示成上一版」的問題。
 */
declare const __APP_VERSION__: string
declare const __BUILD_TIME__: string
