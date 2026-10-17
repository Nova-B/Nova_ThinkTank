// 이벤트 스트림 → 사무실 화면 상태. 순수 함수라 과거 기록을 처음부터 다시 돌려도 같은 화면이 나온다.
import type { Employee, EventMessage, RateInfo } from "../types";

export type Activity =
  | "thinking"
  | "search"
  | "read"
  | "ask"
  | "writing"
  | "warning";

export type EmployeeStatus = "idle" | "working" | "done" | "error" | "waiting";

export interface EmployeeState {
  id: string;
  status: EmployeeStatus;
  step: string | null;
  activity: { kind: Activity; text: string; at: number } | null;
  toolCalls: number;
  turns: number;
  lastError: string | null;
}

export interface Walk {
  from: string;
  to: string;
  question: string;
  at: number;
}

export interface FeedItem {
  id: number;
  at: number;
  employeeId: string | null;
  tone: "normal" | "tool" | "warn" | "stage" | "done";
  text: string;
}

export interface OfficeState {
  lastEventId: number;
  stage: string | null;
  employees: Record<string, EmployeeState>;
  walks: Walk[];
  feed: FeedItem[];
  rate: RateInfo | null;
}

const MAX_FEED = 400;

export const STEP_LABEL: Record<string, string> = {
  frame: "질문을 다듬는 중",
  research: "조사하는 중",
  answer: "동료 질문에 답하는 중",
  revise: "메모를 고치는 중",
  "redteam:sources": "출처를 따져 보는 중",
  "redteam:critique": "반론을 쓰는 중",
  edit: "보고서를 쓰는 중",
};

export const STAGE_LABEL: Record<string, string> = {
  frame: "질문 다듬기",
  research: "조사",
  asks: "동료 질문",
  revise: "메모 수정",
  redteam: "레드팀",
  edit: "편집",
  render: "보고서",
  done: "완료",
};

const STEP_NOUN: Record<string, string> = {
  frame: "질문 다듬기",
  research: "조사",
  answer: "동료 질문 답변",
  revise: "메모 수정",
  "redteam:sources": "출처 평가",
  "redteam:critique": "반론 작성",
  edit: "보고서 작성",
};

function stepNoun(step: string): string {
  return STEP_NOUN[step] ?? STEP_NOUN[step.split(":")[0]!] ?? step;
}

export function stepLabel(step: string): string {
  return STEP_LABEL[step] ?? STEP_LABEL[step.split(":")[0]!] ?? step;
}

function toolActivity(tool: string): { kind: Activity; verb: string } {
  if (tool === "WebSearch" || tool === "web_search") return { kind: "search", verb: "검색" };
  if (tool === "WebFetch" || tool === "web_open") return { kind: "read", verb: "읽기" };
  if (tool.includes("ask_colleague")) return { kind: "ask", verb: "동료에게 질문" };
  if (tool.includes("check_answers")) return { kind: "ask", verb: "답 확인" };
  return { kind: "warning", verb: tool };
}

export function initialState(roster: Employee[]): OfficeState {
  const employees: Record<string, EmployeeState> = {};
  for (const e of roster) {
    employees[e.id] = { id: e.id, status: "idle", step: null, activity: null, toolCalls: 0, turns: 0, lastError: null };
  }
  return { lastEventId: 0, stage: null, employees, walks: [], feed: [], rate: null };
}

export function reduce(state: OfficeState, msg: EventMessage, now = Date.now()): OfficeState {
  // 과거 기록과 실시간 스트림이 겹치는 구간의 중복을 버린다. id 0은 DB에 없는 알림(실행 오류)
  if (msg.id !== 0 && msg.id <= state.lastEventId) return state;
  const at = msg.at ? Date.parse(msg.at) : now;
  const ev = msg.event;
  const next: OfficeState = { ...state, lastEventId: Math.max(state.lastEventId, msg.id) };
  const empId = msg.employeeId;
  const prev = empId ? state.employees[empId] : undefined;
  const setEmp = (patch: Partial<EmployeeState>) => {
    if (!empId || !prev) return;
    next.employees = { ...next.employees, [empId]: { ...prev, ...patch } };
  };
  const feed = (tone: FeedItem["tone"], text: string) => {
    next.feed = [...state.feed, { id: msg.id, at, employeeId: empId, tone, text }].slice(-MAX_FEED);
  };

  switch (ev.kind) {
    case "stage":
      next.stage = ev.stage;
      feed("stage", STAGE_LABEL[ev.stage] ?? ev.stage);
      break;
    case "turn_started":
      setEmp({
        status: "working",
        step: ev.step,
        activity: { kind: "thinking", text: stepLabel(ev.step), at },
        turns: (prev?.turns ?? 0) + 1,
        lastError: null,
      });
      feed("normal", `${stepNoun(ev.step)} 시작${ev.attempt > 1 ? ` (${ev.attempt}번째)` : ""}`);
      break;
    case "tool_call": {
      const { kind, verb } = toolActivity(ev.tool);
      setEmp({ activity: { kind, text: ev.detail || verb, at }, toolCalls: (prev?.toolCalls ?? 0) + 1 });
      if (kind === "ask" && ev.target && empId) {
        next.walks = [...state.walks.filter((w) => now - w.at < 60_000), { from: empId, to: ev.target, question: ev.detail, at }];
      }
      feed("tool", `${verb}${ev.detail ? `: ${ev.detail}` : ""}`);
      break;
    }
    case "tool_result":
      if (!ev.ok) {
        setEmp({ activity: { kind: "warning", text: `${toolActivity(ev.tool).verb} 실패`, at } });
        feed("warn", `${toolActivity(ev.tool).verb} 실패`);
      }
      break;
    case "message":
      // 생각을 글로 쓰는 중. 피드에는 남기지 않는다(최종 산출물과 겹치고 길다)
      setEmp({ activity: { kind: "writing", text: "글을 쓰는 중", at } });
      break;
    case "turn_finished": {
      const status: EmployeeStatus =
        ev.status === "succeeded" ? "done" : ev.status === "rate_limited" ? "waiting" : ev.status === "cancelled" ? "idle" : "error";
      setEmp({ status, activity: null, lastError: ev.error });
      const secs = Math.round(ev.durationMs / 1000);
      const verdict =
        ev.status === "succeeded" ? "마침" : ev.status === "rate_limited" ? "한도에 걸림" : ev.status === "cancelled" ? "멈춤" : "실패";
      feed(ev.status === "succeeded" ? "done" : "warn", `${stepNoun(ev.step)} ${verdict} (${secs}초)${ev.error ? ` — ${ev.error}` : ""}`);
      break;
    }
    case "error":
      if (prev) setEmp({ lastError: ev.message });
      feed("warn", ev.message);
      break;
    case "rate_limit":
      next.rate = { status: ev.status, fiveHour: ev.fiveHour, sevenDay: ev.sevenDay, resetsAt: ev.resetsAt };
      break;
    default:
      break;
  }
  return next;
}
