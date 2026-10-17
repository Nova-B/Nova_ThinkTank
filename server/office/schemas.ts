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
    z.strictObject({ challengeNo: z.number(), accepted: z.boolean(), response: z.string() }),
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
  const answered = new Set(report.redteamResponses.map((r) => r.challengeNo));
  critique.challenges.forEach((c, i) => {
    if (c.severity === "high" && !answered.has(i + 1)) errors.push(`심각도 high인 반론 ${i + 1}번에 응답이 없다`);
  });
  for (const r of report.redteamResponses) {
    if (!Number.isInteger(r.challengeNo) || r.challengeNo < 1 || r.challengeNo > critique.challenges.length) {
      errors.push(`없는 반론 번호: ${r.challengeNo}`);
    }
  }
  return errors;
}
