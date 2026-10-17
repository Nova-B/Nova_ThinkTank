import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { DEFAULT_LIMITS, Orchestrator, type TurnRunner } from "../office/orchestrator.js";
import { DEFAULT_ROSTER } from "../office/roster.js";
import { Store } from "../store/store.js";
import { createApi, toStreamMessage, type StreamMessage } from "./app.js";

const dir = mkdtempSync(path.join(tmpdir(), "nova-http-"));
let server: Server;
let port = 0;
let store: Store;
let gate: Promise<void> = Promise.resolve();

// 단계별 최소 정답. orchestrator.test.ts의 가짜 실행기를 간추린 것
const OUT: Record<string, unknown> = {
  frame: {
    readable: true,
    unreadableReason: null,
    refinedQuestion: "rq",
    framing: "f",
    assignments: [
      { researcherId: "researcher-a", lens: "거시", subquestions: [{ id: "Q1", question: "q1" }] },
      { researcherId: "researcher-b", lens: "개인", subquestions: [{ id: "Q2", question: "q2" }] },
    ],
    outOfScope: [],
  },
  research: (q: string) => ({
    claims: [{ subquestionId: q, statement: `${q} 주장`, kind: "inference", confidence: "low", sources: [], reasoning: "논리" }],
    openQuestions: [],
  }),
  sources: { sources: [], independentReading: ["해석"] },
  critique: {
    challenges: [{ claimIds: ["A1"], type: "overreach", argument: "과장", severity: "low", wouldChangeConclusion: false }],
    conditionsWhereWrong: ["조건"],
    missingPerspectives: [],
  },
  edit: {
    title: "보고서",
    findings: [{ heading: "발견", body: "본문 <script>x</script>", claimIds: ["A1"] }],
    disagreements: [],
    redteamResponses: [{ challengeNo: 1, verdict: "overturned", response: "재반박 근거가 낫다", resolveBy: null }],
    actions: [{ scope: "personal", action: "행동", rationale: "이유", horizon: "now", claimIds: ["B1"] }],
    openQuestions: ["남은 질문"],
  },
};

const fake: TurnRunner = async (spec, run) => {
  await gate;
  run.onEvent({ kind: "session", sessionId: spec.resumeSessionId ?? spec.newSessionId ?? `t-${Math.random()}` });
  run.onEvent({ kind: "tool_call", tool: "WebSearch", detail: "검색어" });
  const p = spec.prompt;
  const output = p.includes("레드팀이 네 주장에 반론을 냈다")
    ? { responses: [{ challengeNo: 1, stance: "partial", argument: "일부만 맞다", evidence: [], revisedClaim: "고침" }] }
    : p.includes("리서처 명단:")
    ? OUT.frame
    : p.includes("너의 관점:")
      ? (OUT.research as (q: string) => unknown)(spec.cwd.includes("researcher-a") ? "Q1" : "Q2")
      : p.startsWith("2단계")
        ? OUT.critique
        : p.includes("1단계")
          ? OUT.sources
          : OUT.edit;
  return { status: "succeeded", sessionId: spec.resumeSessionId ?? spec.newSessionId ?? "t", output, error: null, exitCode: 0, durationMs: 1 };
};

