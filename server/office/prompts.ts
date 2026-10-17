import type { Employee } from "./roster.js";
import type { Brief, Claim, Counter, Critique, Rebuttal, SourceReview } from "./schemas.js";

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
- 레드팀 반론마다, 리서처의 재반박과 레드팀의 마지막 답까지 보고 판정한다(upheld / overturned / unresolved).`,
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
0. 질문의 글자가 깨졌거나 무엇을 묻는지 알 수 없으면, 추측해서 질문을 만들지 말고 readable=false와 이유를 낸다.
   (나머지 필드는 비워 둔다.) 의뢰인이 묻지 않은 질문을 연구하는 것이 가장 나쁜 결과다.
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

// 재반박 규칙. 모델은 반박을 받으면 맞는 답도 쉽게 내려놓는다(아첨, Sharma et al. 2023).
// 그래서 "동의가 기본값이 아니다"와 "입장을 바꾸려면 바꾸게 만든 근거를 대라"를 명시한다.
const NO_SYCOPHANCY = `- 반론에 동의하는 것이 기본값이 아니다. 반론이 맞으면 수용하고, 틀렸으면 근거를 들어 거부한다.
- "다시 생각해 보니 맞다"만으로 입장을 바꾸지 않는다. 입장을 바꾼다면 무엇이 바꾸게 했는지(근거)를 쓴다.
- 확인하지 못한 것은 확인하지 못했다고 쓴다.`;

function challengeLine(c: Critique["challenges"][number], no: number): string {
  return `${no}. [${c.severity}] (${c.type}, 대상 ${c.claimIds.join(", ") || "전체"}) ${c.argument}${c.wouldChangeConclusion ? " — 결론을 바꿀 수 있음" : ""}`;
}

export function rebuttalPrompt(mine: Claim[], all: Claim[], critique: Critique, assigned: number[]): string {
  const mineIds = new Set(mine.map((c) => c.id));
  // 두 리서처의 주장을 함께 겨냥한 반론이면, 동료 주장도 보여 줘야 둘 사이의 모순을 검토할 수 있다
  const others = all.filter(
    (c) => !mineIds.has(c.id) && assigned.some((no) => critique.challenges[no - 1]?.claimIds.includes(c.id)),
  );
  const claims = mine
    .map((c) => {
      const src = c.sources.map((s) => `    - ${s.title} <${s.url}>${s.quote ? ` "${s.quote}"` : ""}`).join("\n");
      return `- [${c.id}] (${c.kind}, 확신 ${c.confidence}) ${c.statement}${src ? `\n${src}` : ""}`;
    })
    .join("\n");
  const list = assigned.map((no) => challengeLine(critique.challenges[no - 1]!, no)).join("\n");
  return `레드팀이 네 주장에 반론을 냈다. 반론마다 재반박을 쓴다.

${NO_SYCOPHANCY}
- 필요하면 웹 검색으로 근거를 다시 확인한다.
- stance: accept(반론이 맞다) / partial(일부만 맞다) / reject(반론이 틀렸다). reject에는 출처가 하나 이상 있어야 한다.
- 주장을 고치게 되면 revisedClaim에 고친 문장을 쓴다.

네 주장과 출처:
${claims}

${others.length ? `반론이 함께 겨냥한 동료의 주장(참고, 네가 답할 대상은 아니다):\n${others.map((c) => `- [${c.id}] (${c.author}) ${c.statement}`).join("\n")}\n\n` : ""}네가 답할 반론 (번호 = challengeNo, "대상 전체"는 연구 전체를 겨냥한 반론):
${list}`;
}

export function counterPrompt(critique: Critique, eligible: number[], rebuttals: { who: string; rebuttal: Rebuttal }[]): string {
  const blocks = eligible
    .map((no) => {
      const answers = rebuttals
        .flatMap(({ who, rebuttal }) => rebuttal.responses.filter((r) => r.challengeNo === no).map((r) => ({ who, r })))
        .map(({ who, r }) => `   - ${who}: ${STANCE[r.stance]} — ${r.argument}${r.evidence.length ? `\n     근거: ${r.evidence.map((e) => `${e.title} <${e.url}>`).join("; ")}` : ""}`)
        .join("\n");
      return `${challengeLine(critique.challenges[no - 1]!, no)}\n${answers}`;
    })
    .join("\n\n");
  return `네 핵심 반론 가운데 리서처가 받아들이지 않은 것들이다. 각 반론에 마지막으로 답한다. 이번이 마지막 발언이다.

