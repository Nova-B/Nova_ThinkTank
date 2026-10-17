import { useEffect, useMemo, useRef } from "react";
import type { Employee } from "../types";
import { PLAN_H, PLAN_W, ROOMS, WHITEBOARD, seatRoster, type Seat } from "./layout";
import type { EmployeeState, OfficeState } from "./state";

// 화이트보드는 좁아서 짧은 이름을 쓴다
const BOARD_LABEL: Record<string, string> = {
  frame: "설계",
  research: "조사",
  asks: "질문",
  revise: "수정",
  redteam: "레드팀",
  edit: "편집",
  done: "완료",
};

interface Props {
  roster: Employee[];
  state: OfficeState;
  stages: string[];
  selected: string | null;
  onSelect: (id: string | null) => void;
}

interface Palette {
  paper: string;
  grid: string;
  ink: string;
  muted: string;
  red: string;
  highlight: string;
  note: string;
}

const WALK_MS = 7000;
const BUBBLE_MS = 25_000;
const TOKEN_R = 22;

function readPalette(el: HTMLElement): Palette {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    paper: v("--paper"),
    grid: v("--grid"),
    ink: v("--ink"),
    muted: v("--muted"),
    red: v("--red"),
    highlight: v("--highlight"),
    note: v("--note"),
  };
}

const VERB: Record<string, string> = {
  search: "검색",
  read: "읽기",
  ask: "질문",
  writing: "작성",
  warning: "주의",
};

function truncate(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > max) t = t.slice(0, -1);
  return t + "…";
}

/** 걸어가기: 0~35% 이동, 35~65% 상대 자리에서 대화, 65~100% 돌아오기 */
function walkOffset(seat: Seat, target: Seat | undefined, elapsed: number, reduced: boolean): { x: number; y: number } {
  if (!target) return { x: seat.x, y: seat.y };
  const stand = { x: target.x - 46, y: target.y - 6 };
  if (reduced) return elapsed < WALK_MS ? stand : { x: seat.x, y: seat.y };
  const p = elapsed / WALK_MS;
  const ease = (t: number) => t * t * (3 - 2 * t);
  let k: number;
  if (p < 0.35) k = ease(p / 0.35);
  else if (p < 0.65) k = 1;
  else k = 1 - ease((p - 0.65) / 0.35);
  return { x: seat.x + (stand.x - seat.x) * k, y: seat.y + (stand.y - seat.y) * k };
}

function drawPlan(ctx: CanvasRenderingContext2D, pal: Palette) {
  ctx.fillStyle = pal.paper;
  ctx.fillRect(0, 0, PLAN_W, PLAN_H);
  // 모눈
  ctx.strokeStyle = pal.grid;
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  for (let x = 0; x <= PLAN_W; x += 20) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, PLAN_H);
  }
  for (let y = 0; y <= PLAN_H; y += 20) {
    ctx.moveTo(0, y);
    ctx.lineTo(PLAN_W, y);
  }
  ctx.stroke();

  // 벽을 모두 그린 뒤에 문을 낸다. 붙어 있는 방이 같은 벽을 다시 그려 문틈을 덮지 않게.
  for (const room of ROOMS.filter((r) => r.tone !== "red")) {
    ctx.strokeStyle = pal.ink;
    ctx.lineWidth = 4;
    ctx.strokeRect(room.x, room.y, room.w, room.h);
  }
  for (const room of ROOMS.filter((r) => r.tone === "red")) {
    ctx.strokeStyle = pal.red;
    ctx.lineWidth = 4;
    ctx.strokeRect(room.x, room.y, room.w, room.h);
  }
  for (const room of ROOMS) {
    // 문: 경첩(d.x, d.y)에서 벽을 따라 문 폭만큼 지우고, 방 안쪽으로 연 문짝과 여닫이 호를 그린다
    for (const d of room.doors) {
      const span = 34;
      const along = d.wall === "top" || d.wall === "bottom" ? { x: -1, y: 0 } : { x: 0, y: -1 };
      const inward = { top: { x: 0, y: 1 }, bottom: { x: 0, y: -1 }, left: { x: 1, y: 0 }, right: { x: -1, y: 0 } }[d.wall];
      ctx.strokeStyle = pal.paper;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x + along.x * span, d.y + along.y * span);
      ctx.stroke();
      const a1 = Math.atan2(inward.y, inward.x);
      const a2 = Math.atan2(along.y, along.x);
      let diff = a2 - a1;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      ctx.strokeStyle = room.tone === "red" ? pal.red : pal.ink;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x + inward.x * span, d.y + inward.y * span);
      ctx.arc(d.x, d.y, span, a1, a2, diff < 0);
      ctx.stroke();
    }
    ctx.fillStyle = room.tone === "red" ? pal.red : pal.muted;
    ctx.font = "500 13px 'IBM Plex Sans KR', sans-serif";
    ctx.textBaseline = "top";
    ctx.fillText(room.name, room.x + 12, room.y + room.h - 24);
  }
}

