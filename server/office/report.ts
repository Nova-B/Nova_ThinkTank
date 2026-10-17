// 보고서 Markdown (Obsidian 볼트용). 읽는 순서와 내용은 report-model.ts가 정하고, 여기서는 그리기만 한다.
// 길고 검증용인 부분(반론 공방·근거 목록)은 Obsidian 접기 콜아웃(> [!type]-)으로 접어 둔다.
import {
  buildReportModel,
  DISAGREEMENT,
  HORIZON,
  RELIABILITY,
  SCOPE,
  STANCE,
  STRENGTH_LABEL,
  VERDICT,
  type ReportInput,
  type Strength,
} from "./report-model.js";

export { verdictOf, verdictSummary } from "./report-model.js";

function yamlString(s: string): string {
  return JSON.stringify(s);
}

/** 콜아웃 안의 여러 줄 텍스트는 줄마다 "> "를 붙여야 콜아웃에 남는다 */
function quote(text: string, depth = 1): string {
  const prefix = "> ".repeat(depth);
  return text
    .split("\n")
    .map((l) => `${prefix}${l}`.trimEnd())
    .join("\n");
}

/** 한 줄 자리(콜아웃 줄·제목·목록)에 들어가는 AI 글. 줄바꿈으로 콜아웃 밖으로 새지 않게 한 줄로 접는다 */
function line(s: string): string {
  return s.replace(/\s*\r?\n+\s*/g, " ").trim();
}

/** 링크. http(s)만 링크로 만들고, 제목의 대괄호와 주소의 괄호·공백을 구조가 깨지지 않게 바꾼다 */
function mdLink(url: string, title: string): string {
  const text = line(title).replace(/[[\]]/g, (c) => `\\${c}`);
  if (!/^https?:\/\/\S/.test(url) || /[\r\n]/.test(url)) return text;
  // encodeURIComponent는 괄호를 그대로 두므로 직접 바꾼다(닫는 괄호가 링크를 일찍 끝내지 못하게)
  const safe: Record<string, string> = { "(": "%28", ")": "%29", "<": "%3C", ">": "%3E", " ": "%20" };
  return `[${text}](${url.replace(/[()<> ]/g, (c) => safe[c]!)})`;
}

function dots(s: Strength): string {
  return `${"●".repeat(s)}${"○".repeat(3 - s)} ${STRENGTH_LABEL[s]}`;
}

