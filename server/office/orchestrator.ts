import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import type { RunTurnOptions, TurnOutcome } from "../runner/turn.js";
import type { Engine, McpServerSpec, NormalizedEvent, TurnSpec } from "../runner/types.js";
import type { StudyRow, StudyStatus, Store } from "../store/store.js";
import * as P from "./prompts.js";
import { renderReport } from "./report.js";
import { byRole, researchers, type Employee } from "./roster.js";
import {
  AskAnswerSchema,
  BriefSchema,
  CritiqueSchema,
  jsonSchemaOf,
  ReportDraftSchema,
  ResearchMemoSchema,
  SourceReviewSchema,
  validateBrief,
  validateCritique,
  validateMemo,
  validateReport,
  validateSourceReview,
  type AskAnswer,
  type Brief,
  type Claim,
  type Critique,
  type ReportDraft,
  type ResearchMemo,
  type SourceReview,
} from "./schemas.js";

const MAX_EVENT_TEXT = 1000;

/** 한 단계를 재개하며 다시 돌릴 수 있는 횟수. 누적 상한 = maxAttemptsPerStep × 이 값 */
const MAX_RESUMES_PER_STEP = 3;

export type TurnRunner = (spec: TurnSpec, opts: RunTurnOptions) => Promise<TurnOutcome>;

export interface Limits {
  concurrency: Record<Engine, number>;
  deadlineMs: number;
  maxOutputBytes: number;
  /** 한 단계에서 허용하는 턴 수(실패 재시도와 검증 실패 수정 포함) */
  maxAttemptsPerStep: number;
  maxAsksPerEmployee: number;
  maxAskAttempts: number;
  askLeaseMs: number;
  /** Claude 5시간 한도 사용률이 이 값 이상이면 새 Claude 턴을 시작하지 않는다 */
  claudeMaxFiveHour: number;
}

export const DEFAULT_LIMITS: Limits = {
  concurrency: { claude: 2, codex: 1 },
  deadlineMs: 15 * 60_000,
  maxOutputBytes: 20 * 1024 * 1024,
  maxAttemptsPerStep: 3,
  maxAsksPerEmployee: 2,
  maxAskAttempts: 2,
  askLeaseMs: 20 * 60_000,
  claudeMaxFiveHour: 0.9,
};

export type OfficeEvent =
  | NormalizedEvent
  | { kind: "turn_started"; step: string; attempt: number }
  | { kind: "turn_finished"; step: string; status: string; error: string | null; durationMs: number }
  | { kind: "stage"; stage: string };

export interface OrchestratorDeps {
  store: Store;
  dataDir: string;
  roster: Employee[];
  runTurn: TurnRunner;
  limits?: Limits;
  /** 직원 CLI가 띄울 사내 메신저 MCP 서버 실행 방법. null이면 메신저 없이 돈다 */
  officeMcp: { command: string; args: string[] } | null;
  exportDir?: string | null;
  /** 모든 실행에 걸리는 취소 신호(CLI의 Ctrl+C). 연구별 멈춤은 run()의 signal로 준다 */
  signal?: AbortSignal;
  /** eventId는 DB events 행 ID다. 화면이 과거 기록과 실시간 스트림을 겹치지 않게 이어 붙이는 데 쓴다 */
  onEvent?: (studyId: string, employee: Employee | null, event: OfficeEvent, eventId: number) => void;
  isAlive?: (pid: number) => boolean;
}

/** 연구를 멈추게 하는 사유. status가 Study의 다음 상태가 된다. */
export class StudyHalt extends Error {
  constructor(
    readonly status: Exclude<StudyStatus, "running" | "completed">,
    message: string,
  ) {
    super(message);
  }
}