function drawWhiteboard(ctx: CanvasRenderingContext2D, pal: Palette, stages: string[], current: string | null) {
  const wb = WHITEBOARD;
  ctx.fillStyle = pal.note;
  ctx.fillRect(wb.x, wb.y, wb.w, wb.h);
  ctx.strokeStyle = pal.ink;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(wb.x, wb.y, wb.w, wb.h);
  const shown = stages.filter((s) => s !== "render");
  const idx = current ? shown.indexOf(current === "render" ? "edit" : current) : -1;
  const step = wb.w / shown.length;
  shown.forEach((s, i) => {
    const cx = wb.x + step * i + step / 2;
    const cy = wb.y + 22;
    const done = idx > i || current === "done";
    const now = idx === i && current !== "done";
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = s === "redteam" ? pal.red : pal.ink;
    if (now) {
      ctx.fillStyle = pal.highlight;
      ctx.fill();
    }
    ctx.stroke();
    if (done) {
      ctx.beginPath();
      ctx.moveTo(cx - 4, cy);
      ctx.lineTo(cx - 1, cy + 3);
      ctx.lineTo(cx + 4, cy - 4);
      ctx.stroke();
    }
    if (i < shown.length - 1) {
      ctx.beginPath();
      ctx.moveTo(cx + 9, cy);
      ctx.lineTo(cx + step - 9, cy);
      ctx.strokeStyle = pal.grid;
      ctx.stroke();
    }
    ctx.fillStyle = now ? pal.ink : pal.muted;
    ctx.font = `${now ? 600 : 400} 11px 'IBM Plex Sans KR', sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(BOARD_LABEL[s] ?? s, cx, cy + 14);
    ctx.textAlign = "left";
  });
}

function drawDesk(ctx: CanvasRenderingContext2D, pal: Palette, seat: Seat) {
  const d = seat.desk;
  ctx.fillStyle = pal.paper;
  ctx.fillRect(d.x, d.y, d.w, d.h);
  ctx.strokeStyle = seat.employee.role === "redteam" ? pal.red : pal.ink;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(d.x, d.y, d.w, d.h);
  // 모니터
  ctx.strokeRect(d.x + d.w / 2 - 16, d.y + 6, 32, 6);
}

function drawToken(
  ctx: CanvasRenderingContext2D,
  pal: Palette,
  seat: Seat,
  emp: EmployeeState | undefined,
  pos: { x: number; y: number },
  t: number,
  selected: boolean,
  reduced: boolean,
) {
  const e = seat.employee;
  const stroke = e.role === "redteam" ? pal.red : pal.ink;
  const shape = () => {
    ctx.beginPath();
    // 엔진을 모양으로 구분한다: Claude는 원, Codex는 모서리 둥근 사각형
    if (e.engine === "claude") ctx.arc(pos.x, pos.y, TOKEN_R, 0, Math.PI * 2);
    else ctx.roundRect(pos.x - TOKEN_R, pos.y - TOKEN_R, TOKEN_R * 2, TOKEN_R * 2, 7);
  };

  if (emp?.status === "working") {
    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.lineDashOffset = reduced ? 0 : -t / 60;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, TOKEN_R + 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  shape();
  ctx.fillStyle = pal.paper;
  ctx.fill();
  ctx.lineWidth = selected ? 4 : 2;
  ctx.strokeStyle = stroke;
  ctx.stroke();

  ctx.fillStyle = stroke;
  ctx.font = "600 15px 'IBM Plex Sans KR', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const initial = e.role === "researcher" ? e.label.slice(-1) : e.label.slice(0, 1);
  ctx.fillText(initial, pos.x, pos.y + 1);

  ctx.textBaseline = "top";
  ctx.font = "500 13px 'IBM Plex Sans KR', sans-serif";
  ctx.fillStyle = pal.ink;
  ctx.fillText(e.label, pos.x, pos.y + TOKEN_R + 8);
  ctx.font = "400 11px 'IBM Plex Sans KR', sans-serif";
  ctx.fillStyle = pal.muted;
  const statusText =
    emp?.status === "waiting" ? "한도 대기" : emp?.status === "error" ? "문제 생김" : e.engine === "claude" ? "Claude" : "Codex";
  if (emp?.status === "error" || emp?.status === "waiting") ctx.fillStyle = pal.red;
  ctx.fillText(statusText, pos.x, pos.y + TOKEN_R + 25);
  ctx.textAlign = "left";

  if (emp?.status === "done") {
    ctx.strokeStyle = pal.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pos.x + 15, pos.y - 20);
    ctx.lineTo(pos.x + 20, pos.y - 14);
    ctx.lineTo(pos.x + 30, pos.y - 28);
    ctx.stroke();
  }
}

function drawBubble(ctx: CanvasRenderingContext2D, pal: Palette, pos: { x: number; y: number }, emp: EmployeeState, now: number, isRed: boolean) {
  const a = emp.activity;
  if (!a || emp.status !== "working" || now - a.at > BUBBLE_MS) return;
  const verb = VERB[a.kind] ?? null;
  ctx.font = "400 12px 'IBM Plex Sans KR', sans-serif";
  // 리서처 책상 간격(약 180)보다 좁게 해 옆 사람 쪽지와 겹치지 않게 한다
  const maxW = 140;
  const body = truncate(ctx, a.text, maxW - (verb ? 40 : 0));
  ctx.font = "600 12px 'IBM Plex Sans KR', sans-serif";
  const verbW = verb ? ctx.measureText(verb).width + 8 : 0;
  ctx.font = "400 12px 'IBM Plex Sans KR', sans-serif";
  const w = Math.min(maxW + 20, verbW + ctx.measureText(body).width + 20);
  const h = 28;
  const x = Math.max(8, Math.min(PLAN_W - w - 8, pos.x - w / 2));
  const y = pos.y - TOKEN_R - h - 18;
  // 종이 쪽지
  ctx.fillStyle = pal.note;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = isRed ? pal.red : pal.ink;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
  ctx.beginPath();
  ctx.moveTo(pos.x - 5, y + h);
  ctx.lineTo(pos.x, y + h + 8);
  ctx.lineTo(pos.x + 5, y + h);
  ctx.fillStyle = pal.note;
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = pal.note;
  ctx.fillRect(pos.x - 4, y + h - 1, 8, 2);

  let tx = x + 10;
  ctx.textBaseline = "middle";
  if (verb) {
    // 지금 하는 일은 형광펜으로 칠한다
    ctx.fillStyle = a.kind === "warning" ? pal.red : pal.highlight;
    ctx.fillRect(tx - 3, y + 7, verbW - 2, h - 14);
    ctx.fillStyle = a.kind === "warning" ? pal.paper : pal.ink;
    ctx.font = "600 12px 'IBM Plex Sans KR', sans-serif";
    ctx.fillText(verb, tx, y + h / 2 + 1);
    tx += verbW;
  }
  ctx.fillStyle = pal.ink;
  ctx.font = "400 12px 'IBM Plex Sans KR', sans-serif";
  ctx.fillText(body, tx, y + h / 2 + 1);
}

export function OfficeCanvas({ roster, state, stages, selected, onSelect }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const seats = useMemo(() => seatRoster(roster), [roster]);
  const bySeat = useMemo(() => new Map(seats.map((x) => [x.employee.id, x])), [seats]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext("2d")!;
    const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let scale = 1;
    let raf = 0;

    // 평면도(모눈·벽·문·책상)는 바뀌지 않으니 한 번 그려 두고, 크기나 색 모드가 바뀔 때만 다시 그린다.
    // 색은 CSS 변수에서 읽는데, 매 프레임 getComputedStyle을 부르면 비싸다.
    const backdrop = document.createElement("canvas");
    const bctx = backdrop.getContext("2d")!;
    let pal = readPalette(wrap);
    const paintBackdrop = () => {
      const dpr = window.devicePixelRatio || 1;
      backdrop.width = canvas.width;
      backdrop.height = canvas.height;
      bctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
      drawPlan(bctx, pal);
      for (const seat of seats) drawDesk(bctx, pal, seat);
    };
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = wrap.clientWidth;
      scale = width / PLAN_W;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(PLAN_H * scale * dpr);
      canvas.style.height = `${PLAN_H * scale}px`;
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
      paintBackdrop();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => {
      pal = readPalette(wrap);
      paintBackdrop();
    };
    darkQuery.addEventListener("change", onScheme);
    resize();
    // 클릭 판정은 그려진 실제 위치(걸어가는 중이면 이동한 자리)로 한다
    let positions = new Map<string, { x: number; y: number }>();

    const frame = (t: number) => {
      const s = stateRef.current;
      const now = Date.now();
      const reduced = reducedQuery.matches;
      ctx.drawImage(backdrop, 0, 0, PLAN_W, PLAN_H);
      drawWhiteboard(ctx, pal, stages, s.stage);
      positions = new Map<string, { x: number; y: number }>();
      for (const seat of seats) {
        const walk = [...s.walks].reverse().find((w) => w.from === seat.employee.id && now - w.at < WALK_MS);
        positions.set(seat.employee.id, walk ? walkOffset(seat, bySeat.get(walk.to), now - walk.at, reduced) : { x: seat.x, y: seat.y });
      }
      // 질문 중인 두 사람 사이에 점선
      for (const w of s.walks) {
        if (now - w.at > WALK_MS) continue;
        const a = positions.get(w.from);
        const b = bySeat.get(w.to);
        if (!a || !b) continue;
        ctx.save();
        ctx.setLineDash([3, 6]);
        ctx.strokeStyle = pal.muted;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.restore();
      }
      for (const seat of seats) {
        const pos = positions.get(seat.employee.id)!;
        drawToken(ctx, pal, seat, s.employees[seat.employee.id], pos, t, selectedRef.current === seat.employee.id, reduced);
      }
      for (const seat of seats) {
        const emp = s.employees[seat.employee.id];
        if (emp) drawBubble(ctx, pal, positions.get(seat.employee.id)!, emp, now, seat.employee.role === "redteam");
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const onClick = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = (ev.clientX - rect.left) / scale;
      const y = (ev.clientY - rect.top) / scale;
      const hit = seats.find((s) => {
        const p = positions.get(s.employee.id) ?? s;
        return Math.hypot(p.x - x, p.y - y) < TOKEN_R + 10 || (x >= s.desk.x && x <= s.desk.x + s.desk.w && y >= s.desk.y && y <= s.desk.y + s.desk.h);
      });
      onSelect(hit && hit.employee.id !== selectedRef.current ? hit.employee.id : null);
    };
    canvas.addEventListener("click", onClick);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      darkQuery.removeEventListener("change", onScheme);
      canvas.removeEventListener("click", onClick);
    };
  }, [seats, bySeat, stages, onSelect]);

  const summary = roster
    .map((e) => {
      const s = state.employees[e.id];
      const what = s?.status === "working" ? (s.activity?.text ?? "일하는 중") : s?.status === "done" ? "할 일 마침" : s?.status === "error" ? "문제 생김" : s?.status === "waiting" ? "한도 대기" : "대기";
      return `${e.label}: ${what}`;
    })
    .join(". ");

  return (
    <div className="plan" ref={wrapRef}>
      <canvas ref={canvasRef} role="img" aria-label={`연구소 평면도. ${summary}`} />
      {/* 캔버스를 못 보는 경우를 위한 같은 내용의 목록. 키보드로 직원을 고를 수도 있다 */}
      <ul className="plan-roster">
        {roster.map((e) => (
          <li key={e.id}>
            <button type="button" aria-pressed={selected === e.id} onClick={() => onSelect(selected === e.id ? null : e.id)}>
              {e.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
