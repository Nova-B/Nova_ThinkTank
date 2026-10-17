import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OfficeEvent, Orchestrator } from "../office/orchestrator.js";
import type { Employee } from "../office/roster.js";
import type { StudyRow, Store } from "../store/store.js";

export interface StreamMessage {
  type: "event";
  id: number;
  studyId: string;
  employeeId: string | null;
  event: OfficeEvent;
}

export interface StudyMessage {
  type: "study";
  study: StudyView;
}

export type StudyView = StudyRow & { running: boolean };

export interface AppDeps {
  store: Store;
  orchestrator: Orchestrator;
  roster: Employee[];
  /** 허용할 Host·Origin을 만들 때 쓰는 실제 포트 */
  port: () => number;
  /** 이벤트 버스. 오케스트레이터 onEvent가 여기로 보낸다 */
  bus: EventEmitter;
  isAlive: (pid: number) => boolean;
}

const MAX_BODY = 64 * 1024;
const EVENT_PAGE = 2000;
const STAGES = ["frame", "research", "asks", "revise", "redteam", "edit", "render", "done"];

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  // application/json을 요구하면 다른 사이트의 단순 form POST가 막힌다(사전 요청이 필요해지고, 그 요청엔 답하지 않는다)
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new HttpError(415, "Content-Type은 application/json이어야 한다");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "요청이 너무 크다");
    chunks.push(chunk as Buffer);
  }
  let raw: string;
  try {
    // 깨진 인코딩(예: CP949)을 대체 문자로 조용히 바꾸면, 직원들이 읽을 수 없는 질문을 추측해서 연구한다
    raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new HttpError(400, "요청 본문이 UTF-8이 아니다");
  }
  try {
    const value = JSON.parse(raw || "{}");
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "JSON 형식이 아니다");
  }
}

function text(body: Record<string, unknown>, key: string, max: number, required: boolean): string | null {
  const v = body[key];
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
    if (required) throw new HttpError(400, `${key}가 필요하다`);
    return null;
  }
  if (typeof v !== "string") throw new HttpError(400, `${key}는 문자열이어야 한다`);
  if (v.length > max) throw new HttpError(400, `${key}는 ${max}자 이하여야 한다`);
  // 대체 문자(U+FFFD)나 짝 없는 서로게이트는 어딘가에서 인코딩이 깨졌다는 뜻이다.
  // 이미 UTF-8로 다시 감싸져 들어오면 엄격 디코딩을 통과하므로 문자 단위로 한 번 더 본다.
  if (/\uFFFD|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v)) {
    throw new HttpError(400, `${key}에 깨진 글자가 섞여 있다. 다시 입력해 달라`);
  }
  return v.trim();
}

