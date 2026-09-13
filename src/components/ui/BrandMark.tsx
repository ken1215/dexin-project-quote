import mark from '../../assets/dexin-mark-color.svg'

/**
 * 德新標誌。CIS 母規範訂灰階底色分級：K0–10 用原色、K11–89 禁用、K90–100 用實心反白。
 * header 底色 #0054A7 換算明度落在「禁用」區間，所以原色標誌必須墊一塊白底
 * （＝把它放回 K0–10 的環境）才合規。最小尺寸規範：單獨標誌 ≧ 24px。
 */
export default function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-md bg-white p-1"
      style={{ width: size, height: size }}
    >
      <img src={mark} alt="德新物業" className="h-full w-full" />
    </span>
  )
}
