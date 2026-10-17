import assert from "node:assert/strict";
import { test } from "node:test";
import { runProcess } from "./process.js";
import { decideOutcome } from "./turn.js";

const node = (code: string, extra: Partial<Parameters<typeof runProcess>[0]> = {}) => {
  const lines: string[] = [];
  return runProcess({
    command: process.execPath,
    args: ["-e", code],
    cwd: process.cwd(),
    stdin: "hello",
    deadlineMs: 10_000,
    maxOutputBytes: 1024 * 1024,
    onLine: (l) => lines.push(l),
    ...extra,
  }).then((r) => ({ ...r, lines }));
};

test("개행 없는 마지막 줄도 읽고 stdin을 전달한다", async () => {
  const r = await node(`process.stdin.on("data", d => process.stdout.write("a\\n" + d.toString()))`);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.lines, ["a", "hello"]);
  assert.equal(r.stopReason, null);
});

test("마감 시간이 지나면 트리째 종료한다", async () => {
  const r = await node(`setInterval(() => {}, 1000)`, { deadlineMs: 300 });
  assert.equal(r.stopReason, "deadline");
  assert.notEqual(r.exitCode, 0);
});

test("출력 상한을 넘으면 종료한다", async () => {
  const r = await node(`setInterval(() => process.stdout.write("x".repeat(4096) + "\\n"), 1)`, { maxOutputBytes: 64 * 1024 });
  assert.equal(r.stopReason, "output_limit");
});

test("AbortSignal로 취소한다", async () => {
  const c = new AbortController();
  setTimeout(() => c.abort(), 200);
  const r = await node(`setInterval(() => {}, 1000)`, { signal: c.signal });
  assert.equal(r.stopReason, "aborted");
});

test("onLine이 던지면 프로세스를 죽이고 오류를 돌려준다 (프로세스 전체가 죽지 않는다)", async () => {
  const r = await runProcess({
    command: process.execPath,
    args: ["-e", "setInterval(() => console.log('x'), 10)"],
    cwd: process.cwd(),
    stdin: "",
    deadlineMs: 10_000,
    maxOutputBytes: 1024 * 1024,
    onLine: () => {
      throw new Error("db locked");
    },
  });
  assert.equal(r.stopReason, "handler_error");
  assert.equal(r.handlerError?.message, "db locked");
  assert.equal(decideOutcome({ exitCode: r.exitCode, stopReason: r.stopReason, handlerError: r.handlerError, events: [] }).status, "failed");
});

test("판정: 종료 코드·오류·최종 출력이 모두 맞아야 성공", () => {
  const final = { kind: "final", output: {} } as const;
  assert.equal(decideOutcome({ exitCode: 0, stopReason: null, events: [final] }).status, "succeeded");
  assert.equal(decideOutcome({ exitCode: 0, stopReason: null, events: [] }).status, "failed");
  assert.equal(decideOutcome({ exitCode: 1, stopReason: null, events: [final] }).status, "failed");
  assert.equal(
    decideOutcome({ exitCode: 0, stopReason: null, events: [final, { kind: "error", message: "x" }] }).status,
    "failed",
  );
  assert.equal(
    decideOutcome({ exitCode: 1, stopReason: null, events: [{ kind: "error", message: "limit", rateLimited: true }] }).status,
    "rate_limited",
  );
  assert.equal(decideOutcome({ exitCode: null, stopReason: "aborted", events: [] }).status, "cancelled");
  assert.equal(decideOutcome({ exitCode: null, stopReason: "deadline", events: [final] }).status, "failed");
});
