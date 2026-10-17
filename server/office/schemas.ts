import { z } from "zod";

// CLI에 넘기는 JSON Schema는 OpenAI strict 모드 제약(모든 필드 required, additionalProperties false)을
// 지켜야 해서 z.strictObject와 nullable만 쓴다. optional은 쓰지 않는다.

export const BriefSchema = z.strictObject({
  readable: z.boolean().describe("질문을 온전히 읽고 이해했으면 true. 글자가 깨졌거나 무엇을 묻는지 알 수 없으면 false"),
  unreadableReason: z.string().nullable().describe("readable=false일 때 무엇이 문제인지. 아니면 null"),
  refinedQuestion: z.string().describe("연구할 질문을 한 문장으로 다듬은 것"),
  framing: z.string().describe("왜 중요한지, 어디까지 다룰지"),
  assignments: z.array(
    z.strictObject({
      researcherId: z.string(),
      lens: z.string().describe("이 리서처가 맡을 관점"),
      subquestions: z.array(z.strictObject({ id: z.string(), question: z.string() })),
    }),
  ),
  outOfScope: z.array(z.string()),
});
export type Brief = z.infer<typeof BriefSchema>;

const SourceSchema = z.strictObject({
  title: z.string(),
  url: z.string(),
  publisher: z.string().nullable(),
  publishedAt: z.string().nullable().describe("발행일. 모르면 null"),
  accessedAt: z.string().describe("확인한 날짜 YYYY-MM-DD"),
  quote: z.string().nullable().describe("근거가 되는 구절(원문 그대로, 짧게). 페이지를 못 열었으면 null"),
  fetched: z.boolean().describe("페이지 본문을 실제로 열어 확인했으면 true, 검색 요약만 봤으면 false"),
});

export const ResearchMemoSchema = z.strictObject({
  claims: z.array(
    z.strictObject({
      subquestionId: z.string(),
      statement: z.string(),
      kind: z.enum(["evidence", "inference"]).describe("evidence=출처로 뒷받침, inference=직원의 추론"),
      confidence: z.enum(["low", "medium", "high"]),
      sources: z.array(SourceSchema),
      reasoning: z.string().nullable().describe("추론이면 그 근거가 된 논리"),
    }),
  ),
  openQuestions: z.array(z.string()),
});
export type ResearchMemo = z.infer<typeof ResearchMemoSchema>;
export type Claim = ResearchMemo["claims"][number] & { id: string; author: string };

export const AskAnswerSchema = z.strictObject({
  answer: z.string(),
  basis: z.enum(["evidence", "inference"]),
  sources: z.array(z.strictObject({ title: z.string(), url: z.string() })),
});
export type AskAnswer = z.infer<typeof AskAnswerSchema>;

export const SourceReviewSchema = z.strictObject({
  sources: z.array(
    z.strictObject({
      url: z.string(),
      reliability: z.enum(["high", "medium", "low", "unverifiable"]),
      note: z.string(),
    }),
  ),
  independentReading: z.array(z.string()).describe("주장 초안을 보기 전에, 근거만 보고 내린 자기 해석"),
});
export type SourceReview = z.infer<typeof SourceReviewSchema>;

export const CritiqueSchema = z.strictObject({
  challenges: z.array(
    z.strictObject({
      claimIds: z.array(z.string()),
      type: z.enum(["evidence_gap", "overreach", "bias", "contradiction", "missing_perspective", "outdated"]),
      argument: z.string(),
      severity: z.enum(["low", "medium", "high"]),
      wouldChangeConclusion: z.boolean(),
    }),
  ),
  conditionsWhereWrong: z.array(z.string()).describe("이 연구의 결론이 틀리게 되는 조건"),
  missingPerspectives: z.array(z.string()),
});
export type Critique = z.infer<typeof CritiqueSchema>;

const EvidenceSchema = z.strictObject({
  title: z.string(),
  url: z.string(),
  quote: z.string().nullable().describe("근거 구절(원문 그대로, 짧게). 없으면 null"),
});

/** 리서처의 재반박. 반론마다 수용/부분 수용/거부 중 하나와 그 근거 */
export const RebuttalSchema = z.strictObject({
  responses: z.array(
    z.strictObject({
      challengeNo: z.number(),
      stance: z.enum(["accept", "partial", "reject"]).describe("accept=반론이 맞다, partial=일부만 맞다, reject=반론이 틀렸다"),
      argument: z.string().describe("왜 그렇게 판단했는지. 입장을 바꾸면 바꾸게 만든 근거를 쓴다"),
      evidence: z.array(EvidenceSchema).describe("판단의 근거 출처. reject면 1개 이상 필수"),
      revisedClaim: z.string().nullable().describe("수용·부분 수용으로 주장을 고치면 고친 문장. 아니면 null"),
    }),
  ),
});
export type Rebuttal = z.infer<typeof RebuttalSchema>;

