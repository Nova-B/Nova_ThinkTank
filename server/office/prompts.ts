import type { Employee } from "./roster.js";
import type { Brief, Claim, Critique, SourceReview } from "./schemas.js";

const today = () => new Date().toISOString().slice(0, 10);

const COMMON = `
- 너는 Nova ThinkTank 연구소의 직원이다. 모든 출력은 한국어로 쓴다.
- 오늘 날짜는 {date}다. 최신 정보가 필요하면 웹 검색으로 확인한다.
- 출처로 확인하지 못한 내용을 사실처럼 쓰지 않는다. 확인하지 못했으면 확인하지 못했다고 쓴다.
- 매끈한 결론보다 근거의 한계와 불확실성을 드러내는 것이 이 연구소의 원칙이다.
- 최종 답은 반드시 주어진 JSON 스키마에 맞춘다.`;

const ROLE: Record<Employee["role"], string> = {
  director: `너는 소장이다. 질문을 연구 가능한 형태로 다듬고, 하위 질문으로 쪼개 리서처에게 배정한다.
결론을 미리 정하지 않는다. 서로 다른 관점이 드러나도록 리서처마다 관점(lens)을 다르게 준다.`,
  researcher: `너는 리서처다. 맡은 하위 질문을 웹 검색으로 조사하고, 주장 하나하나에 근거를 단다.
- evidence 주장에는 출처(제목·URL·발행일·확인일·근거 구절)를 단다. 페이지를 실제로 열지 못했으면 fetched=false.
- 근거 없이 네가 추론한 것은 inference로 표시하고 reasoning에 논리를 쓴다.
- 다른 리서처의 관점에서 확인이 필요한 것이 있으면 office 도구 ask_colleague로 짧게 물을 수 있다(최대 2개). 답은 다음 턴에 온다.`,
  redteam: `너는 레드팀이다. 이 연구의 가정과 결론을 공격하는 것이 일이다. 동의하는 척하지 않는다.
반대 근거, 과장, 편향, 오래된 자료, 빠진 관점, 결론이 틀리게 되는 조건을 찾는다.`,
  editor: `너는 편집장이다. 리서치와 레드팀 반론을 묶어 보고서를 쓴다.
- 결론을 하나로 매끈하게 정리하지 않는다. 합의된 것, 이견, 미해결 질문을 나눠 쓴다.
- 모든 발견과 행동 제안에 근거가 된 주장 ID를 단다. 목록에 없는 주장을 만들어 내지 않는다.
- 레드팀의 심각도 high 반론에는 반드시 받아들일지 말지와 이유를 쓴다.`,
};

export function instructionsFor(employee: Employee): string {
  return `${ROLE[employee.role]}\n${COMMON.replace("{date}", today())}`;
}

export function framePrompt(question: string, researchers: Employee[]): string {
  const list = researchers.map((r) => `- ${r.id} (${r.label})`).join("\n");
  return `연구 질문:
${question}

리서처 명단:
${list}

할 일:
1. 질문을 연구할 수 있게 한 문장으로 다듬는다(refinedQuestion).
2. 왜 중요한지, 어디까지 다룰지 쓴다(framing).
3. 리서처마다 관점(lens)과 하위 질문 2~4개를 배정한다. 모든 리서처에게 배정한다. 하위 질문 id는 Q1, Q2 … 로 겹치지 않게.
4. 이번에 다루지 않을 것을 적는다(outOfScope).`;
}

export function researchPrompt(brief: Brief, researcherId: string): string {
  const mine = brief.assignments.find((a) => a.researcherId === researcherId)!;
  const others = brief.assignments
    .filter((a) => a.researcherId !== researcherId)
    .map((a) => `- ${a.researcherId}: ${a.lens}`)
    .join("\n");
  return `연구 질문: ${brief.refinedQuestion}
배경: ${brief.framing}

너의 관점: ${mine.lens}
너의 하위 질문:
${mine.subquestions.map((q) => `- ${q.id}: ${q.question}`).join("\n")}

다른 리서처:
${others || "- 없음"}

하위 질문마다 웹 검색으로 조사해 주장(claims)을 3~6개 만든다. 주장마다 subquestionId를 단다.
조사하면서 생긴 미해결 질문은 openQuestions에 남긴다.`;
}

// 답변·수정 턴의 프롬프트는 세션이 없어도 이해할 수 있게 필요한 맥락을 직접 담는다.
// 세션 파일이 사라져 새 세션으로 다시 시작해도 같은 일을 할 수 있어야 하기 때문이다.

export function answerPrompt(fromLabel: string, question: string, ownClaims: Claim[]): string {
  const mine = ownClaims.map((c) => `- [${c.id}] (${c.kind}) ${c.statement}`).join("\n");
  return `동료 ${fromLabel}가 너에게 질문을 보냈다. 네 조사 결과를 바탕으로 짧게 답해라(5문장 이내).
근거가 있으면 basis=evidence와 출처를, 네 추론이면 basis=inference로 표시한다.
이 턴에서는 새 질문을 보내지 않는다.

네가 정리한 주장:
${mine || "- (없음)"}

질문: ${question}`;
}

