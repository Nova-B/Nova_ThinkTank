import type { RateInfo } from "../types";

function Bar({ label, value }: { label: string; value: number | undefined }) {
  const pct = value === undefined ? null : Math.round(value * 100);
  return (
    <div className="meter">
      <span>{label}</span>
      <span className="meter-track" aria-hidden="true">
        <span className={`meter-fill${pct !== null && pct >= 80 ? " is-high" : ""}`} style={{ width: `${pct ?? 0}%` }} />
      </span>
      <span className="meter-num">{pct === null ? "모름" : `${pct}%`}</span>
    </div>
  );
}

/** Claude 구독 한도 사용률. Codex는 비율 정보를 주지 않아 표시하지 않는다 */
export function RateMeter({ rate }: { rate: RateInfo | null }) {
  return (
    <div className="rate" aria-label="Claude 사용 한도">
      <Bar label="Claude 5시간" value={rate?.fiveHour} />
      <Bar label="7일" value={rate?.sevenDay} />
    </div>
  );
}
