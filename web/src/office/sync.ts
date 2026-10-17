// 과거 기록(REST)과 실시간 스트림(SSE)을 빠짐없이, 순서대로 이어 붙인다.
//
// 어려운 점: 스트림은 끊겼다 다시 붙어도 그사이 이벤트를 다시 보내 주지 않고, reducer는 이미 본 ID 이하를
// 중복으로 보고 버린다. 그래서 보충(catchUp)이 진행 중일 때 실시간 이벤트를 먼저 적용하면, 뒤늦게 받은
// 빈 구간 이벤트가 버려진다. → 보충이 하나라도 진행 중이면 실시간 이벤트를 모아 두었다가 끝난 뒤 적용한다.
import type { EventMessage } from "../types";

export interface EventSync {
  /** 마지막으로 적용한 ID 뒤를 끝까지 받아 적용한다. 처음 열 때와 스트림이 다시 붙을 때마다 부른다 */
  catchUp(): Promise<void>;
  /** 실시간 이벤트 하나 */
  receive(msg: EventMessage): void;
  /** 첫 보충을 시작한 뒤 부른다. 그 전에 온 실시간 이벤트는 붙잡아 둔다 */
  release(): void;
}

export function createEventSync(opts: {
  fetchSince: (afterId: number) => Promise<EventMessage[]>;
  apply: (msgs: EventMessage[]) => void;
  onError?: (err: Error) => void;
}): EventSync {
  let lastId = 0;
  let inflight = 0;
  let holding = true;
  let pending: EventMessage[] = [];

  const apply = (msgs: EventMessage[]) => {
    if (!msgs.length) return;
    for (const m of msgs) lastId = Math.max(lastId, m.id);
    opts.apply(msgs);
  };
  const flush = () => {
    if (holding || inflight > 0 || !pending.length) return;
    const queued = pending.sort((a, b) => a.id - b.id);
    pending = [];
    apply(queued);
  };

  return {
    async catchUp() {
      inflight++;
      try {
        apply(await opts.fetchSince(lastId));
      } catch (err) {
        opts.onError?.(err as Error);
      } finally {
        inflight--;
        flush();
      }
    },
    receive(msg) {
      if (holding || inflight > 0) pending.push(msg);
      else apply([msg]);
    },
    release() {
      holding = false;
      flush();
    },
  };
}
