import type { StudyStatus } from "../types";
import { STAGE_LABEL } from "../office/state";

export const STATUS_LABEL: Record<StudyStatus, string> = {
  running: "연구 중",
  paused: "멈춤",
  waiting_limit: "한도 대기",
  failed: "멈춤 (문제)",
  completed: "보고서 나옴",
};

export function stageLabel(stage: string): string {
  return STAGE_LABEL[stage] ?? stage;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}
