import { money } from '../../lib/calc'
import type { Totals } from '../../lib/calc'

/**
 * 金額合計卡。開單與審閱共用同一份，金額口徑只此一處，
 * 不要在審閱頁另刻一份「看起來差不多」的版本。
 */
export default function TotalsCard(
  { totals, mgmtFeeRate, taxRate }:
  { totals: Totals; mgmtFeeRate: number; taxRate: number },
) {
  return (
    <div className="card">
      <div className="card-title">金額合計</div>
      <table className="w-full">
        <tbody>
          <tr>
            <td className="py-1 text-ink-700">工程小計</td>
            <td className="num py-1 text-ink-900">{money(totals.works)}</td>
          </tr>
          <tr>
            <td className="py-1 text-ink-700">
              工程管理費 {(mgmtFeeRate * 100).toFixed(1)}%
            </td>
            <td className="num py-1 text-ink-900">{money(totals.mgmt)}</td>
          </tr>
          <tr className="border-t border-ink-200">
            <td className="py-1 text-ink-700">小計</td>
            <td className="num py-1 text-ink-900">{money(totals.sub)}</td>
          </tr>
          <tr>
            <td className="py-1 text-ink-700">營業稅 {(taxRate * 100).toFixed(1)}%</td>
            <td className="num py-1 text-ink-900">{money(totals.tax)}</td>
          </tr>
          <tr className="border-t border-ink-200">
            <td className="py-1.5 font-semibold text-deep">合計</td>
            <td className="num py-1.5 text-[1rem] font-semibold text-deep">
              {money(totals.total)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
