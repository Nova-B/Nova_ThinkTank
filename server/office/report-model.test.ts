import assert from "node:assert/strict";
import { test } from "node:test";
import { averageStrength, claimStrength, verdictOf } from "./report-model.js";
import type { Claim } from "./schemas.js";

const claim = (kind: Claim["kind"], confidence: Claim["confidence"]): Claim => ({
  id: "A1",
  author: "리서처 A",
  subquestionId: "Q1",
  statement: "s",
  kind,
  confidence,
  sources: [],
  reasoning: null,
});

test("근거 강도: 출처 기반은 확신도대로, 추론은 1", () => {
  assert.equal(claimStrength(claim("evidence", "high"), []), 3);
  assert.equal(claimStrength(claim("evidence", "medium"), []), 2);
  assert.equal(claimStrength(claim("evidence", "low"), []), 1);
  assert.equal(claimStrength(claim("inference", "high"), []), 1);
});

test("근거 신호: 본문 미확인·주장 수정은 보통까지, 레드팀이 출처를 모두 낮게 보면 약함까지", () => {
  const unfetched = { ...claim("evidence", "high"), sources: [{ title: "t", url: "https://a", publisher: null, publishedAt: null, accessedAt: "d", quote: null, fetched: false }] };
  assert.equal(claimStrength(unfetched, []), 2);
  assert.equal(claimStrength(claim("evidence", "high"), [], { revised: true }), 2);
  const fetched = { ...unfetched, sources: [{ ...unfetched.sources[0]!, fetched: true }] };
  assert.equal(claimStrength(fetched, [], { reliability: () => "low" }), 1);
  assert.equal(claimStrength(fetched, [], { reliability: () => "high" }), 3);
});

test("근거 강도: 심각도 high 반론이 유지되면 1 깎고, 1 밑으로는 내려가지 않는다", () => {
  assert.equal(claimStrength(claim("evidence", "high"), [{ verdict: "upheld", severity: "high" }]), 2);
  assert.equal(claimStrength(claim("evidence", "high"), [{ verdict: "upheld", severity: "medium" }]), 3, "medium 반론은 깎지 않는다");
  assert.equal(claimStrength(claim("evidence", "high"), [{ verdict: "overturned", severity: "high" }]), 3, "재반박이 이기면 깎지 않는다");
  assert.equal(claimStrength(claim("evidence", "high"), [{ verdict: "unresolved", severity: "high" }]), 2, "핵심 반론이 미해결이어도 깎는다");
  assert.equal(claimStrength(claim("inference", "low"), [{ verdict: "upheld", severity: "high" }]), 1);
});

test("발견의 신호는 근거 주장들의 평균을 내림, 근거가 없으면 약함", () => {
  assert.equal(averageStrength([3, 3, 1]), 2);
  assert.equal(averageStrength([3, 2]), 2, "약한 근거가 강한 근거에 묻히지 않게 내림");
  assert.equal(averageStrength([3, 3]), 3);
  assert.equal(averageStrength([]), 1);
});

test("예전(M1a) 판정은 예전 뜻대로 읽는다", () => {
  assert.equal(verdictOf({ accepted: true }), "upheld");
  assert.equal(verdictOf({ accepted: false }), "declined");
  assert.equal(verdictOf({}), "unresolved");
  assert.equal(verdictOf({ verdict: "overturned" }), "overturned");
});

test("제목 번호 지우기와 첫 문장", async () => {
  const { stripNumber, firstSentence } = await import("./report-model.js");
  assert.equal(stripNumber("0. 읽는 법"), "읽는 법");
  assert.equal(stripNumber("3) 보안"), "보안");
  assert.equal(stripNumber("2026년 전망"), "2026년 전망", "숫자로 시작하는 제목은 건드리지 않는다");
  assert.equal(firstSentence("첫 문장이다. 둘째 문장이다."), "첫 문장이다.");
  assert.equal(firstSentence("발전량보다 더 중요하다는 비교. 다음"), "발전량보다 더 중요하다는 비교.", "문장 중간의 다에서 끊지 않는다");
  assert.ok(firstSentence("가".repeat(200)).endsWith("…"));
});

test("여러 주장을 함께 겨냥한 반론의 고친 문장은 주장 문장을 대신하지 않는다", async () => {
  const { buildReportModel } = await import("./report-model.js");
  const base = claim("evidence", "high");
  const claims = [{ ...base, id: "A1" }, { ...base, id: "A2" }, { ...base, id: "A3" }];
  const ch = (claimIds: string[]) => ({ claimIds, type: "overreach" as const, argument: "x", severity: "high" as const, wouldChangeConclusion: true });
  const m = buildReportModel({
    study: { id: "s", question: "q", hypothesis: null, created_at: "2026-10-17T00:00:00Z", reflection: null } as never,
    roster: [],
    brief: { readable: true, unreadableReason: null, refinedQuestion: "r", framing: "f", assignments: [], outOfScope: [] },
    claims,
    review: { sources: [], independentReading: [] },
    critique: { challenges: [ch(["A1"]), ch(["A2", "A3"])], conditionsWhereWrong: [], missingPerspectives: [] },
    draft: { title: "t", findings: [], disagreements: [], redteamResponses: [], actions: [], openQuestions: [] },
    researcherQuestions: [],
    rebuttals: [
      {
        who: "리서처 A",
        rebuttal: {
          responses: [
            { challengeNo: 1, stance: "accept", argument: "a", evidence: [], revisedClaim: "A1 고침" },
            { challengeNo: 2, stance: "partial", argument: "b", evidence: [], revisedClaim: "둘을 묶어 고침" },
          ],
        },
      },
    ],
  });
  const byId = new Map(m.claims.map((c) => [c.id, c]));
  assert.equal(byId.get("A1")!.revised, "A1 고침");
  assert.equal(byId.get("A2")!.revised, null);
  assert.deepEqual(byId.get("A3")!.relatedRevisions, [{ no: 2, text: "둘을 묶어 고침" }]);
});
