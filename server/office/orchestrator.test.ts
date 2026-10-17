import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { OfficeTools } from "../mcp/office-tools.js";
import type { RunTurnOptions, TurnOutcome } from "../runner/turn.js";
import type { TurnSpec } from "../runner/types.js";
import { Store } from "../store/store.js";
import { DEFAULT_LIMITS, Orchestrator, type TurnRunner } from "./orchestrator.js";
import { DEFAULT_ROSTER } from "./roster.js";
import type { Brief, Critique, ReportDraft, ResearchMemo, SourceReview } from "./schemas.js";

const dir = mkdtempSync(path.join(tmpdir(), "nova-orch-"));
after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 실패한 테스트가 DB를 닫지 못했으면 Windows에서 지울 수 없다. 임시 폴더라 남겨 둔다.
  }
});

const BRIEF: Brief = {
  readable: true,
  unreadableReason: null,
  refinedQuestion: "다듬은 질문",
  framing: "범위",
  assignments: [
    { researcherId: "researcher-a", lens: "거시", subquestions: [{ id: "Q1", question: "에너지?" }] },
    { researcherId: "researcher-b", lens: "개인", subquestions: [{ id: "Q2", question: "개인?" }] },
  ],
  outOfScope: [],
};
const memo = (q: string): ResearchMemo => ({
  claims: [
    {
      subquestionId: q,
      statement: `${q} 주장`,
      kind: "evidence",
      confidence: "medium",
      sources: [{ title: "t", url: `https://example.com/${q}`, publisher: null, publishedAt: null, accessedAt: "2026-10-17", quote: "구절", fetched: true }],
      reasoning: null,
    },
  ],
  openQuestions: [`${q} 미해결`],
});
const REVIEW: SourceReview = {
  sources: [
    { url: "https://example.com/Q1", reliability: "low", note: "광고성" },
    { url: "https://example.com/Q2", reliability: "high", note: "1차 자료" },
  ],
  independentReading: ["해석"],
};
const CRITIQUE: Critique = {
  challenges: [{ claimIds: ["A1"], type: "overreach", argument: "과장", severity: "high", wouldChangeConclusion: true }],
  conditionsWhereWrong: ["효율이 급격히 오르면"],
  missingPerspectives: [],
};
const DRAFT: ReportDraft = {
  title: "보고서",
  findings: [{ heading: "발견", body: "본문", claimIds: ["A1", "B1"] }],
  disagreements: [],
  redteamResponses: [{ challengeNo: 1, accepted: true, response: "수정함" }],
  actions: [
    { scope: "macro", action: "전력망 투자", rationale: "이유", horizon: "1-3y", claimIds: ["A1"] },
    { scope: "personal", action: "기록 습관", rationale: "이유", horizon: "now", claimIds: ["B1"] },
  ],
  openQuestions: ["남은 질문"],
};

type Step = "frame" | "research" | "answer" | "revise" | "sources" | "critique" | "edit" | "fix";
function stepOf(prompt: string): Step {
  if (prompt.includes("검증을 통과하지 못했다")) return "fix";
  if (prompt.includes("리서처 명단:")) return "frame";
  if (prompt.includes("너의 관점:")) return "research";
  if (prompt.includes("질문을 보냈다")) return "answer";
  if (prompt.includes("답이 왔다")) return "revise";
  if (prompt.startsWith("2단계")) return "critique";
  if (prompt.includes("1단계")) return "sources";
  if (prompt.includes("보고서를 쓴다")) return "edit";
  throw new Error(`알 수 없는 프롬프트: ${prompt.slice(0, 40)}`);
}

interface FakeOptions {
  /** 단계별로 응답을 바꾼다. undefined를 돌려주면 기본 응답 */
  override?: (step: Step, spec: TurnSpec, call: number) => Partial<TurnOutcome> | undefined;
  store?: Store;
}

function fakeRunner(opts: FakeOptions = {}) {
  const calls: { step: Step; spec: TurnSpec }[] = [];
  const lastStep = new Map<string, Step>();
  let n = 0;
  const runner: TurnRunner = async (spec: TurnSpec, run: RunTurnOptions) => {
    const step = stepOf(spec.prompt);
    calls.push({ step, spec });
    const sessionId = spec.resumeSessionId ?? spec.newSessionId ?? `thread-${++n}`;
    run.onEvent({ kind: "session", sessionId });
    // 고치기 턴은 같은 세션의 직전 단계 산출물을 다시 낸다
    const answerAs = step === "fix" ? lastStep.get(sessionId)! : step;
    lastStep.set(sessionId, answerAs);
    const lens = spec.cwd.includes("researcher-a") ? "Q1" : "Q2";
    const output = {
      frame: BRIEF,
      research: memo(lens),
      answer: { answer: "답", basis: "inference", sources: [] },
      revise: memo(lens),
      sources: REVIEW,
      critique: CRITIQUE,
      edit: DRAFT,
    }[answerAs as Exclude<Step, "fix">];
    const base: TurnOutcome = { status: "succeeded", sessionId, output, error: null, exitCode: 0, durationMs: 1 };
    return { ...base, ...opts.override?.(step, spec, calls.length) };
  };
  return { runner, calls };
}

