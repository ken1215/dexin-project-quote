import type { StepSiteProps } from '../QuoteWizard'

/**
 * ① 位置與使用者：「這次要修的地方在哪、誰開的單」。
 *
 * 欄位對應（精靈上的稱呼 → 資料欄位 → 列印標單欄名，標單欄名一律不動）：
 * 位置 → project → 工程地點；開單人 → dept → 申請單位；
 * 現場聯絡窗口 → contact → 現場聯絡窗口；報價日期 → quote_date → 報價日期。
 * 「申請單位」實際存的是開單的工務處承辦人（DEPT_OPTIONS 八個選項都是「工務處-人名」），
 * 所以精靈上叫「開單人」比較好懂；列印標單的欄名是紅線，不跟著改。
 *
 * ── 與本次指派說明的兩處偏離（契約逼出來的，不是自行取捨）──
 * 1. 指派要本步驟放一句步驟說明「這次要修的地方在哪、誰開的單」。
 *    QuoteWizard 已在 Stepper 正下方統一渲染 STEP_HINT[step-1]（就是這一句），
 *    這裡再寫一次會讓同一句話在同一畫面出現兩次，故不重複；文案由容器持有。
 * 2. 指派要底部放「下一步：挑大項」＋ 停用原因「請先填位置」。
 *    兩者 QuoteWizard 已經有（NEXT_LABEL[0]／BLOCK_REASON[0]，文案一字不差），
 *    且 StepSiteProps 沒有 onNext，要加就得改 QuoteWizard 的契約（本次嚴禁）；
 *    真加了也違反規格「手機釘底 .action-bar 與桌機那組不得出現同一顆按鈕」。
 *    ＝ 全站只留 QuoteWizard 那一組動作列。
 */
export default function StepSite({ draft, deptOptions, onPatch }: StepSiteProps) {
  return (
    <div className="card max-w-2xl">
      <div className="card-title">① 位置與使用者</div>

      {/* 四欄一律單欄排列：這一步只問四件事，排成兩欄反而要左右掃視 */}
      <div className="grid grid-cols-1 gap-3">
        <div>
          <label className="label" htmlFor="wz-project">位置</label>
          <input
            id="wz-project"
            className="field"
            value={draft.project}
            placeholder="例：聯新國際醫院 3F 復健科天花板修繕"
            onChange={(e) => onPatch({ project: e.target.value })}
          />
          <div className="mt-1 text-xs text-ink-500">
            寫到樓層與位置，處長才看得出是哪一處要修。
          </div>
        </div>

        <div>
          <label className="label" htmlFor="wz-dept">開單人</label>
          {/* 上面選常用的、下面直接打，兩個都通。input+datalist 在已有值時會被自己的
              內容濾掉選項、換人要先清空，不直覺（已實測），所以維持兩個控制項。 */}
          <select
            id="wz-dept"
            className="field"
            value=""
            onChange={(e) => { if (e.target.value) onPatch({ dept: e.target.value }) }}
          >
            <option value="">— 從常用名單選 —</option>
            {deptOptions.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <input
            className="field mt-1"
            value={draft.dept}
            placeholder="或直接輸入"
            aria-label="開單人，直接輸入"
            onChange={(e) => onPatch({ dept: e.target.value })}
          />
        </div>

        <div>
          <label className="label" htmlFor="wz-contact">現場聯絡窗口</label>
          <input
            id="wz-contact"
            className="field"
            value={draft.contact}
            placeholder="例：復健科 林小姐 分機 2345"
            onChange={(e) => onPatch({ contact: e.target.value })}
          />
        </div>

        <div>
          <label className="label" htmlFor="wz-quote-date">報價日期</label>
          <input
            id="wz-quote-date"
            className="field"
            type="date"
            value={draft.quote_date}
            onChange={(e) => onPatch({ quote_date: e.target.value })}
          />
        </div>
      </div>
    </div>
  )
}
