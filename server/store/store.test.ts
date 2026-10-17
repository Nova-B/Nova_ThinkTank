import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AskLimitError, Store } from "./store.js";

const dir = mkdtempSync(path.join(tmpdir(), "nova-store-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const require = createRequire(import.meta.url);
const TSX = path.join(path.dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs");
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "create-asks.ts");

function newStore(name: string) {
  const store = new Store(path.join(dir, `${name}.db`));
  const study = store.createStudy({
    question: "q",
    hypothesis: null,
    employees: [
      { id: "a", role: "researcher", engine: "claude" },
      { id: "b", role: "researcher", engine: "codex" },
    ],
  });
  return { store, studyId: study.id };
}

test("질문: 중복은 같은 ID, 상한을 넘으면 거부", () => {
  const { store, studyId } = newStore("dedupe");
  const first = store.createAsk({ studyId, from: "a", to: "b", question: "왜  그런가?", turnId: null, maxPerEmployee: 2 });
  const again = store.createAsk({ studyId, from: "a", to: "b", question: "왜 그런가? ", turnId: null, maxPerEmployee: 2 });
  assert.equal(again.id, first.id);
  assert.equal(again.duplicate, true);
  store.createAsk({ studyId, from: "a", to: "b", question: "둘째", turnId: null, maxPerEmployee: 2 });
  assert.throws(
    () => store.createAsk({ studyId, from: "a", to: "b", question: "셋째", turnId: null, maxPerEmployee: 2 }),
    AskLimitError,
  );
  store.close();
});

test("질문: 임대 중인 것은 다시 가져가지 않고, 만료되면 다시 가져간다", () => {
  const { store, studyId } = newStore("lease");
  store.createAsk({ studyId, from: "a", to: "b", question: "q", turnId: null, maxPerEmployee: 5 });
  const t0 = 1_000_000;
  const [first] = store.claimAsks(studyId, 1000, "run-1", t0);
  assert.ok(first);
  assert.equal(store.claimAsks(studyId, 1000, "run-2", t0 + 500).length, 0);
  const again = store.claimAsks(studyId, 1000, "run-2", t0 + 1500);
  assert.equal(again.length, 1);
  assert.equal(again[0]!.attempts, 2);
  // 임대가 넘어간 뒤 이전 처리자의 늦은 답은 쓰이지 않는다
  assert.equal(store.answerAsk(first.id, "늦은 답", "run-1"), false);
  assert.equal(store.failAsk(again[0]!.id, "x", 2, "run-2"), true);
  assert.equal(store.asksFrom(studyId, "a")[0]!.status, "failed");
  store.close();
});

test("질문: 재시작하면 남은 임대를 만료 전이라도 대기열로 되돌린다", () => {
  const { store, studyId } = newStore("stale");
  store.createAsk({ studyId, from: "a", to: "b", question: "q", turnId: null, maxPerEmployee: 5 });
  store.claimAsks(studyId, 60_000, "dead-run");
  assert.equal(store.openAskCount(studyId), 1);
  assert.equal(store.releaseStaleLeases(studyId), 1);
  const [ask] = store.claimAsks(studyId, 60_000, "new-run");
  assert.ok(ask);
  assert.equal(store.answerAsk(ask.id, "답", "new-run"), true);
  assert.equal(store.openAskCount(studyId), 0);
  store.close();
});

test("질문: 여러 프로세스가 동시에 써도 하나도 잃지 않는다", async () => {
  const { store, studyId } = newStore("concurrent");
  const file = store.file;
  store.close();
  const run = promisify(execFile);
  await Promise.all(["a", "b", "a2", "b2"].map((from) => run(process.execPath, [TSX, FIXTURE, file, studyId, from, "25"])));
  const check = new Store(file);
  const total = (check.db.prepare("SELECT COUNT(*) AS n FROM asks WHERE study_id = ?").get(studyId) as { n: number }).n;
  assert.equal(total, 100);
  check.close();
});

test("턴: 같은 직원은 동시에 두 턴을 시작할 수 없고, 재시작 시 중단 표시", () => {
  const { store, studyId } = newStore("turns");
  const t = store.startTurn(studyId, "a", "research:a");
  assert.throws(() => store.startTurn(studyId, "a", "revise:a"), /실행 중/);
  assert.equal(store.markInterruptedTurns(studyId), 1);
  const next = store.startTurn(studyId, "a", "research:a");
  assert.equal(next.attempt, 2);
  assert.notEqual(next.id, t.id);
  store.close();
});

test("잠금: 살아 있는 다른 프로세스가 잡고 있으면 실패", () => {
  const { store, studyId } = newStore("lock");
  assert.equal(store.acquireLock(studyId, 111, () => true), true);
  assert.equal(store.acquireLock(studyId, 222, () => true), false);
  assert.equal(store.acquireLock(studyId, 111, () => true), false, "같은 프로세스도 두 번 잡지 못한다");
  assert.equal(store.acquireLock(studyId, 222, () => false), true, "죽은 프로세스의 잠금은 넘겨받는다");
  store.close();
});
