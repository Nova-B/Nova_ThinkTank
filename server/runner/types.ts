export type Engine = "claude" | "codex";

/** 화면·로그·DB가 공통으로 쓰는 이벤트. 엔진별 원본 이벤트는 어댑터가 이 모양으로 바꾼다. */
export type NormalizedEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "tool_call"; tool: string; detail: string }
  | { kind: "tool_result"; tool: string; ok: boolean; detail?: string }
  | { kind: "message"; text: string }
  | {
      kind: "rate_limit";
      status: string;
      fiveHour?: number;
      sevenDay?: number;
      resetsAt?: number;
    }
  | {
      kind: "usage";
      inputTokens?: number;
      cachedInputTokens?: number;
      outputTokens?: number;
      costUsdEstimate?: number;
    }
  | { kind: "error"; message: string; rateLimited?: boolean }
  | { kind: "final"; output: unknown };

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** 직원이 호출할 수 있는 도구 이름(서버 접두어 없이) */
  tools: string[];
}

export interface TurnSpec {
  engine: Engine;
  cwd: string;
  prompt: string;
  /** 첫 턴이면 null. Claude는 미리 만든 ID를 newSessionId로 넘긴다 */
  resumeSessionId: string | null;
  newSessionId?: string;
  model?: string;
  effort?: string;
  instructions?: string;
  webSearch: boolean;
  mcp?: McpServerSpec;
  /** 최종 출력 JSON Schema. 있으면 구조화 출력을 요구한다 */
  outputSchema?: object;
  /** Codex --output-schema 는 파일 경로를 받는다 */
  outputSchemaFile?: string;
}

export interface EngineAdapter {
  engine: Engine;
  buildArgs(spec: TurnSpec): string[];
  createParser(): (raw: Record<string, unknown>) => NormalizedEvent[];
  /** 프로세스가 끝난 뒤 stderr로만 알 수 있는 오류(Codex) */
  classifyStderr(stderr: string): NormalizedEvent[];
}
