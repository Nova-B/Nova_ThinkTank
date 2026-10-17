import { useEffect, useState } from "react";
import { api } from "../api";
import type { Employee } from "../types";

interface Source {
  title: string;
  url: string;
  publishedAt: string | null;
  accessedAt: string;
  fetched: boolean;
}
interface Claim {
  id: string;
  statement: string;
  kind: "evidence" | "inference";
  confidence: string;
  sources: Source[];
  reasoning: string | null;
}

function nameOf(key: string, roster: Employee[]): string {
  const [kind, who] = key.split(":");
  const label = roster.find((e) => e.id === who)?.label ?? who;
  switch (kind) {
    case "brief":
      return "소장의 연구 설계";
    case "memo":
      return `${label}의 리서치 메모`;
    case "memo-final":
      return `${label}의 최종 메모`;
    case "answer":
      return "동료 질문에 대한 답";
    case "redteam-sources":
      return "레드팀의 출처 평가";
    case "redteam-critique":
      return "레드팀의 반론";
    case "report-draft":
      return "편집장의 보고서 초안";
    default:
      return key;
  }
}

const RELIABILITY: Record<string, string> = { high: "높음", medium: "보통", low: "낮음", unverifiable: "확인 불가" };

function SafeLink({ url, children }: { url: string; children: React.ReactNode }) {
  // 직원이 적은 URL이라 http(s)만 링크로 만든다
  return /^https?:\/\//.test(url) ? (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

function View({ k, value, roster }: { k: string; value: unknown; roster: Employee[] }) {
  const v = value as Record<string, unknown>;
  if (k === "brief") {
    const b = v as { refinedQuestion: string; framing: string; assignments: { researcherId: string; lens: string; subquestions: { id: string; question: string }[] }[] };
    return (
      <div className="art">
        <h3>{b.refinedQuestion}</h3>
        <p>{b.framing}</p>
        {b.assignments.map((a) => (
          <div key={a.researcherId} className="art-block">
            <h4>
              {roster.find((e) => e.id === a.researcherId)?.label ?? a.researcherId}: {a.lens}
            </h4>
            <ul>
              {a.subquestions.map((q) => (
                <li key={q.id}>
                  {q.id}. {q.question}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    );
  }
  if (k.startsWith("memo")) {
    const m = v as { claims: Claim[]; openQuestions: string[] };
    return (
      <div className="art">
        <ol className="claims">
          {m.claims.map((c) => (
            <li key={c.id}>
              <p>
                <b>{c.id}</b> <span className={`kind kind-${c.kind}`}>{c.kind === "evidence" ? "근거" : "추론"}</span>{" "}
                <span className="conf">확신 {c.confidence}</span>
              </p>
              <p>{c.statement}</p>
              {c.reasoning ? <p className="reason">추론: {c.reasoning}</p> : null}
              {c.sources.length ? (
                <ul className="sources">
                  {c.sources.map((s, i) => (
                    <li key={i}>
                      <SafeLink url={s.url}>{s.title}</SafeLink>
                      {s.fetched ? "" : " (본문 미확인)"}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
        {m.openQuestions.length ? (
          <>
            <h4>남긴 질문</h4>
            <ul>
              {m.openQuestions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    );
  }
  if (k === "redteam-sources") {
    const r = v as { sources: { url: string; reliability: string; note: string }[]; independentReading: string[] };
    return (
      <div className="art">
        <h4>결론을 보기 전에, 근거만 보고 한 해석</h4>
        <ul>
          {r.independentReading.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
        <table className="rel">
          <thead>
            <tr>
              <th>출처</th>
              <th>신뢰도</th>
              <th>이유</th>
            </tr>
          </thead>
          <tbody>
            {r.sources.map((s) => (
              <tr key={s.url}>
                <td>
                  <SafeLink url={s.url}>{s.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 48)}</SafeLink>
                </td>
                <td className={`rel-${s.reliability}`}>{RELIABILITY[s.reliability] ?? s.reliability}</td>
                <td>{s.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (k === "redteam-critique") {
    const c = v as { challenges: { claimIds: string[]; type: string; argument: string; severity: string; wouldChangeConclusion: boolean }[]; conditionsWhereWrong: string[] };
    return (
      <div className="art">
        <ol className="challenges">
          {c.challenges.map((x, i) => (
            <li key={i} className={`sev-${x.severity}`}>
              <p>
                <b>심각도 {x.severity}</b> {x.claimIds.length ? `대상 ${x.claimIds.join(", ")}` : ""}
                {x.wouldChangeConclusion ? <span className="changes"> 결론을 바꿀 수 있음</span> : null}
              </p>
              <p>{x.argument}</p>
            </li>
          ))}
        </ol>
        <h4>결론이 틀리게 되는 조건</h4>
        <ul>
          {c.conditionsWhereWrong.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      </div>
    );
  }
  if (k.startsWith("answer")) {
    const a = v as { answer: string; basis: string };
    return (
      <div className="art">
        <p>{a.answer}</p>
        <p className="conf">{a.basis === "evidence" ? "근거 있음" : "추론"}</p>
      </div>
    );
  }
  return <pre className="art-raw">{JSON.stringify(value, null, 2)}</pre>;
}

export function ArtifactPanel({ studyId, artifacts, roster }: { studyId: string; artifacts: { key: string }[]; roster: Employee[] }) {
  const [key, setKey] = useState<string | null>(null);
  const [value, setValue] = useState<unknown>(null);
  // 수정본이 같은 내용이면 둘 다 보여 줄 이유가 없다 → memo-final만 남긴다
  const shown = artifacts.filter((a) => !(a.key.startsWith("memo:") && artifacts.some((b) => b.key === `memo-final:${a.key.slice(5)}`)));

  useEffect(() => {
    if (!key) return;
    // A를 고른 뒤 바로 B를 고르면 A 응답이 늦게 와서 B 자리에 그려질 수 있다 → 이 요청이 아직 유효할 때만 반영
    let current = true;
    setValue(null);
    api.artifact(studyId, key).then(
      (r) => current && setValue(r.value),
      () => current && setValue(undefined),
    );
    return () => {
      current = false;
    };
  }, [studyId, key]);

  if (!shown.length) return <p className="empty">직원들이 첫 자료를 내면 여기에 쌓입니다.</p>;
  return (
    <div className="artifacts">
      <ul className="art-list">
        {shown.map((a) => (
          <li key={a.key}>
            <button type="button" aria-pressed={key === a.key} onClick={() => setKey(a.key)}>
              {nameOf(a.key, roster)}
            </button>
          </li>
        ))}
      </ul>
      <div className="art-view">{key && value !== null && value !== undefined ? <View k={key} value={value} roster={roster} /> : <p className="empty">왼쪽에서 자료를 고르세요.</p>}</div>
    </div>
  );
}
