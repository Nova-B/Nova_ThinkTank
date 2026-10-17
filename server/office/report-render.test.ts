// 보고서에는 웹에서 가져온 글과 AI가 쓴 글이 들어간다. 악의적인 문자열이 HTML을 실행하거나
// Markdown 구조(콜아웃·링크)를 깨지 못하는지 확인한다.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { DEFAULT_ROSTER } from "./roster.js";
import { renderReport } from "./report.js";
import { renderReportHtml, REPORT_CSP } from "./report-html.js";
import type { ReportInput } from "./report-model.js";

const EVIL = `"><script>alert(1)</script><img src=x onerror=alert(2)>`;
const BREAKOUT = "첫 줄\n## 콜아웃 밖으로 나간 제목\n> [!danger] 가짜 콜아웃";

function input(): ReportInput {
  return {
    study: { id: "s1", question: EVIL, hypothesis: BREAKOUT, created_at: "2026-10-17T00:00:00Z", reflection: null } as never,
    roster: DEFAULT_ROSTER,
    brief: { readable: true, unreadableReason: null, refinedQuestion: EVIL, framing: BREAKOUT, assignments: [], outOfScope: [] },
    claims: [
      {
        id: "A1",
        author: "리서처 A",
        subquestionId: "Q1",
        statement: `${EVIL} ${BREAKOUT}`,
        kind: "evidence",
        confidence: "high",
        sources: [
          { title: "제목](https://evil.example)[x", url: "javascript:alert(3)", publisher: null, publishedAt: null, accessedAt: "2026-10-17", quote: EVIL, fetched: true },
          { title: "정상 출처", url: "https://example.com/a (b)", publisher: null, publishedAt: null, accessedAt: "2026-10-17", quote: null, fetched: true },
        ],
        reasoning: null,
      },
    ],
    review: { sources: [], independentReading: [] },
    critique: {
      challenges: [{ claimIds: ["A1"], type: "overreach", argument: BREAKOUT, severity: "high", wouldChangeConclusion: true }],
      conditionsWhereWrong: [BREAKOUT],
      missingPerspectives: [],
    },
    draft: {
      title: EVIL,
      findings: [{ heading: EVIL, body: "본문", claimIds: ["A1"] }],
      disagreements: [{ topic: BREAKOUT, positions: [{ holder: EVIL, view: BREAKOUT }], status: "unresolved" }],
      redteamResponses: [{ challengeNo: 1, verdict: "unresolved", response: BREAKOUT, resolveBy: BREAKOUT }],
      actions: [{ scope: "personal", action: EVIL, rationale: BREAKOUT, horizon: "now", claimIds: ["A1"] }],
      openQuestions: [BREAKOUT],
    },
    researcherQuestions: [],
    rebuttals: [
      {
        who: "리서처 A",
        rebuttal: {
          responses: [
            {
              challengeNo: 1,
              stance: "reject",
              argument: BREAKOUT,
              evidence: [{ title: "]](javascript:alert(4))", url: "https://example.com/ok", quote: null }],
              revisedClaim: BREAKOUT,
            },
          ],
        },
      },
    ],
    counter: { replies: [] },
  };
}

test("HTML: AI 글의 태그는 실행되지 않고, javascript: 주소는 링크가 되지 않는다", () => {
  const html = renderReportHtml(input());
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!/href="javascript:/i.test(html));
  // 속성 안의 따옴표도 이스케이프된다(title에 들어가는 주장 문장)
  assert.ok(!html.includes(`title=""><script>`));
  // 스크립트 태그는 우리 것 하나뿐
  assert.equal((html.match(/<script>/g) ?? []).length, 1);
});

test("HTML: 문서 안의 CSP가 고정 스크립트의 해시만 허용한다", () => {
  const html = renderReportHtml(input());
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`));
  assert.ok(!REPORT_CSP.includes("unsafe-inline'; script") && !/script-src[^;]*unsafe-inline/.test(REPORT_CSP));
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  const hash = `sha256-${createHash("sha256").update(script).digest("base64")}`;
  assert.ok(REPORT_CSP.includes(`'${hash}'`), "실제 스크립트 내용의 해시가 CSP와 일치");
  // 진짜 태그(이스케이프되지 않은 <...>) 안에 이벤트 핸들러 속성이 없다. 이스케이프된 글 속의 "onerror="는 그냥 글자다
  assert.ok(!/<[a-z][^>]*\son[a-z]+\s*=/i.test(html), "인라인 이벤트 핸들러가 없다");
});

test("Markdown: 여러 줄 AI 글이 콜아웃 밖으로 나가 제목·가짜 콜아웃을 만들지 못한다", () => {
  const md = renderReport(input());
  assert.ok(!md.includes("\n## 콜아웃 밖으로 나간 제목"));
  assert.ok(!md.includes("\n> [!danger]"));
  // 접힌 반론 콜아웃 다음 줄들은 모두 "> "로 시작한다
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.startsWith("> [!question]- 반론 1"));
  assert.ok(start > 0);
  for (let i = start + 1; lines[i] !== ""; i++) assert.ok(lines[i]!.startsWith(">"), `콜아웃 안: ${lines[i]}`);
});

test("Markdown: 링크 제목은 구조를 깨지 못하고, http(s)만 링크가 된다", () => {
  const md = renderReport(input());
  const linkLines = md.split("\n").filter((l) => /javascript|example\.com/.test(l));
  const show = linkLines.join("\n");
  // 이스케이프된 "\](" 는 링크 끝이 아니라 글자다. 이스케이프되지 않은 "](javascript:" 만 위험하다
  assert.ok(!/(?<!\\)\]\(javascript:/.test(md), `javascript 링크가 생겼다:\n${show}`);
  assert.ok(!md.includes("(javascript:alert(3))"), `javascript 주소가 링크로 들어갔다:\n${show}`);
  assert.ok(md.includes("\\]\\](javascript:alert(4))"), `제목의 대괄호는 이스케이프:\n${show}`);
  assert.ok(md.includes("(https://example.com/a%20%28b%29)"), `주소의 공백·괄호는 인코딩:\n${show}`);
});
