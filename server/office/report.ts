import type { StudyRow } from "../store/store.js";
import type { Employee } from "./roster.js";
import type { Brief, Claim, Critique, ReportDraft, SourceReview } from "./schemas.js";

const SCOPE = { macro: "거시 (사회·산업·국가)", personal: "개인" } as const;
const HORIZON = { now: "지금", "1-3y": "1~3년", "3-10y": "3~10년" } as const;
const STATUS = { unresolved: "미해결", partially_resolved: "일부 해소", resolved: "해소" } as const;
const RELIABILITY = { high: "높음", medium: "보통", low: "낮음", unverifiable: "확인 불가" } as const;

function yamlString(s: string): string {
  return JSON.stringify(s);
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

function refs(ids: string[]): string {
  return ids.length ? ` (${ids.join(", ")})` : "";
}

/**
 * 보고서 고정 양식: 가설 → 핵심 발견 → 이견 → 레드팀 반론과 응답 → 행동 제안 → 미해결 질문 → 근거 → 사후 검토.
 * "결론" 섹션은 일부러 두지 않는다(기획안 §3).
 */
export function renderReport(input: {
  study: StudyRow;
  roster: Employee[];
  brief: Brief;
  claims: Claim[];
  review: SourceReview;
  critique: Critique;
  draft: ReportDraft;
  /** 리서처가 남긴 미해결 질문 원문. 편집장이 고르지 않아도 서버가 보존한다 */
  researcherQuestions: { who: string; question: string }[];
}): string {
  const { study, roster, brief, claims, review, critique, draft, researcherQuestions } = input;
  const date = study.created_at.slice(0, 10);
  const reliability = new Map(review.sources.map((s) => [s.url, s]));
  const staff = roster.map((e) => `${e.label}(${e.engine})`).join(", ");
  const lines: string[] = [];
  const push = (...l: string[]) => lines.push(...l);

  push(
    "---",
    "type: content",
    "stage: develop",
    `created: "${date}"`,
    `updated: "${new Date().toISOString().slice(0, 10)}"`,
    "tags:",
    "  - 씽크탱크",
    "  - 연구보고서",
    `study_id: "${study.id}"`,
    `question: ${yamlString(study.question)}`,
    "checked: false",
    "---",
    "",
    `# ${draft.title}`,
    "",
    `> **질문**: ${study.question}`,
    `> **다듬은 질문**: ${brief.refinedQuestion}`,
    `> **Study** \`${study.id}\` · ${date} · 직원: ${staff}`,
    "> 이 보고서는 AI 직원들이 썼습니다. 판단은 읽는 사람의 몫입니다.",
    "",
    "## 🪞 Nova의 가설",
    "",
    study.hypothesis ? study.hypothesis : "_(연구 전에 적지 않음 — 보고서를 읽기 전에 한 줄 적어 보세요)_",
    "",
    "## 범위",
    "",
    brief.framing,
    "",
    ...brief.assignments.map((a) => `- **${roster.find((e) => e.id === a.researcherId)?.label ?? a.researcherId}** — ${a.lens}`),
    ...(brief.outOfScope.length ? ["", `다루지 않은 것: ${brief.outOfScope.join(" · ")}`] : []),
    "",
    "## 핵심 발견",
    "",
  );
  for (const f of draft.findings) push(`### ${f.heading}${refs(f.claimIds)}`, "", f.body, "");

  push("## 이견", "");
  if (!draft.disagreements.length) push("_(편집장이 기록한 이견 없음)_", "");
  for (const d of draft.disagreements) {
    push(`### ${d.topic} — ${STATUS[d.status]}`, "");
    for (const p of d.positions) push(`- **${p.holder}**: ${p.view}`);
    push("");
  }

  push("## 레드팀 반론과 편집장의 응답", "");
  critique.challenges.forEach((c, i) => {
    const r = draft.redteamResponses.find((x) => x.challengeNo === i + 1);
    push(
      `${i + 1}. **[${c.severity}] ${c.type}**${refs(c.claimIds)} — ${c.argument}${c.wouldChangeConclusion ? " _(결론을 바꿀 수 있음)_" : ""}`,
      `   - 응답: ${r ? `${r.accepted ? "✅ 받아들임" : "❌ 받아들이지 않음"} — ${r.response}` : "_(응답 없음)_"}`,
    );
  });
  push("", "**이 연구의 결론이 틀리게 되는 조건 (레드팀)**", "", ...critique.conditionsWhereWrong.map((c) => `- ${c}`), "");
  if (critique.missingPerspectives.length) {
    push("**빠진 관점 (레드팀)**", "", ...critique.missingPerspectives.map((c) => `- ${c}`), "");
  }

  push("## 행동 제안", "");
  for (const scope of ["macro", "personal"] as const) {
    const items = draft.actions.filter((a) => a.scope === scope);
    if (!items.length) continue;
    push(`### ${SCOPE[scope]}`, "");
    for (const a of items) push(`- **${a.action}** _(${HORIZON[a.horizon]})_${refs(a.claimIds)}`, `  - ${a.rationale}`);
    push("");
  }

  push("## ❓ 미해결 질문", "", ...draft.openQuestions.map((q) => `- ${q}`), "");
  if (researcherQuestions.length) {
    push("**리서처가 조사 중 남긴 질문 (원문)**", "", ...researcherQuestions.map((q) => `- ${q.question} _— ${q.who}_`), "");
  }

  push("## 근거 목록", "", "| ID | 주장 | 구분 | 확신 | 출처 (레드팀 신뢰도) |", "| --- | --- | --- | --- | --- |");
  for (const c of claims) {
    const src = c.sources.length
      ? c.sources
          .map((s) => {
            const rel = reliability.get(s.url);
            const meta = [s.publishedAt && `발행 ${s.publishedAt}`, `확인 ${s.accessedAt}`, !s.fetched && "본문 미확인"].filter(Boolean).join(", ");
            return `[${cell(s.title)}](${s.url}) — ${meta}${rel ? ` · ${RELIABILITY[rel.reliability]}` : ""}`;
          })
          .join("<br>")
      : "—";
    push(`| ${c.id} | ${cell(c.statement)} | ${c.kind === "evidence" ? "근거" : "추론"} | ${c.confidence} | ${src} |`);
  }
  push(
    "",
    "## 🪞 사후 검토",
    "",
    "> 직접 채울 칸: 가설과 무엇이 달랐나? 무엇이 걸렸고, 무엇을 받아들이지 않겠는가?",
    "",
    study.reflection?.trim() ? study.reflection.trim() : "-",
    "",
  );
  return lines.join("\n");
}