function setup(name: string, runner: TurnRunner, extra: Partial<ConstructorParameters<typeof Orchestrator>[0]> = {}) {
  const store = new Store(path.join(dir, `${name}.db`));
  const dataDir = path.join(dir, name);
  const orch = new Orchestrator({ store, dataDir, roster: DEFAULT_ROSTER, runTurn: runner, officeMcp: null, limits: DEFAULT_LIMITS, ...extra });
  return { store, orch, dataDir };
}

test("전체 흐름: 소장 → 리서치 → 레드팀 2단계 → 편집 → 보고서", async () => {
  const { runner, calls } = fakeRunner();
  const { store, orch } = setup("full", runner);
  const study = orch.createStudy("AI 시대에 중요한 것은?", null);
  const result = await orch.run(study.id);
  assert.equal(result.status, "completed", result.error ?? "");
  assert.deepEqual(calls.map((c) => c.step).sort(), ["critique", "edit", "frame", "research", "research", "sources"].sort());

  const report = readFileSync(result.report_path!, "utf8");
  for (const h of ["## 🪞 Nova의 가설", "## 핵심 발견", "## 이견", "## 레드팀 반론과 편집장의 응답", "## 행동 제안", "## ❓ 미해결 질문", "## 근거 목록", "## 🪞 사후 검토"]) {
    assert.ok(report.includes(h), h);
  }
  assert.ok(report.includes("checked: false"));
  assert.ok(report.includes("연구 전에 적지 않음"));
  assert.ok(report.includes("| A1 |") && report.includes("| B1 |"));
  assert.ok(report.includes("낮음"), "레드팀 신뢰도 표시");

  // 레드팀은 같은 세션에서 1단계 → 2단계로 이어 간다
  const red = calls.filter((c) => c.step === "sources" || c.step === "critique");
  assert.equal(red[0]!.spec.resumeSessionId, null);
  assert.equal(red[1]!.spec.resumeSessionId, store.getSession(study.id, "redteam")!.session_id);
  // 레드팀 1단계에는 리서처의 주장 문장이 들어가지 않는다(원자료 먼저)
  assert.ok(!red[0]!.spec.prompt.includes("Q1 주장"));
  store.close();
});

test("소장이 질문을 읽을 수 없다고 하면 추측해서 진행하지 않고 멈춘다", async () => {
  const { runner, calls } = fakeRunner({
    override: (step) =>
      step === "frame"
        ? { output: { ...BRIEF, readable: false, unreadableReason: "글자가 깨져 있다", assignments: [], refinedQuestion: "", framing: "" } }
        : undefined,
  });
  const { store, orch } = setup("unreadable", runner);
  const study = orch.createStudy("\uFFFD\uFFFD AI \uFFFD?", null);
  const result = await orch.run(study.id);
  assert.equal(result.status, "failed");
  assert.match(result.error!, /글자가 깨져 있다/);
  assert.equal(calls.length, 1, "리서치로 넘어가지 않는다");
  assert.equal(store.getArtifact(study.id, "brief"), undefined);
  store.close();
});

test("검증 실패: 고쳐 달라고 같은 세션에 다시 묻는다", async () => {
  const { runner, calls } = fakeRunner({
    override: (step, _spec, call) =>
      step === "frame" && call === 1
        ? { output: { ...BRIEF, assignments: [BRIEF.assignments[0]!] } } // researcher-b 누락
        : undefined,
  });
  const { store, orch } = setup("fix", runner);
  const result = await orch.run(orch.createStudy("q", null).id);
  assert.equal(result.status, "completed", result.error ?? "");
  assert.equal(calls[1]!.step, "fix");
  assert.match(calls[1]!.spec.prompt, /researcher-b에게 배정이 없다/);
  assert.ok(calls[1]!.spec.resumeSessionId, "고치기 턴은 세션을 이어 간다");
  store.close();
});

test("한도: 한도에 걸리면 waiting_limit으로 멈추고, 다시 실행하면 이어서 끝낸다", async () => {
  let limited = true;
  const { runner, calls } = fakeRunner({
    override: (step) => (step === "critique" && limited ? { status: "rate_limited", error: "usage limit" } : undefined),
  });
  const { store, orch } = setup("limit", runner);
  const study = orch.createStudy("q", "에너지가 핵심일 것");
  const first = await orch.run(study.id);
  assert.equal(first.status, "waiting_limit");
  assert.equal(first.stage, "redteam");
  const before = calls.length;

  limited = false;
  const second = await orch.run(study.id);
  assert.equal(second.status, "completed", second.error ?? "");
  // 체크포인트: 이미 끝난 소장·리서치·레드팀 1단계는 다시 돌지 않는다
  assert.deepEqual(calls.slice(before).map((c) => c.step), ["critique", "edit"]);
  assert.ok(readFileSync(second.report_path!, "utf8").includes("에너지가 핵심일 것"));
  store.close();
});