export function createApi(deps: AppDeps) {
  const { store, orchestrator, bus } = deps;
  const controllers = new Map<string, AbortController>();
  const runs = new Set<Promise<unknown>>();

  /** 이 서버가 돌리는 중이거나, 다른 살아 있는 프로세스(터미널 npm run study)가 잡고 있는 연구 */
  const lockedElsewhere = (s: StudyRow) => Boolean(s.lock_pid && s.lock_pid !== process.pid && deps.isAlive(s.lock_pid));
  const view = (s: StudyRow): StudyView => ({ ...s, running: orchestrator.isRunning(s.id) || lockedElsewhere(s) });
  const announce = (id: string) => {
    const s = store.getStudy(id);
    if (s) bus.emit("message", { type: "study", study: view(s) } satisfies StudyMessage);
  };

  function start(studyId: string): void {
    if (orchestrator.isRunning(studyId)) throw new HttpError(409, "이미 실행 중이다");
    const row = store.getStudy(studyId);
    if (row && lockedElsewhere(row)) throw new HttpError(409, "다른 프로세스(터미널)가 이 연구를 실행 중이다");
    const controller = new AbortController();
    controllers.set(studyId, controller);
    const run = orchestrator
      .run(studyId, { signal: controller.signal })
      .catch((err: Error) => {
        bus.emit("message", {
          type: "event",
          id: 0,
          studyId,
          employeeId: null,
          event: { kind: "error", message: err.message },
        } satisfies StreamMessage);
      })
      .finally(() => {
        controllers.delete(studyId);
        runs.delete(run);
        announce(studyId);
      });
    runs.add(run);
    // run()은 잠금을 잡고 상태를 running으로 바꾼 뒤 첫 await에서 돌아온다
    queueMicrotask(() => announce(studyId));
  }

  /** DNS 리바인딩과 다른 사이트의 요청을 막는다. 로그인이 없으니 이것이 유일한 문지기다. */
  function checkOrigin(req: IncomingMessage): void {
    const port = deps.port();
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(req.headers.host ?? "")) throw new HttpError(403, "허용되지 않은 Host");
    const origin = req.headers.origin;
    if (origin && !allowedHosts.map((h) => `http://${h}`).includes(origin)) {
      throw new HttpError(403, "허용되지 않은 Origin");
    }
    const site = req.headers["sec-fetch-site"];
    if (site && site !== "same-origin" && site !== "none") throw new HttpError(403, "다른 사이트에서 온 요청");
  }

  function getStudyOr404(id: string): StudyRow {
    const s = store.getStudy(id);
    if (!s) throw new HttpError(404, "없는 연구");
    return s;
  }

  function stream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const send = (msg: StreamMessage | StudyMessage) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    bus.on("message", send);
    req.on("close", () => {
      clearInterval(ping);
      bus.off("message", send);
    });
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://local");
    const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
    const method = req.method ?? "GET";
    const [, a, b, c, d] = parts;

    if (method === "GET" && a === "stream") return stream(req, res);

    if (method === "GET" && a === "meta") {
      return json(res, 200, { roster: deps.roster, stages: STAGES, rate: store.getMeta("rate:claude") ?? null });
    }

    if (a === "thinktanks" && !b) {
      if (method === "GET") {
        const tanks = store.listThinkTanks().map((t) => ({ ...t, studyCount: store.listStudies(t.id).length }));
        return json(res, 200, { thinktanks: tanks, unfiledCount: store.listStudies(null).length });
      }
      if (method === "POST") {
        const body = await readJson(req);
        const tank = store.createThinkTank(text(body, "name", 60, true)!, text(body, "description", 500, false) ?? "");
        return json(res, 201, { thinktank: tank });
      }
    }

    if (a === "studies" && !b) {
      if (method === "GET") {
        const tank = url.searchParams.get("thinktank");
        const list = tank === null ? store.listStudies() : store.listStudies(tank === "none" ? null : tank);
        return json(res, 200, { studies: list.map(view) });
      }
      if (method === "POST") {
        const body = await readJson(req);
        const question = text(body, "question", 2000, true)!;
        const hypothesis = text(body, "hypothesis", 2000, false);
        const thinktankId = text(body, "thinktankId", 40, false);
        if (thinktankId && !store.getThinkTank(thinktankId)) throw new HttpError(400, "없는 연구소");
        const study = orchestrator.createStudy(question, hypothesis, thinktankId);
        start(study.id);
        return json(res, 201, { study: view(store.getStudy(study.id)!) });
      }
    }

    if (a === "studies" && b) {
      const study = getStudyOr404(b);
      if (method === "GET" && !c) {
        return json(res, 200, {
          study: view(study),
          artifacts: store.listArtifacts(study.id),
          asks: store.db.prepare("SELECT id, from_employee, to_employee, question, status, answer FROM asks WHERE study_id = ? ORDER BY created_at").all(study.id),
        });
      }
      if (method === "GET" && c === "events") {
        const after = Number(url.searchParams.get("after") ?? "0") || 0;
        const rows = store.eventsAfter(study.id, after, EVENT_PAGE).map((r) => ({
          type: "event",
          id: r.id,
          studyId: r.study_id,
          employeeId: r.employee_id,
          event: JSON.parse(r.payload),
          at: r.at,
        }));
        // more가 true면 마지막 ID 뒤로 이어서 더 받아야 한다
        return json(res, 200, { events: rows, more: rows.length === EVENT_PAGE });
      }
      if (method === "GET" && c === "artifacts" && d) {
        const value = store.getArtifact(study.id, decodeURIComponent(d));
        if (value === undefined) throw new HttpError(404, "없는 산출물");
        return json(res, 200, { key: d, value });
      }
      if (method === "GET" && c === "report") {
        const file = study.report_path;
        if (!file || !existsSync(file)) throw new HttpError(404, "아직 보고서가 없다");
        return json(res, 200, { markdown: readFileSync(file, "utf8"), path: file });
      }
      if (method === "POST" && c === "pause") {
        await readJson(req);
        const controller = controllers.get(study.id);
        if (!controller) throw new HttpError(409, "실행 중이 아니다");
        controller.abort();
        return json(res, 202, { ok: true });
      }
      if (method === "POST" && c === "resume") {
        await readJson(req);
        if (study.status === "completed") throw new HttpError(409, "이미 끝난 연구다");
        start(study.id);
        return json(res, 202, { ok: true });
      }
      if (method === "POST" && c === "reflection") {
        const body = await readJson(req);
        store.setReflection(study.id, text(body, "text", 10_000, false) ?? "");
        // 보고서가 있으면 사후 검토 칸을 채워 다시 쓴다(볼트로 내보낸 파일 포함)
        const rewritten = study.status === "completed" ? orchestrator.writeReport(study.id) : null;
        announce(study.id);
        return json(res, 200, { ok: true, reportUpdated: rewritten !== null });
      }
    }
    throw new HttpError(404, "없는 경로");
  }

  return {
    /** /api 요청 처리. 그 밖의 경로면 false를 돌려준다 */
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      if (!(req.url ?? "").startsWith("/api/")) return false;
      try {
        checkOrigin(req);
        await route(req, res);
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        if (status === 500) console.error(err);
        if (!res.headersSent) json(res, status, { error: (err as Error).message });
        else res.end();
      }
      return true;
    },
    start,
    /**
     * 실행 중인 연구를 모두 멈추고, 각 연구가 취소를 기록하고 끝날 때까지 기다린다(최대 timeoutMs).
     * 취소 신호가 CLI 프로세스 트리를 바로 종료한다.
     */
    async abortAll(timeoutMs = 15_000): Promise<void> {
      for (const c of controllers.values()) c.abort();
      await Promise.race([Promise.allSettled([...runs]), new Promise((r) => setTimeout(r, timeoutMs))]);
    },
    /** 서버가 죽어 running으로 남은 연구를 멈춤으로 돌린다. 시작할 때 한 번 부른다 */
    recoverStale(isAlive: (pid: number) => boolean): number {
      let n = 0;
      for (const s of store.listStudies()) {
        if (s.status === "running" && !(s.lock_pid && isAlive(s.lock_pid))) {
          store.updateStudy(s.id, { status: "paused", error: "앱이 꺼져서 멈췄다. 이어서 실행할 수 있다" });
          n++;
        }
      }
      return n;
    },
  };
}

export function toStreamMessage(studyId: string, employee: Employee | null, event: OfficeEvent, id: number): StreamMessage {
  return { type: "event", id, studyId, employeeId: employee?.id ?? null, event };
}