/** 조건부 2라운드: 리서처가 버틴 핵심 반론에 대한 레드팀의 마지막 답 */
export const CounterSchema = z.strictObject({
  replies: z.array(
    z.strictObject({
      challengeNo: z.number(),
      verdict: z.enum(["concede", "maintain"]).describe("concede=리서처의 재반박이 맞다, maintain=반론을 유지한다"),
      argument: z.string(),
      evidence: z.array(EvidenceSchema),
    }),
  ),
});
export type Counter = z.infer<typeof CounterSchema>;

export const ReportDraftSchema = z.strictObject({
  title: z.string(),
  findings: z.array(z.strictObject({ heading: z.string(), body: z.string(), claimIds: z.array(z.string()) })),
  disagreements: z.array(
    z.strictObject({
      topic: z.string(),
      positions: z.array(z.strictObject({ holder: z.string(), view: z.string() })),
      status: z.enum(["unresolved", "partially_resolved", "resolved"]),
    }),
  ),
  redteamResponses: z.array(
    // int()는 OpenAI strict 모드가 받지 않는 minimum/maximum을 만든다 → 정수 여부는 서버 검증에서 본다
    z.strictObject({
      challengeNo: z.number(),
      verdict: z
        .enum(["upheld", "overturned", "unresolved"])
        .describe("upheld=반론이 맞다, overturned=리서처의 재반박이 맞다, unresolved=근거가 맞서거나 확인할 수 없다"),
      response: z.string().describe("판정 이유. 어느 쪽 근거가 왜 더 나은지"),
      resolveBy: z
        .string()
        .nullable()
        .describe("unresolved일 때: 무엇이 확인되면 풀리는지(필요한 자료·조건). 다른 판정이면 null"),
    }),
  ),
  actions: z.array(
    z.strictObject({
      scope: z.enum(["macro", "personal"]).describe("macro=사회·산업·국가 차원, personal=개인 차원"),
      action: z.string(),
      rationale: z.string(),
      horizon: z.enum(["now", "1-3y", "3-10y"]),
      claimIds: z.array(z.string()),
    }),
  ),
  openQuestions: z.array(z.string()),
});
export type ReportDraft = z.infer<typeof ReportDraftSchema>;

