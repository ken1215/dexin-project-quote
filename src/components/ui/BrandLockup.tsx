import BrandMark from './BrandMark'

/**
 * 德新物業橫式標誌組合：標誌 ＋「德新物業」（Noto Serif TC 900）／「LANDSEED PROPERTY」（Jost 500 主藍）。
 * 頁首用（列印抬頭在 PrintPage 以 px 另排——列印時根字級被釘成 11.5px，rem 會縮）；尺寸只有兩檔，不要在各處自己調字級。
 * 英文字標是標誌的一部分（logotype），不承載資訊，主藍小字的對比門檻不適用。
 */
const SIZE = {
  sm: { mark: 26, zh: 'text-[0.8125rem]', en: 'text-[0.4375rem]', gap: 'gap-2' },
  md: { mark: 32, zh: 'text-[0.9375rem]', en: 'text-[0.5rem]', gap: 'gap-2.5' },
} as const

export default function BrandLockup({ size = 'md' }: { size?: keyof typeof SIZE }) {
  const s = SIZE[size]
  return (
    <span className={`inline-flex shrink-0 items-center ${s.gap}`}>
      <BrandMark size={s.mark} />
      <span className="flex flex-col leading-none">
        <span className={`font-serif font-black tracking-[0.12em] text-ink-900 ${s.zh}`}>德新物業</span>
        <span className={`mt-1 whitespace-nowrap font-brand font-medium tracking-[0.3em] text-bright ${s.en}`}>
          LANDSEED PROPERTY
        </span>
      </span>
    </span>
  )
}
