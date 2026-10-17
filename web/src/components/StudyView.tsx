import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { api, eventsSince, useStream } from "../api";
import { OfficeCanvas } from "../office/OfficeCanvas";
import { initialState, reduce, type OfficeState } from "../office/state";
import { createEventSync } from "../office/sync";
import type { Employee, EventMessage, RateInfo, Study } from "../types";
import { ActivityFeed } from "./ActivityFeed";
import { ArtifactPanel } from "./ArtifactPanel";
import { STATUS_LABEL, stageLabel } from "./labels";
import { RateMeter } from "./RateMeter";
import { ReflectionPanel } from "./ReflectionPanel";
import { ReportPanel } from "./ReportPanel";

type Action = { type: "batch"; msgs: EventMessage[] };

function officeReducer(state: OfficeState, action: Action): OfficeState {
  return action.msgs.reduce((s, m) => reduce(s, m), state);
}

/**
 * 연구가 돌고 있지 않은데 기록상 '일하는 중'으로 남은 직원은 멈춘 것으로 그린다.
 * (앱이 꺼졌다 켜졌거나 멈추기 직후 — 마지막 기록이 turn_started에서 끊긴 경우)
 */
function settle(state: OfficeState, running: boolean, completed: boolean): OfficeState {
  if (running && !completed) return state;
  const employees = Object.fromEntries(
    Object.entries(state.employees).map(([k, e]) => [k, e.status === "working" ? { ...e, status: "idle" as const, activity: null } : e]),
  );
  return { ...state, employees, stage: completed ? "done" : state.stage, prevStage: completed ? null : state.prevStage };
}

type Tab = "artifacts" | "report" | "reflection";
const TABS: { id: Tab; label: string }[] = [
  { id: "artifacts", label: "진행 중인 자료" },
  { id: "report", label: "보고서" },
  { id: "reflection", label: "사후 검토" },
];

export function StudyView({ id, roster, stages, initialRate }: { id: string; roster: Employee[]; stages: string[]; initialRate: RateInfo | null }) {
  const [study, setStudy] = useState<Study | null>(null);
  const [artifacts, setArtifacts] = useState<{ key: string; employee_id: string | null }[]>([]);
  const [office, dispatch] = useReducer(officeReducer, roster, initialState);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("artifacts");
  const [error, setError] = useState<string | null>(null);
  // 과거 기록과 실시간 스트림을 빈틈없이 이어 붙인다(office/sync.ts). 연구마다 하나.
  const sync = useMemo(
    () =>
      createEventSync({
        fetchSince: (after) => eventsSince(id, after),
        apply: (msgs) => dispatch({ type: "batch", msgs }),
        onError: (e) => setError(e.message),
      }),
    [id],
  );

  const refresh = useCallback(() => {
    api.study(id).then(
      (r) => {
        // 늦게 도착한 조회 응답이 스트림으로 받은 더 새로운 상태를 덮지 않게
        setStudy((prev) => (prev && prev.updated_at > r.study.updated_at ? prev : r.study));
        setArtifacts(r.artifacts);
      },
      (e: Error) => setError(e.message),
    );
  }, [id]);

  /** 처음 열 때와 스트림이 다시 붙을 때마다, 마지막으로 본 ID 뒤를 빠짐없이 받아 온다 */
  const catchUp = useCallback(() => {
    void sync.catchUp();
    refresh();
  }, [sync, refresh]);

  useEffect(() => {
    catchUp();
    sync.release();
  }, [sync, catchUp]);

  useStream(
    (msg) => {
      if (msg.type === "study") {
        if (msg.study.id === id) setStudy(msg.study);
        return;
      }
      if (msg.studyId !== id) return;
      sync.receive(msg);
      // 단계가 바뀌거나 턴이 끝나면 새 산출물이 생겼을 수 있다
      if (msg.event.kind === "stage" || msg.event.kind === "turn_finished") refresh();
    },
    catchUp,
  );

  useEffect(() => {
    if (study?.status === "completed") setTab((t) => (t === "artifacts" ? "report" : t));
  }, [study?.status]);

  const onSelect = useCallback((emp: string | null) => setSelected(emp), []);
  const rate = office.rate ?? initialRate;
  const tankHref = study?.thinktank_id ? `#/tank/${study.thinktank_id}` : "#/";
  const canResume = study && !study.running && study.status !== "completed";
  const selectedLabel = useMemo(() => roster.find((e) => e.id === selected)?.label ?? null, [roster, selected]);

  const [busy, setBusy] = useState(false);
  const act = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    fn()
      .then(refresh, (e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  if (!study) return error ? <p className="page-error">{error}</p> : null;
  return (
    <div className="study">
      <header className="study-head">
        <a className="back" href={tankHref}>
          연구 목록
        </a>
        <h1>{study.question}</h1>
        <p className={study.hypothesis ? "hypo" : "hypo hypo-empty"}>
          {study.hypothesis ? <>내 예상: {study.hypothesis}</> : "맡기기 전에 예상을 적지 않았습니다."}
        </p>
        <div className="study-bar">
          <span className={`status status-${study.status}`}>
            {STATUS_LABEL[study.status]}
            {study.status !== "completed" ? `, ${stageLabel(study.stage)} 단계` : ""}
          </span>
          {study.running ? (
            <button type="button" className="quiet" disabled={busy} onClick={() => act(() => api.pause(id))}>
              {busy ? "멈추는 중" : "멈추기"}
            </button>
          ) : null}
          {canResume ? (
            <button type="button" disabled={busy} onClick={() => act(() => api.resume(id))}>
              이어서 하기
            </button>
          ) : null}
          <RateMeter rate={rate} />
        </div>
        {study.error && study.status !== "completed" ? <p className="study-error">{study.error}</p> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </header>

      <section className="floor">
        {/* 완료 단계 이벤트가 없던 예전 연구도 완료로 그린다 */}
        <OfficeCanvas
          roster={roster}
          state={settle(office, study.running, study.status === "completed")}
          stages={stages}
          selected={selected}
          onSelect={onSelect}
        />
        <ActivityFeed roster={roster} feed={office.feed} selected={selected} selectedLabel={selectedLabel} onClear={() => setSelected(null)} />
      </section>

      <section className="desk">
        <div
          className="tabs"
          role="tablist"
          aria-label="연구 자료"
          onKeyDown={(e) => {
            // 탭 목록 안에서는 좌우 화살표로 옮겨 다닌다
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
            const i = TABS.findIndex((t) => t.id === tab);
            const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]!;
            setTab(next.id);
            document.getElementById(`tab-${next.id}`)?.focus();
          }}
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === "artifacts" ? <ArtifactPanel studyId={id} artifacts={artifacts} roster={roster} /> : null}
          {tab === "report" ? <ReportPanel studyId={id} completed={study.status === "completed"} version={study.updated_at} /> : null}
          {tab === "reflection" ? <ReflectionPanel study={study} onSaved={refresh} /> : null}
        </div>
      </section>
    </div>
  );
}
