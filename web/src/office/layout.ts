// 평면도 좌표. 논리 크기 1000×620 위에 그리고, 화면 폭에 맞춰 늘리고 줄인다.
import type { Employee, Role } from "../types";

export const PLAN_W = 1000;
export const PLAN_H = 620;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Room extends Rect {
  name: string;
  /** 레드팀 방은 벽을 빨간 연필색으로 그린다 */
  tone: "ink" | "red";
  /** 문: 벽 위의 위치와 여는 방향. 평면도의 문 호(arc)로 그린다 */
  doors: { x: number; y: number; wall: "top" | "bottom" | "left" | "right" }[];
}

export const ROOMS: Room[] = [
  { name: "소장실", x: 20, y: 20, w: 220, h: 200, tone: "ink", doors: [{ x: 190, y: 220, wall: "bottom" }] },
  { name: "로비", x: 240, y: 20, w: 330, h: 200, tone: "ink", doors: [] },
  { name: "연구실", x: 20, y: 220, w: 550, h: 380, tone: "ink", doors: [{ x: 420, y: 220, wall: "top" }] },
  { name: "레드팀실", x: 590, y: 20, w: 390, h: 280, tone: "red", doors: [{ x: 590, y: 150, wall: "left" }] },
  { name: "편집실", x: 590, y: 320, w: 390, h: 280, tone: "ink", doors: [{ x: 590, y: 470, wall: "left" }] },
];

export const WHITEBOARD: Rect = { x: 268, y: 40, w: 274, h: 64 };

export interface Seat {
  employee: Employee;
  /** 책상 */
  desk: Rect;
  /** 직원 토큰이 앉는 자리 */
  x: number;
  y: number;
}

const DESK_W = 96;
const DESK_H = 40;

function deskAt(cx: number, cy: number): Rect {
  return { x: cx - DESK_W / 2, y: cy - DESK_H / 2, w: DESK_W, h: DESK_H };
}

/** 역할별로 방을 정하고, 리서처가 몇 명이든 연구실에 고르게 앉힌다 */
export function seatRoster(roster: Employee[]): Seat[] {
  const fixed: Partial<Record<Role, { x: number; y: number }>> = {
    director: { x: 130, y: 88 },
    redteam: { x: 785, y: 150 },
    editor: { x: 785, y: 450 },
  };
  const researchers = roster.filter((e) => e.role === "researcher");
  const seats: Seat[] = [];
  const perRow = Math.min(researchers.length, 3) || 1;
  researchers.forEach((e, i) => {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const cx = 20 + (550 / (perRow + 1)) * (col + 1);
    const cy = 340 + row * 140;
    seats.push({ employee: e, desk: deskAt(cx, cy), x: cx, y: cy + 52 });
  });
  for (const e of roster) {
    const pos = fixed[e.role];
    if (!pos || e.role === "researcher") continue;
    seats.push({ employee: e, desk: deskAt(pos.x, pos.y), x: pos.x, y: pos.y + 52 });
  }
  return seats;
}
