import { useEffect, useRef } from "react";
import type { Employee, EventMessage, RateInfo, Study, StudyMessage, ThinkTank } from "./types";

async function call<T>(path: string, init?: RequestInit & { body?: string }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `요청 실패 (${res.status})`);
  return data;
}

const post = <T>(path: string, body: unknown = {}) => call<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  meta: () => call<{ roster: Employee[]; stages: string[]; rate: RateInfo | null }>("/api/meta"),
  thinktanks: () => call<{ thinktanks: ThinkTank[]; unfiledCount: number }>("/api/thinktanks"),
  createThinkTank: (name: string, description: string) => post<{ thinktank: ThinkTank }>("/api/thinktanks", { name, description }),
  studies: (thinktank: string | "none") => call<{ studies: Study[] }>(`/api/studies?thinktank=${encodeURIComponent(thinktank)}`),
  createStudy: (input: { question: string; hypothesis: string | null; thinktankId: string | null }) =>
    post<{ study: Study }>("/api/studies", input),
  study: (id: string) =>
    call<{
      study: Study;
      artifacts: { key: string; employee_id: string | null; created_at: string }[];
      asks: { id: string; from_employee: string; to_employee: string; question: string; status: string; answer: string | null }[];
    }>(`/api/studies/${id}`),
  events: (id: string, after = 0) => call<{ events: EventMessage[]; more: boolean }>(`/api/studies/${id}/events?after=${after}`),
  artifact: (id: string, key: string) => call<{ key: string; value: unknown }>(`/api/studies/${id}/artifacts/${encodeURIComponent(key)}`),
  report: (id: string) => call<{ markdown: string; path: string }>(`/api/studies/${id}/report`),
  pause: (id: string) => post(`/api/studies/${id}/pause`),
  resume: (id: string) => post(`/api/studies/${id}/resume`),
  reflection: (id: string, text: string) => post<{ ok: boolean; reportUpdated: boolean }>(`/api/studies/${id}/reflection`, { text }),
};

/** 마지막으로 본 ID 뒤의 기록을 끝까지(페이지를 넘겨 가며) 받는다 */
export async function eventsSince(id: string, after: number): Promise<EventMessage[]> {
  const all: EventMessage[] = [];
  let cursor = after;
  for (;;) {
    const page = await api.events(id, cursor);
    all.push(...page.events);
    if (!page.more || page.events.length === 0) return all;
    cursor = page.events.at(-1)!.id;
  }
}

/**
 * 서버 이벤트 스트림 하나를 앱 전체가 나눠 쓴다. EventSource는 끊기면 알아서 다시 붙지만
 * 끊겨 있던 동안의 이벤트는 다시 보내 주지 않는다 → onOpen에서 화면이 직접 기록을 보충한다.
 */
let source: EventSource | null = null;
const listeners = new Set<(msg: EventMessage | StudyMessage) => void>();
const openListeners = new Set<() => void>();

export function useStream(onMessage: (msg: EventMessage | StudyMessage) => void, onOpen?: () => void): void {
  const ref = useRef(onMessage);
  ref.current = onMessage;
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  useEffect(() => {
    const listener = (msg: EventMessage | StudyMessage) => ref.current(msg);
    const openListener = () => openRef.current?.();
    listeners.add(listener);
    openListeners.add(openListener);
    if (!source) {
      source = new EventSource("/api/stream");
      source.onmessage = (e) => {
        const msg = JSON.parse(e.data) as EventMessage | StudyMessage;
        for (const l of listeners) l(msg);
      };
      source.onopen = () => {
        for (const l of openListeners) l();
      };
    }
    return () => {
      listeners.delete(listener);
      openListeners.delete(openListener);
    };
  }, []);
}