function refs(ids: string[]): string {
  return ids.length ? ` (${ids.join(", ")})` : "";
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

const CALLOUT = { upheld: "warning", overturned: "success", unresolved: "question", declined: "note" } as const;

export function renderReport(input: ReportInput): string {
  const m = buildReportModel(input);
  const g = m.glance;
  const out: string[] = [];
  const push = (...l: string[]) => out.push(...l);

  push(
    "---",
    "type: content",
    "stage: develop",
    `created: "${m.date}"`,
    `updated: "${new Date().toISOString().slice(0, 10)}"`,
    "tags:",
    "  - 씽크탱크",
    "  - 연구보고서",
    `study_id: "${m.studyId}"`,
    `question: ${yamlString(m.question)}`,
    "checked: false",
    "---",
    "",
    `# ${line(m.title)}`,
    "",
    "> [!info] 연구 정보",
    quote(`**질문**: ${line(m.question)}`),
    quote(`**다듬은 질문**: ${line(m.refinedQuestion)}`),
    quote(`**Study** \`${m.studyId}\`, ${m.date}, 직원: ${m.staff}`),
    "> 이 보고서는 AI 직원들이 썼습니다. 판단은 읽는 사람의 몫입니다.",
    "",
    "## 🪞 내 예상",
    "",
    m.hypothesis ? line(m.hypothesis) : "_(연구 전에 적지 않음. 아래를 읽기 전에 한 줄 적어 보세요)_",
    "",
    "## 한눈에 보기",
    "",
    `발견 ${g.findingCount}개, 행동 제안 ${g.actionCount}개, 미해결 질문 ${g.openQuestionCount}개.`,
    `레드팀 반론 ${g.challengeCount}개 → ${verdictLine(g.verdicts.counts)}`,
    "",
  );
  if (g.verdicts.warn) push(...warning(g.verdicts.counts.upheld, g.verdicts.decided), "");
  push("| # | 핵심 발견 | 근거 신호 |", "| --- | --- | --- |");
  for (const f of g.findings) push(`| ${f.no} | ${cell(f.heading)} | ${dots(f.strength)} |`);
  push("");
  if (g.uncertainties.length) push("**가장 큰 불확실성**", "", ...g.uncertainties.map((u) => `- ${line(u)}`), "");
  if (g.now.personal.length || g.now.macro.length) {
    push("**지금 할 수 있는 일**", "");
    if (g.now.personal.length) push(`- 개인: ${g.now.personal.map(line).join(" / ")}`);
    if (g.now.macro.length) push(`- 거시: ${g.now.macro.map(line).join(" / ")}`);
    push("");
  }
  push(
    "_근거 신호는 참고 지표입니다. 리서처 모델이 스스로 매긴 확신도에서 출발해, 출처 본문을 못 열었거나 주장을 고쳤으면 보통까지, 레드팀이 출처를 모두 낮게 봤으면 약함까지 낮추고, 심각도 high 반론이 유지·미해결이면 한 단계 더 낮춥니다. 발견은 근거 주장들의 평균을 내림합니다. 사람의 검증이 아닙니다._",
    "",
    "## 핵심 발견",
    "",
  );
  for (const f of m.findings) push(`### ${f.no}. ${line(f.heading)}`, "", `근거 신호 ${dots(f.strength)}, 근거 주장${refs(f.claimIds)}`, "", f.body, "");

  push("## 행동 제안", "");
  for (const scope of ["personal", "macro"] as const) {
    const items = m.actions.filter((a) => a.scope === scope);
    if (!items.length) continue;
    push(`### ${SCOPE[scope]}`, "");
    for (const a of items) push(`- **${line(a.action)}** _(${HORIZON[a.horizon]})_${refs(a.claimIds)}`, `  - ${line(a.rationale)}`);
    push("");
  }

  push("## 이견과 미해결 질문", "", "### 이견", "");
  if (!m.disagreements.length) push("_(편집장이 기록한 이견 없음)_", "");
  for (const d of m.disagreements) {
    push(`- **${line(d.topic)}** (${DISAGREEMENT[d.status]})`);
    for (const p of d.positions) push(`  - ${line(p.holder)}: ${line(p.view)}`);
  }
  push("", "### ❓ 미해결 질문", "", ...m.openQuestions.map((q) => `- ${line(q)}`), "");
  if (m.researcherQuestions.length) {
    push(`> [!quote]- 리서처가 조사 중 남긴 질문 원문 (${m.researcherQuestions.length}개)`, ...m.researcherQuestions.map((q) => `> - ${line(q.question)} _(${q.who})_`), "");
  }

  push("## 검증 기록", "", `레드팀 반론 ${g.challengeCount}개, 편집장 판정: ${verdictLine(g.verdicts.counts)}`);
  if (g.debate) {
    const d = g.debate;
    push(
      `토론 지표: 재반박 수용 ${d.accept} · 부분 수용 ${d.partial} · 거부 ${d.reject}, 고친 주장 ${d.revised}개, 2라운드 ${d.concede + d.maintain}건(레드팀 인정 ${d.concede} · 유지 ${d.maintain})`,
    );
  }
  push("");
  if (g.verdicts.warn) push(...warning(g.verdicts.counts.upheld, g.verdicts.decided), "");
  for (const c of m.challenges) {
    const verdict = c.verdict ? VERDICT[c.verdict] : "판정 없음";
    push(
      `> [!${c.verdict ? CALLOUT[c.verdict] : "note"}]- 반론 ${c.no}: ${verdict} (${c.severity}, ${c.type}${refs(c.claimIds)})`,
      quote(`${line(c.argument)}${c.wouldChangeConclusion ? " _(결론을 바꿀 수 있음)_" : ""}`),
    );
    for (const r of c.rebuttals) {
      const ev = r.evidence.map((e) => mdLink(e.url, e.title)).join(", ");
      push(quote(`- 재반박 (${r.who}, **${STANCE[r.stance]}**): ${line(r.argument)}${ev ? ` 근거: ${ev}` : ""}`));
      if (r.revisedClaim) push(quote(`  - 고친 주장: ${line(r.revisedClaim)}`));
    }
    if (c.counter) push(quote(`- 레드팀 마지막 답 (**${c.counter.verdict === "concede" ? "재반박 인정" : "반론 유지"}**): ${line(c.counter.argument)}`));
    if (c.response) push(quote(`- 판정 이유: ${line(c.response)}`));
    if (c.resolveBy) push(quote(`- 풀리려면: ${line(c.resolveBy)}`));
    push("");
  }
  push("**이 연구의 결론이 틀리게 되는 조건 (레드팀)**", "", ...m.conditionsWhereWrong.map((c) => `- ${line(c)}`), "");
  if (m.missingPerspectives.length) {
    push(`> [!quote]- 빠진 관점 (레드팀, ${m.missingPerspectives.length}개)`, ...m.missingPerspectives.map((c) => `> - ${line(c)}`), "");
  }

  push("## 부록", "", `> [!abstract]- 근거 목록 (주장 ${m.claims.length}개)`);
  for (const c of m.claims) {
    push(`> **${c.id}** ${c.kind === "evidence" ? "근거" : "추론"}, 확신 ${c.confidence}, 신호 ${dots(c.strength)} _(${c.author})_`);
    push(quote(line(c.statement)));
    if (c.revised) push(`> - 고친 주장: ${line(c.revised)}`);
    for (const r of c.relatedRevisions) push(`> - 반론 ${r.no}번 재반박에서 함께 고친 주장: ${line(r.text)}`);
    if (c.reasoning) push(`> - 추론: ${line(c.reasoning)}`);
    for (const s of c.sources) {
      const rel = m.reliability.get(s.url);
      const meta = [s.publishedAt && `발행 ${s.publishedAt}`, `확인 ${s.accessedAt}`, !s.fetched && "본문 미확인", rel && `레드팀 신뢰도 ${RELIABILITY[rel.reliability]}`]
        .filter(Boolean)
        .join(", ");
      push(`> - ${mdLink(s.url, s.title)} (${meta})`);
    }
    push(">");
  }
  push(
    "",
    "> [!abstract]- 연구 범위",
    quote(line(m.scope.framing)),
    ">",
    ...m.scope.lenses.map((l) => `> - **${l.who}**: ${line(l.lens)}`),
    ...(m.scope.outOfScope.length ? [">", `> 다루지 않은 것: ${m.scope.outOfScope.map(line).join(", ")}`] : []),
    "",
    "## 🪞 사후 검토",
    "",
    "> 직접 채울 칸: 예상과 무엇이 달랐나? 무엇이 걸렸고, 무엇은 받아들이지 않겠는가?",
    "",
    m.reflection ?? "-",
    "",
  );
  return out.join("\n");
}

function verdictLine(c: { upheld: number; overturned: number; unresolved: number; declined: number }): string {
  const legacy = c.declined ? ` · ${VERDICT.declined} ${c.declined}` : "";
  return `${VERDICT.upheld} ${c.upheld} · ${VERDICT.overturned} ${c.overturned} · ${VERDICT.unresolved} ${c.unresolved}${legacy}`;
}

function warning(upheld: number, decided: number): string[] {
  return [
    "> [!warning] 반론이 거의 모두 유지됐습니다",
    `> 편집장이 반론을 거의 모두(${upheld}/${decided}) 유지했습니다. 반론이 정말 다 옳았을 수도 있지만,`,
    "> AI는 반박을 받으면 쉽게 따라가는 경향이 있습니다. 검증 기록의 재반박 근거를 직접 확인해 보세요.",
  ];
}
