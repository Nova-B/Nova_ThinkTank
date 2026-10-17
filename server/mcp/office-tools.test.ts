import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../store/store.js";
import { OfficeTools } from "./office-tools.js";

function setup(turnKind = "research", employeeId = "researcher-a") {
  const store = new Store(":memory:");
  const study = store.createStudy({
    question: "q",
    hypothesis: null,
    employees: [
      { id: "researcher-a", role: "researcher", engine: "claude" },
      { id: "researcher-b", role: "researcher", engine: "codex" },
      { id: "editor", role: "editor", engine: "claude" },
    ],
  });
  // 실제로는 오케스트레이터가 턴을 연 뒤 그 ID를 MCP 서버 환경변수로 넘긴다
  const turnId = employeeId === "stranger" ? null : store.startTurn(study.id, employeeId, "research").id;
  const tools = new OfficeTools(store, { studyId: study.id, employeeId, turnId, turnKind, maxAsks: 2 });
  return { store, tools, studyId: study.id, turnId };
}

test("동료 리서처에게만 질문할 수 있다", () => {
  const { tools } = setup();
  assert.deepEqual(tools.colleagues(), ["researcher-b"]);
  assert.equal(tools.askColleague("researcher-b", "근거가 뭐야?").ok, true);
  assert.equal(tools.askColleague("editor", "x").ok, false, "리서처가 아닌 직원");
  assert.equal(tools.askColleague("researcher-a", "x").ok, false, "자기 자신");
  assert.equal(tools.askColleague("researcher-b", "   ").ok, false, "빈 질문");
});

test("research 턴이 아니면 질문할 수 없다 (깊이 1)", () => {
  const { tools } = setup("answer");
  assert.equal(tools.askColleague("researcher-b", "x").ok, false);
});

test("연구 명단에 없는 직원은 아무 도구도 못 쓴다", () => {
  const { tools } = setup("research", "stranger");
  assert.equal(tools.askColleague("researcher-b", "x").ok, false);
  assert.equal(tools.checkAnswers().ok, false);
});

test("끝난 턴의 MCP 프로세스는 더 이상 질문할 수 없다", () => {
  const { store, tools, turnId } = setup();
  store.finishTurn(turnId!, { status: "succeeded", sessionId: null, error: null, exitCode: 0 });
  assert.equal(tools.askColleague("researcher-b", "x").ok, false);
});

test("상한을 넘으면 거부하고, 답은 check_answers로 보인다", () => {
  const { store, tools, studyId } = setup();
  tools.askColleague("researcher-b", "1");
  tools.askColleague("researcher-b", "2");
  const third = tools.askColleague("researcher-b", "3");
  assert.equal(third.ok, false);
  const [ask] = store.claimAsks(studyId, 1000, "run");
  store.answerAsk(ask!.id, "답이다", "run");
  assert.match(tools.checkAnswers().text, /답이다/);
});