before(async () => {
  store = new Store(path.join(dir, "nova.db"));
  const bus = new EventEmitter();
  const orchestrator = new Orchestrator({
    store,
    dataDir: dir,
    roster: DEFAULT_ROSTER,
    runTurn: fake,
    limits: DEFAULT_LIMITS,
    officeMcp: null,
    exportDir: path.join(dir, "vault"),
    onEvent: (studyId, employee, event, id) => bus.emit("message", toStreamMessage(studyId, employee, event, id)),
  });
  const api = createApi({ store, orchestrator, roster: DEFAULT_ROSTER, bus, port: () => port, isAlive: () => false });
  server = createServer(async (req, res) => {
    if (!(await api.handle(req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

after(() => {
  server.close();
  store.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows에서 열린 DB 파일은 지우지 못할 수 있다
  }
});

function http(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      { host: "127.0.0.1", port, path: url, method, headers: { ...(data ? { "content-type": "application/json" } : {}), ...headers } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : null }));
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitFor(fn: () => Promise<boolean>, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("시간 초과");
}

test("연구소를 만들고 그 안에 연구를 맡기면 끝까지 돌고, 보고서·이벤트를 볼 수 있다", async () => {
  const tank = await http("POST", "/api/thinktanks", { name: "AI와 에너지", description: "전력" });
  assert.equal(tank.status, 201);
  const created = await http("POST", "/api/studies", { question: "전력 병목은?", hypothesis: "송전망", thinktankId: tank.json.thinktank.id });
  assert.equal(created.status, 201);
  const id = created.json.study.id as string;
  await waitFor(async () => (await http("GET", `/api/studies/${id}`)).json.study.status === "completed");

  const listed = await http("GET", `/api/studies?thinktank=${tank.json.thinktank.id}`);
  assert.deepEqual(listed.json.studies.map((s: { id: string }) => s.id), [id]);
  const events = await http("GET", `/api/studies/${id}/events?after=0`);
  const kinds = new Set(events.json.events.map((e: { event: { kind: string } }) => e.event.kind));
  for (const k of ["stage", "turn_started", "tool_call", "turn_finished"]) assert.ok(kinds.has(k), k);
  const ids = events.json.events.map((e: { id: number }) => e.id);
  assert.deepEqual(ids, [...ids].sort((a: number, b: number) => a - b), "ID 순서");
  const later = await http("GET", `/api/studies/${id}/events?after=${ids[3]}`);
  assert.equal(later.json.events[0].id, ids[4]);

  const report = await http("GET", `/api/studies/${id}/report`);
  assert.match(report.json.markdown, /송전망/);
  assert.match(report.json.path, /vault/);
  const art = await http("GET", `/api/studies/${id}/artifacts/brief`);
  assert.equal(art.json.value.refinedQuestion, "rq");
});

test("사후 검토를 저장하면 볼트의 보고서 파일도 다시 쓴다", async () => {
  const created = await http("POST", "/api/studies", { question: "q" });
  const id = created.json.study.id as string;
  await waitFor(async () => (await http("GET", `/api/studies/${id}`)).json.study.status === "completed");
  const saved = await http("POST", `/api/studies/${id}/reflection`, { text: "레드팀 반론 1번은 받아들이지 않겠다" });
  assert.equal(saved.json.reportUpdated, true);
  const file = store.getStudy(id)!.report_path!;
  assert.match(readFileSync(file, "utf8"), /레드팀 반론 1번은 받아들이지 않겠다/);
});

test("실시간 스트림으로 이벤트가 ID와 함께 온다", async () => {
  let release!: () => void;
  gate = new Promise<void>((r) => (release = r));
  const received: StreamMessage[] = [];
  const req = request({ host: "127.0.0.1", port, path: "/api/stream" }, (res) => {
    res.setEncoding("utf8");
    let buf = "";
    res.on("data", (c: string) => {
      buf += c;
      for (const block of buf.split("\n\n").slice(0, -1)) {
        const line = block.split("\n").find((l) => l.startsWith("data: "));
        if (line) received.push(JSON.parse(line.slice(6)));
      }
      buf = buf.slice(buf.lastIndexOf("\n\n") + 2);
    });
  });
  req.end();
  await new Promise((r) => setTimeout(r, 100));
  const created = await http("POST", "/api/studies", { question: "스트림" });
  const id = created.json.study.id as string;
  release();
  await waitFor(async () => received.some((m) => m.type === "event" && m.studyId === id && m.event.kind === "turn_finished"));
  const mine = received.filter((m) => m.type === "event" && m.studyId === id);
  assert.ok(mine.every((m) => m.id > 0));
  assert.ok(received.some((m) => (m as unknown as { type: string }).type === "study"));
  req.destroy();
  gate = Promise.resolve();
  await waitFor(async () => (await http("GET", `/api/studies/${id}`)).json.study.status === "completed");
});

test("멈추기: 실행 중인 연구를 멈추고 이어서 할 수 있다", async () => {
  let release!: () => void;
  gate = new Promise<void>((r) => (release = r));
  const created = await http("POST", "/api/studies", { question: "멈춤" });
  const id = created.json.study.id as string;
  await waitFor(async () => (await http("GET", `/api/studies/${id}`)).json.study.running === true);
  assert.equal((await http("POST", `/api/studies/${id}/pause`, {})).status, 202);
  release();
  await waitFor(async () => (await http("GET", `/api/studies/${id}`)).json.study.status === "paused");
  gate = Promise.resolve();
  assert.equal((await http("POST", `/api/studies/${id}/resume`, {})).status, 202);
  assert.equal((await http("POST", `/api/studies/${id}/resume`, {})).status, 409, "이미 실행 중이면 거절");
  await waitFor(async () => (await http("GET", `/api/studies/${id}`)).json.study.status === "completed");
});

test("다른 사이트의 요청과 DNS 리바인딩을 막는다", async () => {
  const evilOrigin = await http("POST", "/api/thinktanks", { name: "x" }, { origin: "https://evil.example" });
  assert.equal(evilOrigin.status, 403);
  const evilHost = await http("GET", "/api/meta", undefined, { host: `evil.example:${port}` });
  assert.equal(evilHost.status, 403);
  const goodOrigin = await http("GET", "/api/meta", undefined, { origin: `http://localhost:${port}` });
  assert.equal(goodOrigin.status, 200);
  const notJson = await new Promise<number>((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/thinktanks", method: "POST", headers: { "content-type": "text/plain" } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.end("name=x");
  });
  assert.equal(notJson, 415);
});

test("UTF-8이 아닌 본문(예: CP949로 보낸 한글)은 거부한다", async () => {
  const status = await new Promise<number>((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/studies", method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    // "한국" 을 CP949로 인코딩한 바이트
    req.end(Buffer.concat([Buffer.from('{"question":"'), Buffer.from([0xc7, 0xd1, 0xb1, 0xb9]), Buffer.from('"}')]));
  });
  assert.equal(status, 400);
});

test("이미 대체 문자로 바뀐 뒤 UTF-8로 온 질문, 짝 없는 서로게이트도 거부한다", async () => {
  assert.equal((await http("POST", "/api/studies", { question: "\uFFFD\uFFFD AI \uFFFD?" })).status, 400);
  const lone = await new Promise<number>((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/studies", method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.end('{"question":"\\ud800 질문"}');
  });
  assert.equal(lone, 400);
});

test("다른 사이트에서 온 요청(Sec-Fetch-Site)과 JSON이 아닌 멈추기 요청을 거절한다", async () => {
  const cross = await http("GET", "/api/meta", undefined, { "sec-fetch-site": "cross-site" });
  assert.equal(cross.status, 403);
  const same = await http("GET", "/api/meta", undefined, { "sec-fetch-site": "same-origin" });
  assert.equal(same.status, 200);
  const created = await http("POST", "/api/studies", { question: "q" });
  const bare = await new Promise<number>((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: `/api/studies/${created.json.study.id}/pause`, method: "POST" }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.end();
  });
  assert.equal(bare, 415);
  await waitFor(async () => (await http("GET", `/api/studies/${created.json.study.id}`)).json.study.status === "completed");
});

test("과거 기록을 페이지로 나눠 주고, more로 이어 받을 수 있다", async () => {
  const created = await http("POST", "/api/studies", { question: "많은 기록" });
  const id = created.json.study.id as string;
  await waitFor(async () => (await http("GET", `/api/studies/${id}`)).json.study.status === "completed");
  for (let i = 0; i < 2100; i++) store.appendEvent(id, null, null, { kind: "error", message: `e${i}` });
  const first = await http("GET", `/api/studies/${id}/events?after=0`);
  assert.equal(first.json.events.length, 2000);
  assert.equal(first.json.more, true);
  const last = first.json.events.at(-1).id;
  const second = await http("GET", `/api/studies/${id}/events?after=${last}`);
  assert.equal(second.json.more, false);
  assert.ok(second.json.events.length > 100);
});

test("입력 검증: 빈 질문, 없는 연구소, 없는 연구", async () => {
  assert.equal((await http("POST", "/api/studies", { question: "  " })).status, 400);
  assert.equal((await http("POST", "/api/studies", { question: "q", thinktankId: "nope" })).status, 400);
  assert.equal((await http("GET", "/api/studies/nope")).status, 404);
});
