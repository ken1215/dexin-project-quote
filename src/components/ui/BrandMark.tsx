import mark from '../../assets/dexin-mark-color.svg'

/**
 * 德新標誌（原色）。CIS 母規範訂灰階底色分級：K0–10 用原色、K11–89 禁用、K90–100 用實心反白。
 * 2026-11-12 頁首改白底後，標誌一律放在白／淺底（K0–10）上，直接用原色即可——
 * 以前深藍頁首（落在禁用區間）才需要墊一塊白底，那層已拿掉。
 * 若日後又要放到深色底上，請改用反白版，不要再墊白塊。
 * 最小尺寸規範：單獨標誌 ≧ 24px（size 是高度；寬高比依 SVG viewBox 68:74）。
 */
export default function BrandMark({ size = 28, className = '' }: { size?: number; className?: string }) {
  return (
    <img
      src={mark}
      alt="德新物業"
      className={`shrink-0 ${className}`}
      style={{ height: size, width: Math.round((size * 68) / 74) }}
    />
  )
}
