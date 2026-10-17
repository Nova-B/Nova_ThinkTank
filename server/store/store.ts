import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { NormalizedEvent } from "../runner/types.js";

// node:sqlite는 Node 22에서 실험 기능이라 불러올 때마다 경고를 찍는다. 그 경고만 걸러 낸 뒤 불러온다.
const require = createRequire(import.meta.url);
function loadSqlite(): typeof import("node:sqlite") {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning).includes("SQLite")) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } finally {
    process.emitWarning = original;
  }
}

export type StudyStatus = "running" | "paused" | "waiting_limit" | "failed" | "completed";
export type TurnRowStatus = "running" | "succeeded" | "failed" | "cancelled" | "rate_limited" | "interrupted" | "invalid";
export type AskStatus = "pending" | "leased" | "answered" | "failed";

export interface ThinkTankRow {
  id: string;
  name: string;
  description: string;
  created_at: string;
}

export interface StudyRow {
  id: string;
  thinktank_id: string | null;
  question: string;
  hypothesis: string | null;
  status: StudyStatus;
  stage: string;
  error: string | null;
  lock_pid: number | null;
  report_path: string | null;
  /** 사후 검토: 보고서를 읽은 사용자가 쓴 "가설과 무엇이 달랐나" */
  reflection: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventRow {
  id: number;
  study_id: string;
  turn_id: string | null;
  employee_id: string | null;
  kind: string;
  payload: string;
  at: string;
}

export interface SessionRow {
  study_id: string;
  employee_id: string;
  engine: string;
  session_id: string;
  started: number;
}

export interface AskRow {
  id: string;
  study_id: string;
  from_employee: string;
  to_employee: string;
  question: string;
  status: AskStatus;
  answer: string | null;
  attempts: number;
  lease_until: number | null;
  created_at: string;
  answered_at: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS thinktanks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS studies (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  hypothesis TEXT,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  error TEXT,
  lock_pid INTEGER,
  report_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS study_employees (
  study_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  role TEXT NOT NULL,
  engine TEXT NOT NULL,
  PRIMARY KEY (study_id, employee_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  study_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  engine TEXT NOT NULL,
  session_id TEXT NOT NULL,
  started INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (study_id, employee_id)
);
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  session_id TEXT,
  error TEXT,
  exit_code INTEGER,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (study_id, step_key, attempt)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study_id TEXT NOT NULL,
  turn_id TEXT,
  employee_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_study ON events (study_id, id);
CREATE TABLE IF NOT EXISTS artifacts (
  study_id TEXT NOT NULL,
  key TEXT NOT NULL,
  employee_id TEXT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (study_id, key)
);
CREATE TABLE IF NOT EXISTS asks (
  id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL,
  from_employee TEXT NOT NULL,
  to_employee TEXT NOT NULL,
  question TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  answer TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  asked_turn_id TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const now = () => new Date().toISOString();

export class AskLimitError extends Error {}

export class Store {
  readonly db: DatabaseSyncType;

  constructor(readonly file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    const { DatabaseSync } = loadSqlite();
    this.db = new DatabaseSync(file);
    // 오케스트레이터와 직원 CLI가 띄운 MCP 서버가 같은 파일을 동시에 연다
    // busy_timeout을 먼저 걸어야 WAL 전환·스키마 생성이 다른 프로세스와 겹쳐도 기다린다
    this.db.exec("PRAGMA busy_timeout = 10000;");
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** 이미 만들어진 DB에 나중에 생긴 컬럼을 더한다 (SCHEMA는 CREATE IF NOT EXISTS라 기존 테이블을 바꾸지 않는다) */
  private migrate(): void {
    const cols = (this.db.prepare("PRAGMA table_info(asks)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("lease_token")) this.db.exec("ALTER TABLE asks ADD COLUMN lease_token TEXT");
    const studyCols = (this.db.prepare("PRAGMA table_info(studies)").all() as { name: string }[]).map((c) => c.name);
    if (!studyCols.includes("thinktank_id")) this.db.exec("ALTER TABLE studies ADD COLUMN thinktank_id TEXT");
    if (!studyCols.includes("reflection")) this.db.exec("ALTER TABLE studies ADD COLUMN reflection TEXT");
  }

  close(): void {
    this.db.close();
  }

  /** BEGIN IMMEDIATE로 쓰기 잠금을 먼저 잡는다. 다른 프로세스와 읽고-고치기가 엇갈리지 않게. */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ── thinktanks ────────────────────────────────────────────

  createThinkTank(name: string, description: string): ThinkTankRow {
    const id = randomUUID().slice(0, 8);
    this.db
      .prepare("INSERT INTO thinktanks (id, name, description, created_at) VALUES (?, ?, ?, ?)")
      .run(id, name, description, now());
    return this.getThinkTank(id)!;
  }

  getThinkTank(id: string): ThinkTankRow | undefined {
    return this.db.prepare("SELECT * FROM thinktanks WHERE id = ?").get(id) as ThinkTankRow | undefined;
  }

  listThinkTanks(): ThinkTankRow[] {
    return this.db.prepare("SELECT * FROM thinktanks ORDER BY created_at").all() as unknown as ThinkTankRow[];
  }

  // ── studies ───────────────────────────────────────────────

  createStudy(input: {
    question: string;
    hypothesis: string | null;
    thinktankId?: string | null;
    employees: { id: string; role: string; engine: string }[];
  }): StudyRow {
    const id = `${now().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8)}`;
    this.tx(() => {
      this.db
        .prepare(
          "INSERT INTO studies (id, thinktank_id, question, hypothesis, status, stage, created_at, updated_at) VALUES (?, ?, ?, ?, 'paused', 'frame', ?, ?)",
        )
        .run(id, input.thinktankId ?? null, input.question, input.hypothesis, now(), now());
      const insert = this.db.prepare(
        "INSERT INTO study_employees (study_id, employee_id, role, engine) VALUES (?, ?, ?, ?)",
      );
      for (const e of input.employees) insert.run(id, e.id, e.role, e.engine);
    });
    return this.getStudy(id)!;
  }

  getStudy(id: string): StudyRow | undefined {
    return this.db.prepare("SELECT * FROM studies WHERE id = ?").get(id) as StudyRow | undefined;
  }

  listStudies(thinktankId?: string | null): StudyRow[] {
    if (thinktankId === undefined) {
      return this.db.prepare("SELECT * FROM studies ORDER BY created_at DESC").all() as unknown as StudyRow[];
    }
    return (
      thinktankId === null
        ? this.db.prepare("SELECT * FROM studies WHERE thinktank_id IS NULL ORDER BY created_at DESC").all()
        : this.db.prepare("SELECT * FROM studies WHERE thinktank_id = ? ORDER BY created_at DESC").all(thinktankId)
    ) as unknown as StudyRow[];
  }

  setReflection(id: string, reflection: string): void {
    this.db.prepare("UPDATE studies SET reflection = ?, updated_at = ? WHERE id = ?").run(reflection, now(), id);
  }

  updateStudy(id: string, patch: Partial<Pick<StudyRow, "status" | "stage" | "error" | "report_path">>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    this.db
      .prepare(`UPDATE studies SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => patch[k] ?? null), now(), id);
  }

  /**
   * 살아 있는 프로세스가 이 Study를 잡고 있으면 false. 같은 프로세스여도 거부한다 —
   * 같은 서버 안에서 두 번 실행되면 두 번째가 첫째의 턴을 interrupted로 바꿔 버리기 때문이다.
   */
  acquireLock(id: string, pid: number, isAlive: (pid: number) => boolean): boolean {
    return this.tx(() => {
      const row = this.getStudy(id);
      if (!row) throw new Error(`없는 Study: ${id}`);
      if (row.lock_pid && isAlive(row.lock_pid)) return false;
      this.db.prepare("UPDATE studies SET lock_pid = ?, updated_at = ? WHERE id = ?").run(pid, now(), id);
      return true;
    });
  }

  releaseLock(id: string, pid: number): void {
    this.db.prepare("UPDATE studies SET lock_pid = NULL WHERE id = ? AND lock_pid = ?").run(id, pid);
  }

  studyEmployees(studyId: string): { employee_id: string; role: string; engine: string }[] {
    return this.db
      .prepare("SELECT employee_id, role, engine FROM study_employees WHERE study_id = ?")
      .all(studyId) as unknown as { employee_id: string; role: string; engine: string }[];
  }

  // ── sessions ──────────────────────────────────────────────

  getSession(studyId: string, employeeId: string): SessionRow | undefined {
    return this.db
      .prepare("SELECT * FROM sessions WHERE study_id = ? AND employee_id = ?")
      .get(studyId, employeeId) as SessionRow | undefined;
  }

  /** 세션 ID를 턴이 끝나기 전에(시작 이벤트를 받는 즉시) 저장한다 */
  saveSession(studyId: string, employeeId: string, engine: string, sessionId: string, started: boolean): void {
    this.db
      .prepare(
        `INSERT INTO sessions (study_id, employee_id, engine, session_id, started) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (study_id, employee_id) DO UPDATE SET session_id = excluded.session_id, started = excluded.started`,
      )
      .run(studyId, employeeId, engine, sessionId, started ? 1 : 0);
  }

  /** 세션 파일이 사라져 재개할 수 없을 때 지운다. 다음 턴은 새 세션으로 시작한다. */
  deleteSession(studyId: string, employeeId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE study_id = ? AND employee_id = ?").run(studyId, employeeId);
  }

  // ── turns ─────────────────────────────────────────────────

  getTurn(id: string): { id: string; study_id: string; employee_id: string; status: TurnRowStatus } | undefined {
    return this.db.prepare("SELECT id, study_id, employee_id, status FROM turns WHERE id = ?").get(id) as
      | { id: string; study_id: string; employee_id: string; status: TurnRowStatus }
      | undefined;
  }

  startTurn(studyId: string, employeeId: string, stepKey: string): { id: string; attempt: number } {
    return this.tx(() => {
      const row = this.db
        .prepare("SELECT COALESCE(MAX(attempt), 0) AS n FROM turns WHERE study_id = ? AND step_key = ?")
        .get(studyId, stepKey) as { n: number };
      const running = this.db
        .prepare("SELECT id FROM turns WHERE study_id = ? AND employee_id = ? AND status = 'running'")
        .get(studyId, employeeId);
      // 같은 세션에서 두 턴을 동시에 돌리지 않는다
      if (running) throw new Error(`${employeeId}의 다른 턴이 실행 중이다`);
      const id = randomUUID();
      const attempt = row.n + 1;
      this.db
        .prepare(
          "INSERT INTO turns (id, study_id, employee_id, step_key, attempt, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)",
        )
        .run(id, studyId, employeeId, stepKey, attempt, now());
      return { id, attempt };
    });
  }

  finishTurn(id: string, patch: { status: TurnRowStatus; sessionId: string | null; error: string | null; exitCode: number | null }): void {
    this.db
      .prepare("UPDATE turns SET status = ?, session_id = ?, error = ?, exit_code = ?, ended_at = ? WHERE id = ?")
      .run(patch.status, patch.sessionId, patch.error, patch.exitCode, now(), id);
  }

  /** 앱이 죽어서 'running'으로 남은 턴을 'interrupted'로 바꾼다. 재시작 직후 한 번 부른다. */
  markInterruptedTurns(studyId: string): number {
    const r = this.db
      .prepare("UPDATE turns SET status = 'interrupted', ended_at = ? WHERE study_id = ? AND status = 'running'")
      .run(now(), studyId);
    return Number(r.changes);
  }

  turnAttempts(studyId: string, stepKey: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM turns WHERE study_id = ? AND step_key = ?")
      .get(studyId, stepKey) as { n: number };
    return row.n;
  }

  // ── events ────────────────────────────────────────────────

  appendEvent(studyId: string, turnId: string | null, employeeId: string | null, event: NormalizedEvent | { kind: string; [k: string]: unknown }): number {
    const r = this.db
      .prepare("INSERT INTO events (study_id, turn_id, employee_id, kind, payload, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(studyId, turnId, employeeId, event.kind, JSON.stringify(event), now());
    return Number(r.lastInsertRowid);
  }

  eventsAfter(studyId: string, afterId: number, limit = 5000): EventRow[] {
    return this.db
      .prepare("SELECT * FROM events WHERE study_id = ? AND id > ? ORDER BY id LIMIT ?")
      .all(studyId, afterId, limit) as unknown as EventRow[];
  }

  // ── artifacts ─────────────────────────────────────────────

  listArtifacts(studyId: string): { key: string; employee_id: string | null; created_at: string }[] {
    return this.db
      .prepare("SELECT key, employee_id, created_at FROM artifacts WHERE study_id = ? ORDER BY created_at")
      .all(studyId) as unknown as { key: string; employee_id: string | null; created_at: string }[];
  }

  getArtifact<T>(studyId: string, key: string): T | undefined {
    const row = this.db
      .prepare("SELECT content FROM artifacts WHERE study_id = ? AND key = ?")
      .get(studyId, key) as { content: string } | undefined;
    return row ? (JSON.parse(row.content) as T) : undefined;
  }

  /** 검증을 통과한 산출물 저장과 턴 성공 기록을 한 트랜잭션으로 묶는다. 둘 사이에 죽어도 어긋나지 않게. */
  completeStep(turnId: string, sessionId: string | null, studyId: string, key: string, employeeId: string, content: unknown): void {
    this.tx(() => {
      this.putArtifact(studyId, key, employeeId, content);
      this.finishTurn(turnId, { status: "succeeded", sessionId, error: null, exitCode: 0 });
    });
  }

  deleteArtifact(studyId: string, key: string): void {
    this.db.prepare("DELETE FROM artifacts WHERE study_id = ? AND key = ?").run(studyId, key);
  }

  /** 같은 key는 덮어쓴다(수정본). 키가 단계의 체크포인트 역할을 한다. */
  putArtifact(studyId: string, key: string, employeeId: string | null, content: unknown): void {
    this.db
      .prepare(
        `INSERT INTO artifacts (study_id, key, employee_id, content, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (study_id, key) DO UPDATE SET content = excluded.content, created_at = excluded.created_at`,
      )
      .run(studyId, key, employeeId, JSON.stringify(content), now());
  }

  // ── meta ──────────────────────────────────────────────────

  setMeta(key: string, value: unknown): void {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }

  getMeta<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  // ── asks (사내 메신저 큐) ─────────────────────────────────

  createAsk(input: {
    studyId: string;
    from: string;
    to: string;
    question: string;
    turnId: string | null;
    maxPerEmployee: number;
  }): { id: string; duplicate: boolean } {
    const dedupeKey = createHash("sha256")
      .update([input.studyId, input.from, input.to, input.question.trim().replace(/\s+/g, " ")].join("\u0000"))
      .digest("hex");
    return this.tx(() => {
      const existing = this.db.prepare("SELECT id FROM asks WHERE dedupe_key = ?").get(dedupeKey) as
        | { id: string }
        | undefined;
      if (existing) return { id: existing.id, duplicate: true };
      const count = this.db
        .prepare("SELECT COUNT(*) AS n FROM asks WHERE study_id = ? AND from_employee = ?")
        .get(input.studyId, input.from) as { n: number };
      if (count.n >= input.maxPerEmployee) {
        throw new AskLimitError(`이 연구에서 보낼 수 있는 질문은 ${input.maxPerEmployee}개까지다`);
      }
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO asks (id, study_id, from_employee, to_employee, question, dedupe_key, status, asked_turn_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(id, input.studyId, input.from, input.to, input.question, dedupeKey, input.turnId, now());
      return { id, duplicate: false };
    });
  }

  asksFrom(studyId: string, from: string): AskRow[] {
    return this.db
      .prepare("SELECT * FROM asks WHERE study_id = ? AND from_employee = ? ORDER BY created_at")
      .all(studyId, from) as unknown as AskRow[];
  }

  /**
   * 처리할 질문을 임대(lease)로 가져간다. 임대가 만료된 것도 다시 가져간다.
   * leaseToken을 함께 기록해, 만료 뒤 다른 처리자에게 넘어간 질문에 늦은 답이 덮어쓰지 못하게 한다.
   */
  claimAsks(studyId: string, leaseMs: number, leaseToken: string, nowMs = Date.now()): AskRow[] {
    return this.tx(
      () =>
        this.db
          .prepare(
            `UPDATE asks SET status = 'leased', lease_until = ?, lease_token = ?, attempts = attempts + 1
             WHERE study_id = ? AND (status = 'pending' OR (status = 'leased' AND lease_until < ?))
             RETURNING *`,
          )
          .all(nowMs + leaseMs, leaseToken, studyId, nowMs) as unknown as AskRow[],
    );
  }

  /**
   * 잠금을 잡은 직후에 부른다. 잠금이 있으니 지금 이 질문을 처리 중인 다른 실행은 없다 →
   * 남아 있는 임대는 죽은 실행의 것이므로 만료를 기다리지 않고 대기열로 되돌린다.
   */
  releaseStaleLeases(studyId: string): number {
    const r = this.db
      .prepare("UPDATE asks SET status = 'pending', lease_until = NULL, lease_token = NULL WHERE study_id = ? AND status = 'leased'")
      .run(studyId);
    return Number(r.changes);
  }

  /** 답 저장. 임대 토큰이 맞을 때만 쓴다. 쓰였으면 true */
  answerAsk(id: string, answer: string, leaseToken: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE asks SET status = 'answered', answer = ?, answered_at = ?, lease_until = NULL, lease_token = NULL
         WHERE id = ? AND status = 'leased' AND lease_token = ?`,
      )
      .run(answer, now(), id, leaseToken);
    return Number(r.changes) === 1;
  }

  /** 실패한 질문은 시도 횟수가 남았으면 다시 대기열로, 아니면 실패로 닫는다. 임대 토큰이 맞을 때만. */
  failAsk(id: string, error: string, maxAttempts: number, leaseToken: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE asks SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
         error = ?, lease_until = NULL, lease_token = NULL WHERE id = ? AND status = 'leased' AND lease_token = ?`,
      )
      .run(maxAttempts, error, id, leaseToken);
    return Number(r.changes) === 1;
  }

  /** 아직 답이 정해지지 않은 질문 수 (pending·leased) */
  openAskCount(studyId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM asks WHERE study_id = ? AND status IN ('pending', 'leased')")
      .get(studyId) as { n: number };
    return row.n;
  }
}
