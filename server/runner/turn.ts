import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { resolveExecutable } from "./executables.js";
import { runProcess, type StopReason } from "./process.js";
import type { Engine, EngineAdapter, NormalizedEvent, TurnSpec } from "./types.js";

export type TurnStatus = "succeeded" | "failed" | "cancelled" | "rate_limited";

export interface TurnOutcome {
  status: TurnStatus;
  sessionId: string | null;
  /** 구조화 출력이면 객체(Codex는 JSON 문자열을 파싱한 값), 아니면 마지막 메시지 문자열 */
  output: unknown;
  error: string | null;
  exitCode: number | null;
  durationMs: number;
  /** 재개하려던 세션을 CLI가 찾지 못했다 → 새 세션으로 다시 시작해야 한다 */
  sessionMissing?: boolean;
}

// Codex: "no rollout found" (M0 스파이크 원본 기록), Claude: "No conversation found with session ID"
const SESSION_MISSING = /no rollout found|no conversation found|session .*not found/i;

export interface RunTurnOptions {
  deadlineMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  /** 이벤트마다 즉시 호출된다. session 이벤트를 받는 즉시 저장하는 데 쓴다 */
  onEvent: (event: NormalizedEvent) => void;
}

export const adapters: Record<Engine, EngineAdapter> = { claude: claudeAdapter, codex: codexAdapter };

function parseFinal(output: unknown, structured: boolean): unknown {
  if (!structured || typeof output !== "string") return output;
  try {
    return JSON.parse(output);
  } catch {
    return output; // 검증 단계에서 스키마 위반으로 걸린다
  }
}

/** 판정 규칙: 종료 코드 0 + 오류 이벤트 없음 + 최종 출력 있음 = 성공. 산출물 스키마 검증은 호출자가 한다. */
export function decideOutcome(input: {
  exitCode: number | null;
  stopReason: StopReason;
  handlerError?: Error | null;
  events: NormalizedEvent[];
}): { status: TurnStatus; error: string | null } {
  if (input.stopReason === "aborted") return { status: "cancelled", error: "취소됨" };
  if (input.stopReason === "handler_error") {
    return { status: "failed", error: `이벤트 처리 실패: ${input.handlerError?.message ?? "알 수 없음"}` };
  }
  if (input.stopReason === "deadline") return { status: "failed", error: "마감 시간 초과" };
  if (input.stopReason === "output_limit") return { status: "failed", error: "출력 크기 상한 초과" };
  const errors = input.events.filter((e): e is Extract<NormalizedEvent, { kind: "error" }> => e.kind === "error");
  if (errors.some((e) => e.rateLimited)) {
    return { status: "rate_limited", error: errors.find((e) => e.rateLimited)!.message };
  }
  if (input.exitCode !== 0) {
    return { status: "failed", error: errors.at(-1)?.message ?? `종료 코드 ${input.exitCode}` };
  }
  if (errors.length) return { status: "failed", error: errors.at(-1)!.message };
  if (!input.events.some((e) => e.kind === "final")) return { status: "failed", error: "최종 출력 없음" };
  return { status: "succeeded", error: null };
}

export async function runTurn(spec: TurnSpec, opts: RunTurnOptions): Promise<TurnOutcome> {
  const adapter = adapters[spec.engine];
  const exe = resolveExecutable(spec.engine);
  const parse = adapter.createParser();
  const events: NormalizedEvent[] = [];
  let sessionId = spec.resumeSessionId;
  const push = (event: NormalizedEvent) => {
    events.push(event);
    if (event.kind === "session") sessionId = event.sessionId;
    opts.onEvent(event);
  };

  const result = await runProcess({
    command: exe.command,
    args: [...exe.prefixArgs, ...adapter.buildArgs(spec)],
    cwd: spec.cwd,
    stdin: spec.prompt,
    deadlineMs: opts.deadlineMs,
    maxOutputBytes: opts.maxOutputBytes,
    signal: opts.signal,
    onLine: (line) => {
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return; // JSON이 아닌 줄(경고 등)은 버린다
      }
      for (const event of parse(raw)) push(event);
    },
  });
  if (result.exitCode !== 0 && !result.stopReason) {
    for (const event of adapter.classifyStderr(result.stderr)) push(event);
  }

  const { status, error } = decideOutcome({
    exitCode: result.exitCode,
    stopReason: result.stopReason,
    handlerError: result.handlerError,
    events,
  });
  const final = [...events].reverse().find((e) => e.kind === "final");
  return {
    status,
    sessionId,
    output: final?.kind === "final" ? parseFinal(final.output, Boolean(spec.outputSchema)) : null,
    error,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    sessionMissing: status === "failed" && Boolean(spec.resumeSessionId) && SESSION_MISSING.test(`${error ?? ""}
${result.stderr}`),
  };
}
