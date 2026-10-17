import assert from "node:assert/strict";
import { test } from "node:test";
import type { Employee, EventMessage, OfficeEvent } from "../types";
import { initialState, reduce } from "./state";

const roster: Employee[] = [
  { id: "researcher-a", label: "리서처 A", role: "researcher", engine: "claude" },
  { id: "researcher-b", label: "리서처 B", role: "researcher", engine: "codex" },
];
let seq = 0;
const msg = (employeeId: string | null, event: OfficeEvent, id = ++seq): EventMessage => ({
  type: "event",
  id,
  studyId: "s",
  employeeId,
  event,
});

test("턴 시작 → 도구 호출 → 마침 순서로 직원 상태가 바뀐다", () => {
  let s = initialState(roster);
  s = reduce(s, msg("researcher-a", { kind: "turn_started", step: "research:researcher-a", attempt: 1 }));
  assert.equal(s.employees["researcher-a"]!.status, "working");
  assert.equal(s.employees["researcher-a"]!.activity?.text, "조사하는 중");
  s = reduce(s, msg("researcher-a", { kind: "tool_call", tool: "WebSearch", detail: "IEA 2026" }));
  assert.deepEqual(
    { kind: s.employees["researcher-a"]!.activity?.kind, text: s.employees["researcher-a"]!.activity?.text },
    { kind: "search", text: "IEA 2026" },
  );
  s = reduce(s, msg("researcher-a", { kind: "turn_finished", step: "research:researcher-a", status: "succeeded", error: null, durationMs: 81_000 }));
  assert.equal(s.employees["researcher-a"]!.status, "done");
  assert.equal(s.employees["researcher-a"]!.toolCalls, 1);
  assert.equal(s.feed.at(-1)!.text, "조사 마침 (81초)");
});

test("이미 본 이벤트 ID는 다시 적용하지 않는다 (기록과 실시간 스트림이 겹칠 때)", () => {
  let s = initialState(roster);
  const m = msg("researcher-a", { kind: "tool_call", tool: "web_search", detail: "q" });
  s = reduce(s, m);
  const again = reduce(s, m);
  assert.equal(again, s);
  assert.equal(again.employees["researcher-a"]!.toolCalls, 1);
});

test("동료에게 질문하면 걸어가기가 생긴다", () => {
  let s = initialState(roster);
  s = reduce(s, msg("researcher-b", { kind: "tool_call", tool: "office/ask_colleague", detail: "전력 수요는?", target: "researcher-a" }), 1000);
  assert.deepEqual(s.walks.map((w) => [w.from, w.to]), [["researcher-b", "researcher-a"]]);
});

test("단계가 바뀌면 직전 단계와 바뀐 시각을 기억한다 (회의 테이블 이동용)", () => {
  let s = initialState(roster);
  s = reduce(s, msg(null, { kind: "stage", stage: "redteam" }), 1000);
  s = reduce(s, msg(null, { kind: "stage", stage: "rebuttal" }), 2000);
  assert.equal(s.prevStage, "redteam");
  assert.equal(s.stage, "rebuttal");
  assert.equal(s.stageAt, 2000);
});

test("한도에 걸리면 waiting, 단계·한도 정보가 반영된다", () => {
  let s = initialState(roster);
  s = reduce(s, msg(null, { kind: "stage", stage: "redteam" }));
  s = reduce(s, msg("researcher-a", { kind: "rate_limit", status: "allowed", fiveHour: 0.3, sevenDay: 0.5 }));
  s = reduce(s, msg("researcher-a", { kind: "turn_finished", step: "edit", status: "rate_limited", error: "limit", durationMs: 1 }));
  assert.equal(s.stage, "redteam");
  assert.equal(s.rate?.fiveHour, 0.3);
  assert.equal(s.employees["researcher-a"]!.status, "waiting");
});