${NO_SYCOPHANCY.replaceAll("반론에 동의", "재반박에 동의")}
- verdict: concede(리서처의 재반박이 맞다) / maintain(반론을 유지한다).

${blocks}`;
}

const STANCE = { accept: "수용", partial: "부분 수용", reject: "거부" } as const;

export function editPrompt(input: {
  question: string;
  hypothesis: string | null;
  brief: Brief;
  claims: Claim[];
  openQuestions: string[];
  review: SourceReview;
  critique: Critique;
  rebuttals: { who: string; rebuttal: Rebuttal }[];
  counter: Counter;
}): string {
  const claims = input.claims
    .map((c) => `- [${c.id}] (${c.author}, ${c.kind}, 확신 ${c.confidence}) ${c.statement}`)
    .join("\n");
  // 반론마다 재반박과 마지막 답을 한데 모아 보여 준다
  const challenges = input.critique.challenges
    .map((c, i) => {
      const no = i + 1;
      const answers = input.rebuttals
        .flatMap(({ who, rebuttal }) => rebuttal.responses.filter((r) => r.challengeNo === no).map((r) => ({ who, r })))
        .map(({ who, r }) =>
          [
            `   - 재반박 ${who}: ${STANCE[r.stance]} — ${r.argument}`,
            ...(r.evidence.length ? r.evidence.map((e) => `     근거: ${e.title} <${e.url}>${e.quote ? ` "${e.quote}"` : ""}`) : ["     근거: 없음"]),
            ...(r.revisedClaim ? [`     고친 주장: ${r.revisedClaim}`] : []),
          ].join("\n"),
        );
      const last = input.counter.replies.find((r) => r.challengeNo === no);
      const counter = last
        ? [
            `   - 레드팀 마지막 답: ${last.verdict === "concede" ? "재반박 인정" : "반론 유지"} — ${last.argument}`,
            ...last.evidence.map((e) => `     근거: ${e.title} <${e.url}>${e.quote ? ` "${e.quote}"` : ""}`),
          ]
        : [];
      return [challengeLine(c, no), ...(answers.length ? answers : ["   - (재반박 없음)"]), ...counter].join("\n");
    })
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

레드팀 반론과 재반박 (번호 = challengeNo):
${challenges}

레드팀이 본 "결론이 틀리는 조건":
${input.critique.conditionsWhereWrong.map((c) => `- ${c}`).join("\n")}

보고서를 쓴다:
- findings: 핵심 발견. 본문에 근거 주장 ID를 claimIds로 단다.
- disagreements: 리서처끼리, 또는 리서처와 레드팀이 갈린 지점.
- redteamResponses: 모든 반론에 판정한다.
  - upheld: 반론이 맞다 / overturned: 리서처의 재반박이 맞다 / unresolved: 근거가 맞서거나 어느 쪽도 확인할 수 없다.
  - 판정 기준은 근거의 질이다. 누가 마지막에 말했는지, 누가 더 길게 말했는지가 아니다.
  - 모든 반론을 upheld로 두는 것이 기본값이 아니다. 근거가 맞서면 unresolved가 정당한 판정이다.
  - 근거 없이 입장을 바꾼 쪽의 말은 가볍게 본다.
  - unresolved면 resolveBy에 무엇이 확인되면 풀리는지 쓴다. 다른 판정이면 resolveBy는 null.
- 리서처가 주장을 고쳤으면(고친 주장) findings·actions에는 고친 주장을 바탕으로 쓴다. 반론이 유지된 주장을 결론의 근거로 쓰지 않는다.
- actions: 행동 제안. scope는 macro(사회·산업·국가) 또는 personal(개인). 근거 주장 ID를 단다.
- openQuestions: 이 보고서로 답하지 못한 질문.`;
}

export function fixPrompt(errors: string[]): string {
  return `직전에 제출한 출력이 검증을 통과하지 못했다:
${errors.map((e) => `- ${e}`).join("\n")}

내용은 유지하되 위 문제를 고쳐서 같은 스키마로 전체를 다시 제출해라.`;
}
