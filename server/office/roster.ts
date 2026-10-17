import type { Engine } from "../runner/types.js";

export type Role = "director" | "researcher" | "redteam" | "editor";

export interface Employee {
  id: string;
  label: string;
  role: Role;
  engine: Engine;
  model?: string;
  effort?: string;
  /** 리서처의 주장 ID 접두어 (A1, B2 …) */
  claimPrefix?: string;
}

/**
 * M1a 기본 직원 명단. 리서처의 관점(lens)은 고정하지 않고 소장이 질문에 맞춰 배정한다.
 * 리서처를 Claude·Codex로 섞는 것은 검색 결과가 실제로 달랐기 때문이다(spikes/m0/RESULTS.md).
 */
export const DEFAULT_ROSTER: Employee[] = [
  { id: "director", label: "소장", role: "director", engine: "claude", model: "sonnet" },
  { id: "researcher-a", label: "리서처 A", role: "researcher", engine: "claude", model: "sonnet", claimPrefix: "A" },
  { id: "researcher-b", label: "리서처 B", role: "researcher", engine: "codex", effort: "medium", claimPrefix: "B" },
  { id: "redteam", label: "레드팀", role: "redteam", engine: "codex", effort: "medium" },
  { id: "editor", label: "편집장", role: "editor", engine: "claude", model: "sonnet" },
];

export function researchers(roster: Employee[]): Employee[] {
  return roster.filter((e) => e.role === "researcher");
}

export function byRole(roster: Employee[], role: Role): Employee {
  const e = roster.find((x) => x.role === role);
  if (!e) throw new Error(`직원 명단에 ${role}가 없다`);
  return e;
}