test("Claude 5시간 사용률이 상한을 넘으면 새 Claude 턴을 시작하지 않는다", async () => {
  const { runner, calls } = fakeRunner();
  const { store, orch } = setup("guard", runner);
  const future = Math.floor(Date.now() / 1000) + 3600;
  store.setMeta("rate:claude", { status: "allowed", fiveHour: 0.95, resetsAt: future });
  const result = await orch.run(orch.createStudy("q", null).id);
  assert.equal(result.status, "waiting_limit");
  assert.equal(calls.length, 0);
  store.close();
});

test("한도 리셋 시각이 지난 사용률 정보로는 막지 않는다", async () => {
  const { runner } = fakeRunner();
  const { store, orch } = setup("guard-expired", runner);
  store.setMeta("rate:claude", { status: "rejected", fiveHour: 1, resetsAt: Math.floor(Date.now() / 1000) - 60 });
  const result = await orch.run(orch.createStudy("q", null).id);
  assert.equal(result.status, "completed", result.error ?? "");
  store.close();
});

test("같은 프로세스에서 같은 Study를 동시에 두 번 돌릴 수 없다", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { runner } = fakeRunner();
  const slow: TurnRunner = async (spec, opts) => {
    await gate;
    return runner(spec, opts);
  };
  const { store, orch } = setup("double", slow);
  const study = orch.createStudy("q", null);
  const first = orch.run(study.id);
  await assert.rejects(orch.run(study.id), /실행 중/);
  release();
  assert.equal((await first).status, "completed");
  store.close();
});

test("세션 파일이 사라지면 새 세션으로 다시 시작한다", async () => {
  let gone = true;
  const { runner, calls } = fakeRunner({
    override: (step, spec) =>
      step === "critique" && spec.resumeSessionId && gone
        ? ((gone = false), { status: "failed", error: "no rollout found", output: null, sessionMissing: true })
        : undefined,
  });
  const { store, orch } = setup("session-lost", runner);
  const result = await orch.run(orch.createStudy("q", null).id);
  assert.equal(result.status, "completed", result.error ?? "");
  const critiques = calls.filter((c) => c.step === "critique");
  assert.equal(critiques.length, 2);
  assert.ok(critiques[0]!.spec.resumeSessionId);
  assert.equal(critiques[1]!.spec.resumeSessionId, null, "두 번째는 새 세션");
  assert.match(critiques[1]!.spec.prompt, /1단계 해석/, "새 세션이어도 필요한 맥락이 프롬프트에 있다");
  store.close();
});

test("재개마다 시도가 새로 시작되지만 누적 상한을 넘으면 멈춘다", async () => {
  const { runner, calls } = fakeRunner({
    override: (step) => (step === "frame" ? { status: "failed", error: "boom", output: null } : undefined),
  });
  const { store, orch } = setup("cumulative", runner);
  const study = orch.createStudy("q", null);
  for (let i = 0; i < 4; i++) await orch.run(study.id);
  assert.equal(calls.length, DEFAULT_LIMITS.maxAttemptsPerStep * 3);
  assert.match(store.getStudy(study.id)!.error!, /누적 시도 상한/);
  store.close();
});

test("출처를 빠뜨린 레드팀 1단계는 고쳐 받는다", async () => {
  const { runner, calls } = fakeRunner({
    override: (step, _spec, call) =>
      step === "sources" && !calls.some((c, i) => i < call - 1 && c.step === "sources")
        ? { output: { ...REVIEW, sources: [] } }
        : undefined,
  });
  const { store, orch } = setup("sources-fix", runner);
  const result = await orch.run(orch.createStudy("q", null).id);
  assert.equal(result.status, "completed", result.error ?? "");
  const fix = calls.find((c) => c.step === "fix")!;
  assert.match(fix.spec.prompt, /평가하지 않은 출처/);
  store.close();
});