class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  constructor(private readonly size: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.size) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/** 병렬 턴이 모두 끝나 기록을 마친 뒤에 첫 오류를 던진다. Promise.all은 나머지 턴이 기록 중일 때 먼저 빠져나간다. */
async function settleAll(tasks: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface StoredMemo {
  claims: Claim[];
  openQuestions: string[];
}

type TurnKind = "frame" | "research" | "answer" | "revise" | "redteam" | "edit";

interface StepSpec<S extends z.ZodType, A> {
  employee: Employee;
  stepKey: string;
  artifactKey: string;
  kind: TurnKind;
  prompt: string;
  schema: S;
  validate: (value: z.infer<S>) => string[];
  toArtifact: (value: z.infer<S>) => A;
  webSearch: boolean;
  messenger?: boolean;
}

export class Orchestrator {
  private readonly limits: Limits;
  private readonly semaphores: Record<Engine, Semaphore>;
  /**
   * 실행 중인 연구별 상태. 한 서버가 여러 연구를 동시에 돌리므로 연구마다 따로 둔다.
   * token은 질문 임대 토큰(이전 실행이 늦게 답을 써 넣지 못하게), signal은 그 연구의 멈춤 신호.
   */
  private readonly runs = new Map<string, { token: string; signal: AbortSignal | undefined }>();

  constructor(private readonly deps: OrchestratorDeps) {
    this.limits = deps.limits ?? DEFAULT_LIMITS;
    this.semaphores = {
      claude: new Semaphore(this.limits.concurrency.claude),
      codex: new Semaphore(this.limits.concurrency.codex),
    };
  }

  createStudy(question: string, hypothesis: string | null, thinktankId: string | null = null): StudyRow {
    return this.deps.store.createStudy({
      question,
      hypothesis,
      thinktankId,
      employees: this.deps.roster.map((e) => ({ id: e.id, role: e.role, engine: e.engine })),
    });
  }

  isRunning(studyId: string): boolean {
    return this.runs.has(studyId);
  }

  async run(studyId: string, opts: { signal?: AbortSignal } = {}): Promise<StudyRow> {
    const { store } = this.deps;
    const pid = process.pid;
    if (!store.acquireLock(studyId, pid, this.deps.isAlive ?? defaultIsAlive)) {
      throw new Error(`다른 프로세스가 이 연구를 실행 중이다: ${studyId}`);
    }
    const signals = [this.deps.signal, opts.signal].filter((x): x is AbortSignal => Boolean(x));
    this.runs.set(studyId, { token: randomUUID(), signal: signals.length ? AbortSignal.any(signals) : undefined });
    try {
      const interrupted = store.markInterruptedTurns(studyId);
      if (interrupted) this.emit(studyId, null, null, { kind: "error", message: `중단됐던 턴 ${interrupted}개를 다시 실행한다` });
      // 잠금을 잡았으니 남은 임대는 죽은 실행의 것이다. 만료를 기다리지 않고 되돌린다.
      const released = store.releaseStaleLeases(studyId);
      if (released) this.emit(studyId, null, null, { kind: "error", message: `처리 중 멈췄던 동료 질문 ${released}개를 다시 처리한다` });
      store.updateStudy(studyId, { status: "running", error: null });
      await this.pipeline(store.getStudy(studyId)!);
      this.stage(studyId, "done");
      store.updateStudy(studyId, { status: "completed" });
    } catch (err) {
      if (err instanceof StudyHalt) {
        store.updateStudy(studyId, { status: err.status, error: err.message });
      } else {
        store.updateStudy(studyId, { status: "failed", error: (err as Error).message });
        throw err;
      }
    } finally {
      this.runs.delete(studyId);
      store.releaseLock(studyId, pid);
    }
    return store.getStudy(studyId)!;
  }

  // ── 단계 ──────────────────────────────────────────────────

  private async pipeline(study: StudyRow): Promise<void> {
    const { roster, store } = this.deps;
    const staff = researchers(roster);
    const director = byRole(roster, "director");
    const redteam = byRole(roster, "redteam");
    const editor = byRole(roster, "editor");

    this.stage(study.id, "frame");
    const brief = await this.step<typeof BriefSchema, Brief>(study, {
      employee: director,
      stepKey: "frame",
      artifactKey: "brief",
      kind: "frame",
      prompt: P.framePrompt(study.question, staff),
      schema: BriefSchema,
      validate: (b) => validateBrief(b, staff.map((r) => r.id)),
      toArtifact: (b) => b,
      webSearch: false,
    });

    if (brief.readable === false) {
      // 산출물로 남기지 않는다. 같은 질문으로 다시 실행하면 소장이 다시 읽어 본다
      store.deleteArtifact(study.id, "brief");
      throw new StudyHalt("failed", `소장이 질문을 읽을 수 없다고 했다: ${brief.unreadableReason ?? "이유 없음"}`);
    }

    this.stage(study.id, "research");
    await settleAll(
      staff.map((r) => {
        const subq = brief.assignments.find((a) => a.researcherId === r.id)!.subquestions.map((q) => q.id);
        return this.step<typeof ResearchMemoSchema, StoredMemo>(study, {
          employee: r,
          stepKey: `research:${r.id}`,
          artifactKey: `memo:${r.id}`,
          kind: "research",
          prompt: P.researchPrompt(brief, r.id),
          schema: ResearchMemoSchema,
          validate: (m) => validateMemo(m, subq),
          toArtifact: (m) => this.storeMemo(r, m),
          webSearch: true,
          messenger: staff.length > 1,
        });
      }),
    );

    this.stage(study.id, "asks");
    await this.processAsks(study);

    this.stage(study.id, "revise");
    await settleAll(staff.map((r) => this.revise(study, brief, r)));
    const memos = staff.map((r) => store.getArtifact<StoredMemo>(study.id, `memo-final:${r.id}`)!);
    const claims = memos.flatMap((m) => m.claims);
    const claimIds = claims.map((c) => c.id);

    this.stage(study.id, "redteam");
    const review = await this.step<typeof SourceReviewSchema, SourceReview>(study, {
      employee: redteam,
      stepKey: "redteam:sources",
      artifactKey: "redteam-sources",
      kind: "redteam",
      prompt: P.sourceReviewPrompt(brief.refinedQuestion, claims),
      schema: SourceReviewSchema,
      validate: (v) => validateSourceReview(v, [...new Set(claims.flatMap((c) => c.sources.map((x) => x.url)))]),
      toArtifact: (v) => v,
      webSearch: true,
    });
    const critique = await this.step<typeof CritiqueSchema, Critique>(study, {
      employee: redteam,
      stepKey: "redteam:critique",
      artifactKey: "redteam-critique",
      kind: "redteam",
      prompt: P.critiquePrompt(claims, review),
      schema: CritiqueSchema,
      validate: (c) => validateCritique(c, claimIds),
      toArtifact: (v) => v,
      webSearch: true,
    });

    this.stage(study.id, "edit");
    await this.step<typeof ReportDraftSchema, ReportDraft>(study, {
      employee: editor,
      stepKey: "edit",
      artifactKey: "report-draft",
      kind: "edit",
      prompt: P.editPrompt({
        question: study.question,
        hypothesis: study.hypothesis,
        brief,
        claims,
        openQuestions: memos.flatMap((m) => m.openQuestions),
        review,
        critique,
      }),
      schema: ReportDraftSchema,
      validate: (d) => validateReport(d, claimIds, critique),
      toArtifact: (v) => v,
      webSearch: false,
    });

    this.stage(study.id, "render");
    this.writeReport(study.id);
  }

  /**
   * 저장된 산출물로 보고서를 다시 쓴다. 사후 검토(reflection)를 저장한 뒤에도 부른다.
   * 보고서는 data/ 안에 쓰고, exportDir이 있으면 같은 내용을 그곳(볼트)에도 쓴다.
   */
  writeReport(studyId: string): string {
    const { store, roster } = this.deps;
    const study = store.getStudy(studyId)!;
    const staff = researchers(roster);
    const get = <T>(key: string): T => {
      const v = store.getArtifact<T>(studyId, key);
      if (v === undefined) throw new Error(`보고서에 필요한 산출물이 없다: ${key}`);
      return v;
    };
    const memos = staff.map((r) => get<StoredMemo>(`memo-final:${r.id}`));
    const markdown = renderReport({
      study,
      roster,
      brief: get<Brief>("brief"),
      claims: memos.flatMap((m) => m.claims),
      review: get<SourceReview>("redteam-sources"),
      critique: get<Critique>("redteam-critique"),
      draft: get<ReportDraft>("report-draft"),
      researcherQuestions: staff.flatMap((r, i) => memos[i]!.openQuestions.map((q) => ({ who: r.label, question: q }))),
    });
    const dir = path.join(this.deps.dataDir, "studies", studyId);
    mkdirSync(dir, { recursive: true });
    const reportPath = path.join(dir, "report.md");
    writeFileSync(reportPath, markdown);
    let finalPath = reportPath;
    if (this.deps.exportDir) {
      mkdirSync(this.deps.exportDir, { recursive: true });
      finalPath = path.join(this.deps.exportDir, `${study.created_at.slice(0, 10)}_${studyId}.md`);
      writeFileSync(finalPath, markdown);
    }
    store.updateStudy(studyId, { report_path: finalPath });
    return markdown;
  }

  private storeMemo(r: Employee, memo: ResearchMemo): StoredMemo {
    const prefix = r.claimPrefix ?? r.id;
    return {
      claims: memo.claims.map((c, i) => ({ ...c, id: `${prefix}${i + 1}`, author: r.label })),
      openQuestions: memo.openQuestions,
    };
  }

  /** 질문 큐를 비울 때까지 처리한다. 답변 턴에서는 새 질문을 받지 않으므로 깊이 1에서 끝난다. */
  private async processAsks(study: StudyRow): Promise<void> {
    const { store, roster } = this.deps;
    const token = this.runs.get(study.id)!.token;
    for (;;) {
      const batch = store.claimAsks(study.id, this.limits.askLeaseMs, token);
      if (!batch.length) break;
      // 같은 직원에게 온 질문은 차례로(같은 세션 동시 실행 금지), 다른 직원끼리는 동시에
      const byAnswerer = Map.groupBy(batch, (a) => a.to_employee);
      await settleAll(
        [...byAnswerer.entries()].map(async ([to, asks]) => {
          const answerer = roster.find((e) => e.id === to);
          for (const ask of asks) {
            const from = roster.find((e) => e.id === ask.from_employee);
            if (!answerer) {
              store.failAsk(ask.id, `없는 직원: ${to}`, 0, token);
              continue;
            }
            try {
              const answer = await this.step<typeof AskAnswerSchema, AskAnswer>(study, {
                employee: answerer,
                stepKey: `answer:${ask.id}`,
                artifactKey: `answer:${ask.id}`,
                kind: "answer",
                prompt: P.answerPrompt(
                  from?.label ?? ask.from_employee,
                  ask.question,
                  store.getArtifact<StoredMemo>(study.id, `memo:${answerer.id}`)?.claims ?? [],
                ),
                schema: AskAnswerSchema,
                validate: () => [],
                toArtifact: (v) => v,
                webSearch: false,
              });
              const sources = answer.sources.map((s) => `${s.title} <${s.url}>`).join("; ");
              store.answerAsk(
                ask.id,
                `${answer.answer} [${answer.basis === "evidence" ? "근거" : "추론"}${sources ? `: ${sources}` : ""}]`,
                token,
              );
            } catch (err) {
              if (err instanceof StudyHalt && err.status !== "failed") throw err;
              store.failAsk(ask.id, (err as Error).message, this.limits.maxAskAttempts, token);
            }
          }
        }),
      );
    }
    // 답이 정해지지 않은 질문을 둔 채 다음 단계로 넘어가면 그 누락이 메모에 굳어진다
    const open = store.openAskCount(study.id);
    if (open) throw new StudyHalt("failed", `답이 정해지지 않은 동료 질문 ${open}개가 남았다`);
  }

  private async revise(study: StudyRow, brief: Brief, r: Employee): Promise<void> {
    const { store } = this.deps;
    const finalKey = `memo-final:${r.id}`;
    if (store.getArtifact(study.id, finalKey)) return;
    const answered = store.asksFrom(study.id, r.id).filter((a) => a.status === "answered" && a.answer);
    if (!answered.length) {
      store.putArtifact(study.id, finalKey, r.id, store.getArtifact<StoredMemo>(study.id, `memo:${r.id}`));
      return;
    }
    const subq = brief.assignments.find((a) => a.researcherId === r.id)!.subquestions.map((q) => q.id);
    await this.step<typeof ResearchMemoSchema, StoredMemo>(study, {
      employee: r,
      stepKey: `revise:${r.id}`,
      artifactKey: finalKey,
      kind: "revise",
      prompt: P.revisePrompt(
        store.getArtifact<StoredMemo>(study.id, `memo:${r.id}`)!,
        answered.map((a) => ({ to: a.to_employee, question: a.question, answer: a.answer! })),
      ),
      schema: ResearchMemoSchema,
      validate: (m) => validateMemo(m, subq),
      toArtifact: (m) => this.storeMemo(r, m),
      webSearch: true,
    });
  }

  // ── 턴 실행 ───────────────────────────────────────────────

  /**
   * 산출물(artifactKey)이 이미 있으면 그대로 돌려준다 — 이것이 체크포인트다.
   * 없으면 직원 턴을 돌려 스키마·참조 검증을 통과할 때까지(최대 maxAttemptsPerStep) 고쳐 받는다.
   */
  private async step<S extends z.ZodType, A>(study: StudyRow, s: StepSpec<S, A>): Promise<A> {
    const { store } = this.deps;
    const done = store.getArtifact<A>(study.id, s.artifactKey);
    if (done !== undefined) return done;

    const jsonSchema = jsonSchemaOf(s.schema);
    const schemaFile = this.writeSchemaFile(study.id, s.artifactKey, jsonSchema);
    let prompt = s.prompt;
    let lastError = "";
    for (let attempt = 1; attempt <= this.limits.maxAttemptsPerStep; attempt++) {
      // 재개할 때마다 시도 횟수가 새로 시작되지만, 누적으로는 상한을 둔다
      if (store.turnAttempts(study.id, s.stepKey) >= this.limits.maxAttemptsPerStep * MAX_RESUMES_PER_STEP) {
        throw new StudyHalt("failed", `${s.employee.label} ${s.stepKey}: 누적 시도 상한을 넘었다 (${lastError || "이전 실행에서 실패"})`);
      }
      const outcome = await this.semaphores[s.employee.engine].run(() =>
        this.employeeTurn(study, s, prompt, jsonSchema, schemaFile),
      );
      if (outcome.status === "rate_limited") {
        throw new StudyHalt("waiting_limit", `${s.employee.label}: 사용 한도에 걸렸다 (${outcome.error})`);
      }
      if (outcome.status === "cancelled") throw new StudyHalt("paused", "사용자가 멈췄다");
      if (outcome.status === "failed") {
        lastError = outcome.error ?? "실패";
        if (outcome.sessionMissing) {
          // 세션 파일이 사라졌다 → 새 세션으로. 프롬프트가 필요한 맥락을 모두 담고 있어 이어 갈 수 있다.
          store.deleteSession(study.id, s.employee.id);
          this.emit(study.id, null, s.employee, { kind: "error", message: "이전 세션을 찾지 못해 새 세션으로 다시 시작한다" });
        }
        prompt = s.prompt; // 실패한 턴은 같은 요청으로 다시 시도한다
        continue;
      }
      const parsed = s.schema.safeParse(outcome.output);
      const errors = parsed.success
        ? s.validate(parsed.data)
        : parsed.error.issues.map((i) => `${i.path.join(".") || "(루트)"}: ${i.message}`);
      if (!errors.length && parsed.success) {
        const artifact = s.toArtifact(parsed.data);
        store.completeStep(outcome.turnId, outcome.sessionId, study.id, s.artifactKey, s.employee.id, artifact);
        this.emit(study.id, outcome.turnId, s.employee, { kind: "turn_finished", step: s.stepKey, status: "succeeded", error: null, durationMs: outcome.durationMs });
        return artifact;
      }
      lastError = `검증 실패: ${errors.slice(0, 5).join(" / ")}`;
      store.finishTurn(outcome.turnId, { status: "invalid", sessionId: outcome.sessionId, error: lastError, exitCode: outcome.exitCode });
      this.emit(study.id, outcome.turnId, s.employee, { kind: "turn_finished", step: s.stepKey, status: "invalid", error: lastError, durationMs: outcome.durationMs });
      prompt = P.fixPrompt(errors);
    }
    throw new StudyHalt("failed", `${s.employee.label} ${s.stepKey} 단계 실패: ${lastError}`);
  }

  private writeSchemaFile(studyId: string, key: string, schema: object): string {
    const dir = path.join(this.deps.dataDir, "studies", studyId, "schemas");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${key.replace(/[^a-zA-Z0-9-]/g, "_")}.json`);
    writeFileSync(file, JSON.stringify(schema));
    return file;
  }

  private checkRateGuard(engine: Engine): void {
    if (engine !== "claude") return;
    const rate = this.deps.store.getMeta<{ status: string; fiveHour?: number; resetsAt?: number }>("rate:claude");
    if (!rate) return;
    // 리셋 시각이 지난 정보로 막으면, 갱신할 턴을 못 돌려 영원히 기다리게 된다
    if (rate.resetsAt && rate.resetsAt * 1000 <= Date.now()) return;
    const blocked = rate.status === "rejected" || (rate.fiveHour ?? 0) >= this.limits.claudeMaxFiveHour;
    if (blocked) {
      const reset = rate.resetsAt ? new Date(rate.resetsAt * 1000).toLocaleString() : "알 수 없음";
      throw new StudyHalt("waiting_limit", `Claude 5시간 한도 사용률 ${Math.round((rate.fiveHour ?? 1) * 100)}% — ${reset} 이후 다시 실행`);
    }
  }

  private async employeeTurn(
    study: StudyRow,
    s: StepSpec<z.ZodType, unknown>,
    prompt: string,
    outputSchema: object,
    outputSchemaFile: string,
  ): Promise<TurnOutcome & { turnId: string }> {
    const { store, dataDir } = this.deps;
    const emp = s.employee;
    const signal = this.runs.get(study.id)?.signal;
    if (signal?.aborted) throw new StudyHalt("paused", "사용자가 멈췄다");
    this.checkRateGuard(emp.engine);

    const cwd = path.join(dataDir, "studies", study.id, "employees", emp.id);
    mkdirSync(cwd, { recursive: true });
    const session = store.getSession(study.id, emp.id);
    let resumeSessionId: string | null = null;
    let newSessionId: string | undefined;
    if (session?.started) {
      resumeSessionId = session.session_id;
    } else if (emp.engine === "claude") {
      // Claude는 세션 ID를 앱이 정할 수 있다 → 턴 시작 전에 저장
      newSessionId = randomUUID();
      store.saveSession(study.id, emp.id, emp.engine, newSessionId, false);
    }

    const turn = store.startTurn(study.id, emp.id, s.stepKey);
    this.emit(study.id, turn.id, emp, { kind: "turn_started", step: s.stepKey, attempt: turn.attempt });

    const mcp: McpServerSpec | undefined =
      s.messenger && this.deps.officeMcp
        ? {
            name: "office",
            command: this.deps.officeMcp.command,
            args: this.deps.officeMcp.args,
            env: {
              NOVA_DB: store.file,
              NOVA_STUDY_ID: study.id,
              NOVA_EMPLOYEE_ID: emp.id,
              NOVA_TURN_ID: turn.id,
              NOVA_TURN_KIND: s.kind,
              NOVA_MAX_ASKS: String(this.limits.maxAsksPerEmployee),
            },
            tools: ["ask_colleague", "check_answers"],
          }
        : undefined;

    let outcome: TurnOutcome;
    try {
      outcome = await this.deps.runTurn(
        {
          engine: emp.engine,
          cwd,
          prompt,
          resumeSessionId,
          newSessionId,
          model: emp.model,
          effort: emp.effort,
          instructions: P.instructionsFor(emp),
          webSearch: s.webSearch,
          mcp,
          outputSchema,
          outputSchemaFile,
        },
        {
          deadlineMs: this.limits.deadlineMs,
          maxOutputBytes: this.limits.maxOutputBytes,
          signal,
          onEvent: (event) => {
            if (event.kind === "session") store.saveSession(study.id, emp.id, emp.engine, event.sessionId, true);
            if (event.kind === "rate_limit" && emp.engine === "claude") store.setMeta("rate:claude", event);
            this.emit(study.id, turn.id, emp, event);
          },
        },
      );
    } catch (err) {
      outcome = { status: "failed", sessionId: resumeSessionId, output: null, error: (err as Error).message, exitCode: null, durationMs: 0 };
    }
    // 성공한 턴은 산출물 검증을 거친 뒤 step()이 산출물과 함께 기록하고 turn_finished를 낸다.
    // 여기서 succeeded를 먼저 보내면, 검증에 떨어진 턴도 화면에 '마침'으로 남는다.
    if (outcome.status !== "succeeded") {
      store.finishTurn(turn.id, { status: outcome.status, sessionId: outcome.sessionId, error: outcome.error, exitCode: outcome.exitCode });
      this.emit(study.id, turn.id, emp, {
        kind: "turn_finished",
        step: s.stepKey,
        status: outcome.status,
        error: outcome.error,
        durationMs: outcome.durationMs,
      });
    }
    return { ...outcome, turnId: turn.id };
  }

  private stage(studyId: string, stage: string): void {
    this.deps.store.updateStudy(studyId, { stage });
    this.emit(studyId, null, null, { kind: "stage", stage });
  }

  /** 모든 이벤트는 먼저 DB에 남고, 그 행 ID와 함께 화면으로 나간다 */
  private emit(studyId: string, turnId: string | null, employee: Employee | null, event: OfficeEvent): void {
    // 최종 출력은 산출물로 따로 저장되므로 이벤트에는 줄여서 남긴다
    const stored: OfficeEvent =
      event.kind === "message" && event.text.length > MAX_EVENT_TEXT
        ? { ...event, text: event.text.slice(0, MAX_EVENT_TEXT) + "…" }
        : event.kind === "final"
          ? { kind: "final", output: "(산출물로 저장)" }
          : event;
    const id = this.deps.store.appendEvent(studyId, turnId, employee?.id ?? null, stored);
    this.deps.onEvent?.(studyId, employee, stored, id);
  }
}