export function revisePrompt(
  memo: { claims: Claim[]; openQuestions: string[] },
  answers: { to: string; question: string; answer: string }[],
): string {
  const list = answers.map((a, i) => `${i + 1}. ${a.to}에게: ${a.question}\n   답: ${a.answer}`).join("\n");
  const current = JSON.stringify(
    {
      claims: memo.claims.map(({ id: _id, author: _author, ...rest }) => rest),
      openQuestions: memo.openQuestions,
    },
    null,
    1,
  );
  return `네가 동료에게 보낸 질문의 답이 왔다.

${list}

네가 제출했던 리서치 메모:
${current}

이 답을 반영해 리서치 메모 전체를 다시 제출해라. 바뀐 것이 없으면 그대로 다시 제출한다.
동료의 답을 근거로 삼을 때 그 답이 추론이었다면 네 주장도 inference로 표시한다.`;
}

export function sourceReviewPrompt(question: string, claims: Claim[]): string {
  const sources = new Map<string, { title: string; quote: string | null; fetched: boolean }>();
  for (const c of claims) {
    for (const s of c.sources) if (!sources.has(s.url)) sources.set(s.url, { title: s.title, quote: s.quote, fetched: s.fetched });
  }
  const list = [...sources.entries()]
    .map(([url, s]) => `- ${s.title}\n  ${url}\n  근거 구절: ${s.quote ?? "(없음)"}${s.fetched ? "" : " [리서처가 페이지를 직접 열지 못함]"}`)
    .join("\n");
  return `연구 질문: ${question}

리서처들이 모은 출처 목록이다. 리서처의 결론은 일부러 보여 주지 않는다.
1단계: 결론에 끌려가지 않도록, 근거만 먼저 평가한다.
- 출처마다 신뢰도(reliability)와 이유(note)를 쓴다. 필요하면 웹 검색으로 확인한다.
- 이 근거들만 보고 네가 내리는 해석을 independentReading에 쓴다.

${list || "(출처 없음)"}`;
}

export function critiquePrompt(claims: Claim[], review: SourceReview): string {
  const list = claims
    .map((c) => `- [${c.id}] (${c.author}, ${c.kind}, 확신 ${c.confidence}) ${c.statement}${c.reasoning ? `\n  추론: ${c.reasoning}` : ""}`)
    .join("\n");
  const reading = review.independentReading.map((r) => `- ${r}`).join("\n");
  return `2단계: 이제 리서처들의 주장을 보여 준다. 1단계에서 네가 근거만 보고 내린 해석과 비교해라.

네 1단계 해석:
${reading || "- (없음)"}

리서처 주장:
${list}

할 일:
- 주장에 대한 반론(challenges)을 쓴다. 어느 주장 ID를 겨냥하는지 claimIds에 쓴다.
- 이 연구의 결론이 틀리게 되는 조건(conditionsWhereWrong)을 쓴다.
- 빠진 관점(missingPerspectives)을 쓴다.`;
}

export function editPrompt(input: {
  question: string;
  hypothesis: string | null;
  brief: Brief;
  claims: Claim[];
  openQuestions: string[];
  review: SourceReview;
  critique: Critique;
}): string {
  const claims = input.claims
    .map((c) => `- [${c.id}] (${c.author}, ${c.kind}, 확신 ${c.confidence}) ${c.statement}`)
    .join("\n");
  const challenges = input.critique.challenges
    .map((c, i) => `${i + 1}. [${c.severity}] (${c.type}, 대상 ${c.claimIds.join(", ") || "전체"}) ${c.argument}${c.wouldChangeConclusion ? " — 결론을 바꿀 수 있음" : ""}`)
    .join("\n");
  const unreliable = input.review.sources
    .filter((s) => s.reliability === "low" || s.reliability === "unverifiable")
    .map((s) => `- ${s.url}: ${s.note}`)
    .join("\n");
  return `연구 질문: ${input.brief.refinedQuestion}
원래 질문: ${input.question}
의뢰인의 사전 가설: ${input.hypothesis ?? "(적지 않음)"} — 가설에 맞추거나 반박하려고 쓰지 말고, 근거대로 쓴다.

주장 목록:
${claims}

리서처들이 남긴 미해결 질문:
${input.openQuestions.map((q) => `- ${q}`).join("\n") || "- 없음"}

레드팀이 신뢰도 낮음·확인 불가로 본 출처:
${unreliable || "- 없음"}

레드팀 반론 (번호 = challengeNo):
${challenges}

레드팀이 본 "결론이 틀리는 조건":
${input.critique.conditionsWhereWrong.map((c) => `- ${c}`).join("\n")}

보고서를 쓴다:
- findings: 핵심 발견. 본문에 근거 주장 ID를 claimIds로 단다.
- disagreements: 리서처끼리, 또는 리서처와 레드팀이 갈린 지점.
- redteamResponses: 반론마다(최소 high 전부) 받아들였는지와 응답.
- actions: 행동 제안. scope는 macro(사회·산업·국가) 또는 personal(개인). 근거 주장 ID를 단다.
- openQuestions: 이 보고서로 답하지 못한 질문.`;
}

export function fixPrompt(errors: string[]): string {
  return `직전에 제출한 출력이 검증을 통과하지 못했다:
${errors.map((e) => `- ${e}`).join("\n")}

내용은 유지하되 위 문제를 고쳐서 같은 스키마로 전체를 다시 제출해라.`;
}