test("성공한 턴은 산출물과 함께 기록되고, 이벤트 처리 실패는 턴 실패로 남는다", async () => {
  const { runner } = fakeRunner({
    override: (step, _spec, call) =>
      step === "frame" && call === 1 ? { status: "failed", error: "이벤트 처리 실패: disk full", output: null } : undefined,
  });
  const { store, orch } = setup("atomic", runner);
  const study = orch.createStudy("q", null);
  await orch.run(study.id);
  const rows = store.db.prepare("SELECT step_key, status FROM turns WHERE study_id = ? ORDER BY started_at, attempt").all(study.id) as { step_key: string; status: string }[];
  assert.deepEqual({ ...rows[0] }, { step_key: "frame", status: "failed" });
  assert.equal(rows.filter((r) => r.status === "running").length, 0);
  const artifacts = (store.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE study_id = ?").get(study.id) as { n: number }).n;
  const succeeded = rows.filter((r) => r.status === "succeeded").length;
  // 턴이 만든 산출물은 모두 성공 턴과 짝이 맞는다. 질문이 없으면 memo-final 2개는 턴 없이 memo를 복사한 것
  assert.equal(artifacts, succeeded + 2);
  store.close();
});

test("재시작: 실행 중 프로세스가 죽은 턴은 interrupted로 바꾸고 다시 돈다", async () => {
  const { runner } = fakeRunner();
  const { store, orch } = setup("crash", runner);
  const study = orch.createStudy("q", null);
  store.startTurn(study.id, "director", "frame"); // 죽은 프로세스가 남긴 running 턴
  const result = await orch.run(study.id);
  assert.equal(result.status, "completed", result.error ?? "");
  const statuses = store.db.prepare("SELECT status FROM turns WHERE step_key = 'frame' ORDER BY attempt").all() as { status: string }[];
  assert.deepEqual(statuses.map((s) => s.status), ["interrupted", "succeeded"]);
  store.close();
});

test("실패한 턴은 재시도하고, 상한을 넘으면 failed로 멈춘다", async () => {
  const { runner, calls } = fakeRunner({
    override: (step) => (step === "frame" ? { status: "failed", error: "boom", output: null } : undefined),
  });
  const { store, orch } = setup("fail", runner);
  const result = await orch.run(orch.createStudy("q", null).id);
  assert.equal(result.status, "failed");
  assert.equal(calls.length, DEFAULT_LIMITS.maxAttemptsPerStep);
  assert.match(result.error!, /boom/);
  store.close();
});

test("직원 간 질문: 리서치 중 물은 질문을 상대가 답하고, 질문한 쪽이 메모를 고친다", async () => {
  let store!: Store;
  const { runner, calls } = fakeRunner({
    override: (step, spec) => {
      // 리서처 A가 리서치 턴 안에서 MCP 도구로 B에게 묻는 상황을 흉내 낸다
      if (step === "research" && spec.prompt.includes("너의 관점: 거시")) {
        const env = spec.mcp!.env;
        new OfficeTools(store, {
          studyId: env.NOVA_STUDY_ID!,
          employeeId: env.NOVA_EMPLOYEE_ID!,
          turnId: env.NOVA_TURN_ID!,
          turnKind: env.NOVA_TURN_KIND!,
          maxAsks: 2,
        }).askColleague("researcher-b", "개인 관점에서 전력 수요는?");
      }
      return undefined;
    },
  });
  const ctx = setup("asks", runner, { officeMcp: { command: "node", args: ["office.js"] } });
  store = ctx.store;
  const result = await ctx.orch.run(ctx.orch.createStudy("q", null).id);
  assert.equal(result.status, "completed", result.error ?? "");
  const steps = calls.map((c) => c.step);
  assert.ok(steps.includes("answer") && steps.includes("revise"));
  const answer = calls.find((c) => c.step === "answer")!;
  assert.equal(answer.spec.engine, "codex", "researcher-b(Codex)가 답한다");
  assert.ok(answer.spec.resumeSessionId, "자기 리서치 세션을 이어서 답한다");
  assert.equal(answer.spec.mcp, undefined, "답변 턴에는 메신저가 없다");
  assert.equal(calls.filter((c) => c.step === "revise").length, 1, "질문한 A만 고친다");
  const [ask] = store.asksFrom(result.id, "researcher-a");
  assert.equal(ask!.status, "answered");
  assert.match(answer.spec.prompt, /Q2 주장/, "답변 프롬프트에 자기 주장이 들어 있다");
  assert.match(calls.find((c) => c.step === "revise")!.spec.prompt, /Q1 주장/, "수정 프롬프트에 자기 메모가 들어 있다");
  store.close();
});

test("취소: 멈추면 paused, 보고서는 만들지 않는다", async () => {
  const controller = new AbortController();
  const { runner } = fakeRunner({
    override: (step) => {
      if (step === "research") {
        controller.abort();
        return { status: "cancelled", error: "취소됨", output: null };
      }
      return undefined;
    },
  });
  const { store, orch, dataDir } = setup("cancel", runner, { signal: controller.signal });
  const study = orch.createStudy("q", null);
  const result = await orch.run(study.id);
  assert.equal(result.status, "paused");
  assert.equal(existsSync(path.join(dataDir, "studies", study.id, "report.md")), false);
  store.close();
});
