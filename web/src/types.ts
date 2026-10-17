// 서버 응답 모양. 서버 코드(node 전용)를 화면 번들로 끌어오지 않으려고 따로 적는다.

export type Engine = "claude" | "codex";
export type Role = "director" | "researcher" | "redteam" | "editor";

export interface Employee {
  id: string;
  label: string;
  role: Role;
  engine: Engine;
  model?: string;
  effort?: string;
}

export type StudyStatus = "running" | "paused" | "waiting_limit" | "failed" | "completed";

export interface Study {
  id: string;
  thinktank_id: string | null;
  question: string;
  hypothesis: string | null;
  status: StudyStatus;
  stage: string;
  error: string | null;
  report_path: string | null;
  reflection: string | null;
  created_at: string;
  updated_at: string;
  running: boolean;
}

export interface ThinkTank {
  id: string;
  name: string;
  description: string;
  created_at: string;
  studyCount: number;
}

export interface RateInfo {
  status: string;
  fiveHour?: number;
  sevenDay?: number;
  resetsAt?: number;
}

export type OfficeEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "tool_call"; tool: string; detail: string; target?: string }
  | { kind: "tool_result"; tool: string; ok: boolean }
  | { kind: "message"; text: string }
  | ({ kind: "rate_limit" } & RateInfo)
  | { kind: "usage"; inputTokens?: number; outputTokens?: number; costUsdEstimate?: number }
  | { kind: "error"; message: string; rateLimited?: boolean }
  | { kind: "final"; output: unknown }
  | { kind: "turn_started"; step: string; attempt: number }
  | { kind: "turn_finished"; step: string; status: string; error: string | null; durationMs: number }
  | { kind: "stage"; stage: string };

export interface EventMessage {
  type: "event";
  id: number;
  studyId: string;
  employeeId: string | null;
  event: OfficeEvent;
  /** 과거 기록에만 있다. 실시간 이벤트는 받은 시각을 쓴다 */
  at?: string;
}

export interface StudyMessage {
  type: "study";
  study: Study;
}