export function jsonSchemaOf(schema: z.ZodType): object {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

// ── 서버 검증: 스키마가 잡지 못하는 참조 무결성 ───────────────────────

export function validateBrief(brief: Brief, researcherIds: string[]): string[] {
  // 읽을 수 없다는 판단은 고쳐 받을 대상이 아니라 멈출 사유다(오케스트레이터가 처리)
  if (brief.readable === false) return [];
  const errors: string[] = [];
  const assigned = brief.assignments.map((a) => a.researcherId);
  for (const id of assigned) if (!researcherIds.includes(id)) errors.push(`없는 리서처: ${id}`);
  for (const id of researcherIds) if (!assigned.includes(id)) errors.push(`${id}에게 배정이 없다`);
  if (new Set(assigned).size !== assigned.length) errors.push("한 리서처가 두 번 배정됐다");
  const qids = brief.assignments.flatMap((a) => a.subquestions.map((q) => q.id));
  if (new Set(qids).size !== qids.length) errors.push("하위 질문 id가 겹친다");
  for (const a of brief.assignments) {
    if (a.subquestions.length < 1 || a.subquestions.length > 4) errors.push(`${a.researcherId}의 하위 질문은 1~4개여야 한다`);
  }
  return errors;
}

export function validateMemo(memo: ResearchMemo, subquestionIds: string[]): string[] {
  const errors: string[] = [];
  if (memo.claims.length === 0) errors.push("주장이 하나도 없다");
  memo.claims.forEach((c, i) => {
    if (!subquestionIds.includes(c.subquestionId)) errors.push(`claims[${i}]: 배정되지 않은 하위 질문 ${c.subquestionId}`);
    if (c.kind === "evidence" && c.sources.length === 0) errors.push(`claims[${i}]: evidence인데 출처가 없다`);
    if (c.kind === "inference" && !c.reasoning) errors.push(`claims[${i}]: inference인데 reasoning이 없다`);
    c.sources.forEach((s, j) => {
      if (!/^https?:\/\//.test(s.url)) errors.push(`claims[${i}].sources[${j}]: URL 형식이 아니다`);
    });
  });
  return errors;
}

/** 레드팀 1단계는 넘겨받은 출처를 빠짐없이 평가해야 한다(원자료 먼저 원칙을 형식만 지키는 것을 막는다) */
export function validateSourceReview(review: SourceReview, urls: string[]): string[] {
  const reviewed = new Set(review.sources.map((s) => s.url));
  const missing = urls.filter((u) => !reviewed.has(u));
  const errors = missing.slice(0, 10).map((u) => `평가하지 않은 출처: ${u}`);
  if (missing.length > 10) errors.push(`그 밖에 ${missing.length - 10}개 더`);
  if (review.independentReading.length === 0) errors.push("근거만 보고 내린 해석(independentReading)이 없다");
  return errors;
}

export function validateCritique(critique: Critique, claimIds: string[]): string[] {
  const errors: string[] = [];
  if (critique.challenges.length === 0) errors.push("반론이 하나도 없다");
  critique.challenges.forEach((c, i) => {
    for (const id of c.claimIds) if (!claimIds.includes(id)) errors.push(`challenges[${i}]: 없는 주장 ${id}`);
  });
  if (critique.conditionsWhereWrong.length === 0) errors.push("결론이 틀리는 조건을 하나 이상 써야 한다");
  return errors;
}

const isUrl = (u: string) => /^https?:\/\//.test(u);

/** 맡은 반론마다 정확히 한 번 답했는지, 거부에는 출처가 있는지 */
export function validateRebuttal(rebuttal: Rebuttal, assigned: number[]): string[] {
  const errors: string[] = [];
  const seen = rebuttal.responses.map((r) => r.challengeNo);
  for (const no of assigned) if (!seen.includes(no)) errors.push(`반론 ${no}번에 답하지 않았다`);
  for (const no of seen) if (!assigned.includes(no)) errors.push(`맡지 않은 반론 번호: ${no}`);
  if (new Set(seen).size !== seen.length) errors.push("같은 반론에 두 번 답했다");
  rebuttal.responses.forEach((r) => {
    if (!r.argument.trim()) errors.push(`반론 ${r.challengeNo}번: 이유(argument)가 비어 있다`);
    if (r.stance === "reject" && !r.evidence.some((e) => isUrl(e.url))) {
      errors.push(`반론 ${r.challengeNo}번: 거부하려면 출처(URL)가 하나 이상 필요하다`);
    }
    if (r.stance === "partial" && !r.revisedClaim && !r.evidence.length) {
      errors.push(`반론 ${r.challengeNo}번: 부분 수용이면 고친 주장이나 근거가 필요하다`);
    }
  });
  return errors;
}

export function validateCounter(counter: Counter, eligible: number[]): string[] {
  const errors: string[] = [];
  const seen = counter.replies.map((r) => r.challengeNo);
  for (const no of eligible) if (!seen.includes(no)) errors.push(`반론 ${no}번에 답하지 않았다`);
  for (const no of seen) if (!eligible.includes(no)) errors.push(`이번 라운드 대상이 아닌 반론: ${no}`);
  if (new Set(seen).size !== seen.length) errors.push("같은 반론에 두 번 답했다");
  counter.replies.forEach((r) => {
    if (!r.argument.trim()) errors.push(`반론 ${r.challengeNo}번: 이유가 비어 있다`);
  });
  return errors;
}

export function validateReport(report: ReportDraft, claimIds: string[], critique: Critique): string[] {
  const errors: string[] = [];
  const refs = [...report.findings.flatMap((f) => f.claimIds), ...report.actions.flatMap((a) => a.claimIds)];
  for (const id of new Set(refs)) if (!claimIds.includes(id)) errors.push(`없는 주장 인용: ${id}`);
  report.findings.forEach((f, i) => {
    if (!f.claimIds.length) errors.push(`findings[${i}]: 근거 주장 ID가 없다`);
  });
  report.actions.forEach((a, i) => {
    if (!a.claimIds.length) errors.push(`actions[${i}]: 근거 주장 ID가 없다`);
  });
  if (report.findings.length === 0) errors.push("핵심 발견이 없다");
  if (report.actions.length === 0) errors.push("행동 제안이 없다");
  if (report.openQuestions.length === 0) errors.push("미해결 질문이 없다");
  // 재반박을 거친 뒤라 모든 반론에 판정이 있어야 한다(심각도와 상관없이)
  const answered = new Set(report.redteamResponses.map((r) => r.challengeNo));
  critique.challenges.forEach((_c, i) => {
    if (!answered.has(i + 1)) errors.push(`반론 ${i + 1}번에 판정이 없다`);
  });
  if (answered.size !== report.redteamResponses.length) errors.push("같은 반론에 판정이 두 번 있다");
  // 미해결은 판단 회피로 쓰이기 쉽다 → 무엇이 확인되면 풀리는지 적게 한다
  for (const r of report.redteamResponses) {
    if (r.verdict === "unresolved" && !r.resolveBy?.trim()) errors.push(`반론 ${r.challengeNo}번: 미해결이면 무엇이 확인되면 풀리는지(resolveBy)를 써야 한다`);
  }
  for (const r of report.redteamResponses) {
    if (!Number.isInteger(r.challengeNo) || r.challengeNo < 1 || r.challengeNo > critique.challenges.length) {
      errors.push(`없는 반론 번호: ${r.challengeNo}`);
    }
  }
  return errors;
}
