import type { StudyRow } from "../store/store.js";
import type { Employee } from "./roster.js";
import type { Brief, Claim, Counter, Critique, Rebuttal, ReportDraft, SourceReview } from "./schemas.js";

const SCOPE = { macro: "거시 (사회·산업·국가)", personal: "개인" } as const;
const HORIZON = { now: "지금", "1-3y": "1~3년", "3-10y": "3~10년" } as const;
const STATUS = { unresolved: "미해결", partially_resolved: "일부 해소", resolved: "해소" } as const;
const RELIABILITY = { high: "높음", medium: "보통", low: "낮음", unverifiable: "확인 불가" } as const;
const STANCE = { accept: "수용", partial: "부분 수용", reject: "거부" } as const;
const VERDICT = {
  upheld: "반론 유지",
  overturned: "재반박 인정",
  unresolved: "미해결",
  // M1a(재반박 단계 전): 편집장이 반론을 받아들이지 않았다. 재반박이 있었던 것은 아니다
  declined: "반론 미수용(재반박 단계 전)",
} as const;

type Verdict = keyof typeof VERDICT;

/** 판정. M1a 보고서는 accepted: boolean으로 저장돼 있어 그때의 뜻대로 옮긴다 */
export function verdictOf(r: { verdict?: Verdict; accepted?: boolean }): Verdict {
  if (r.verdict) return r.verdict;
  if (r.accepted === true) return "upheld";
  if (r.accepted === false) return "declined";
  return "unresolved";
}

/**
 * 반론을 거의 다 유지했다면 반론이 다 옳았다는 뜻일 수도, 편집장이 반론 쪽으로 기우는 성향(아첨)일 수도 있다.
 * 둘을 구별할 수 없으니 읽는 사람에게 알린다. 반론이 적으면 우연일 수 있어 5개 이상일 때만.
 */
export function verdictSummary(draft: ReportDraft, total: number) {
  const counts = { upheld: 0, overturned: 0, unresolved: 0, declined: 0 };
  for (const r of draft.redteamResponses) counts[verdictOf(r as never)]++;
  const decided = counts.upheld + counts.overturned + counts.unresolved + counts.declined;
  const warn = total >= 5 && decided > 0 && counts.upheld / decided >= 0.9;
  return { counts, decided, warn };
}

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
  /** 재반박(M1b). 그 전 보고서에는 없다 */
  rebuttals?: { who: string; rebuttal: Rebuttal }[];
  counter?: Counter | null;
}): string {
  const { study, roster, brief, claims, review, critique, draft, researcherQuestions } = input;
  const rebuttals = input.rebuttals ?? [];
  const counter = input.counter ?? null;
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

  const summary = verdictSummary(draft, critique.challenges.length);
  push(rebuttals.length ? "## 레드팀 반론, 재반박, 판정" : "## 레드팀 반론과 편집장의 응답", "");
  const legacy = summary.counts.declined ? ` · 반론 미수용(재반박 단계 전) ${summary.counts.declined}` : "";
  push(
    `편집장 판정: 반론 유지 ${summary.counts.upheld} · 재반박 인정 ${summary.counts.overturned} · 미해결 ${summary.counts.unresolved}${legacy} (반론 ${critique.challenges.length}개)`,
    "",
  );
  if (rebuttals.length) {
    // 토론이 실제로 어떻게 흘렀는지. 연구끼리 비교하려고 남긴다
    const stances = { accept: 0, partial: 0, reject: 0 };
    let revised = 0;
    for (const { rebuttal } of rebuttals) {
      for (const x of rebuttal.responses) {
        stances[x.stance]++;
        if (x.revisedClaim) revised++;
      }
    }
    const concede = counter?.replies.filter((x) => x.verdict === "concede").length ?? 0;
    const maintain = counter?.replies.filter((x) => x.verdict === "maintain").length ?? 0;
    push(
      `토론 지표: 재반박 수용 ${stances.accept} · 부분 수용 ${stances.partial} · 거부 ${stances.reject}, 고친 주장 ${revised}개, ` +
        `2라운드 ${concede + maintain}건(레드팀 인정 ${concede} · 유지 ${maintain})`,
      "",
    );
  }
  if (summary.warn) {
    push(
      `> ⚠️ 편집장이 반론을 거의 모두(${summary.counts.upheld}/${summary.decided}) 유지했습니다. 반론이 정말 다 옳았을 수도 있지만,`,
      "> AI는 반박을 받으면 쉽게 따라가는 경향이 있습니다. 아래 재반박의 근거를 직접 확인해 보세요.",
      "",
    );
  }
  critique.challenges.forEach((c, i) => {
    const no = i + 1;
    const r = draft.redteamResponses.find((x) => x.challengeNo === no);
    push(`${no}. **[${c.severity}] ${c.type}**${refs(c.claimIds)} — ${c.argument}${c.wouldChangeConclusion ? " _(결론을 바꿀 수 있음)_" : ""}`);
    for (const { who, rebuttal } of rebuttals) {
      for (const x of rebuttal.responses.filter((y) => y.challengeNo === no)) {
        const ev = x.evidence.map((e) => `[${e.title}](${e.url})`).join(", ");
        push(`   - 재반박 (${who}, **${STANCE[x.stance]}**): ${x.argument}${ev ? ` — 근거: ${ev}` : ""}`);
        if (x.revisedClaim) push(`     - 고친 주장: ${x.revisedClaim}`);
      }
    }
    const last = counter?.replies.find((y) => y.challengeNo === no);
    if (last) push(`   - 레드팀 마지막 답 (**${last.verdict === "concede" ? "재반박 인정" : "반론 유지"}**): ${last.argument}`);
    push(`   - 판정: ${r ? `**${VERDICT[verdictOf(r as never)]}** — ${r.response}` : "_(판정 없음)_"}`);
    const resolveBy = (r as { resolveBy?: string | null } | undefined)?.resolveBy;
    if (resolveBy) push(`     - 풀리려면: ${resolveBy}`);
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
