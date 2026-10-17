import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventMessage } from "../types";
import { initialState, reduce } from "./state";
import { createEventSync } from "./sync";

const ev = (id: number): EventMessage => ({ type: "event", id, studyId: "s", employeeId: null, event: { kind: "stage", stage: `s${id}` } });

/** 서버 흉내: 1..n까지 이벤트가 있고, 조회 응답을 테스트가 원하는 때에 풀어 준다 */
function server(n: number) {
  const waiting: (() => void)[] = [];
  let total = n;
  return {
    add(k: number) {
      total += k;
    },
    fetchSince: (after: number) =>
      new Promise<EventMessage[]>((resolve) => {
        const snapshot = total;
        waiting.push(() => resolve(Array.from({ length: Math.max(0, snapshot - after) }, (_, i) => ev(after + i + 1))));
      }),
    resolveNext() {
      waiting.shift()!();
    },
  };
}

function harness(n: number) {
  const srv = server(n);
  let state = initialState([]);
  const sync = createEventSync({ fetchSince: srv.fetchSince, apply: (msgs) => (state = msgs.reduce((s, m) => reduce(s, m), state)) });
  const ids = () => state.feed.map((f) => f.id);
  return { srv, sync, ids };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("첫 보충 중에 온 실시간 이벤트는 기록 뒤에 순서대로 붙는다", async () => {
  const { srv, sync, ids } = harness(3);
  const p = sync.catchUp();
  sync.release();
  sync.receive(ev(5));
  sync.receive(ev(4));
  srv.resolveNext();
  await p;
  assert.deepEqual(ids(), [1, 2, 3, 4, 5]);
});

test("두 보충이 겹쳐도(처음 열기 + 스트림 연결) 빈 구간을 잃지 않는다", async () => {
  const { srv, sync, ids } = harness(2);
  const first = sync.catchUp(); // 1..2를 볼 조회
  sync.release();
  srv.add(2); // 그사이 3, 4가 생기고, 스트림이 붙어 두 번째 보충이 시작된다
  const second = sync.catchUp(); // 1..4를 볼 조회
  srv.resolveNext();
  await first;
  // 첫 보충만 끝난 상태에서 5가 실시간으로 온다. 바로 적용하면 3, 4가 버려진다
  sync.receive(ev(5));
  await tick();
  assert.deepEqual(ids(), [1, 2]);
  srv.resolveNext();
  await second;
  assert.deepEqual(ids(), [1, 2, 3, 4, 5]);
});

test("스트림이 끊겼다 다시 붙으면 끊긴 동안의 이벤트를 채운다", async () => {
  const { srv, sync, ids } = harness(2);
  const p = sync.catchUp();
  sync.release();
  srv.resolveNext();
  await p;
  sync.receive(ev(3));
  srv.add(3); // 4, 5는 끊긴 동안 생겨서 스트림으로 못 받았다
  const again = sync.catchUp();
  sync.receive(ev(6)); // 다시 붙은 직후 실시간으로 온 것
  srv.add(1);
  srv.resolveNext();
  await again;
  assert.deepEqual(ids(), [1, 2, 3, 4, 5, 6]);
});

test("보충 전에 붙잡아 둔 이벤트는 release 전까지 적용하지 않는다", async () => {
  const { sync, ids } = harness(0);
  sync.receive(ev(1));
  assert.deepEqual(ids(), []);
  sync.release();
  assert.deepEqual(ids(), [1]);
});
