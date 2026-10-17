import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, useStream } from "../api";
import type { Study, ThinkTank } from "../types";
import { STATUS_LABEL, formatDate, stageLabel } from "./labels";

export function Lobby({ tank }: { tank: string | null }) {
  const [tanks, setTanks] = useState<ThinkTank[]>([]);
  const [unfiled, setUnfiled] = useState(0);
  const [studies, setStudies] = useState<Study[]>([]);
  const [error, setError] = useState<string | null>(null);
  const current = tank ?? "none";
  const tankInfo = tanks.find((t) => t.id === tank);

  const load = useCallback(() => {
    api.thinktanks().then((r) => {
      setTanks(r.thinktanks);
      setUnfiled(r.unfiledCount);
    }, (e: Error) => setError(e.message));
    api.studies(current).then((r) => setStudies(r.studies), (e: Error) => setError(e.message));
  }, [current]);
  useEffect(load, [load]);

  // 다른 화면이나 터미널에서 시작한 연구의 상태도 바로 반영한다
  useStream((msg) => {
    if (msg.type !== "study") return;
    const s = msg.study;
    const belongs = current === "none" ? s.thinktank_id === null : s.thinktank_id === current;
    setStudies((list) =>
      list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : belongs ? [s, ...list] : list,
    );
  });

  return (
    <div className="lobby">
      <header className="lobby-head">
        <h1>Nova ThinkTank</h1>
        <p>질문을 맡기면 AI 연구원들이 조사하고, 반박하고, 보고서로 정리합니다. 판단은 직접 합니다.</p>
      </header>
      <div className="lobby-body">
        <nav className="tanks" aria-label="연구소">
          <h2>연구소</h2>
          <ul>
            {tanks.map((t) => (
              <li key={t.id}>
                <a href={`#/tank/${t.id}`} aria-current={tank === t.id ? "page" : undefined}>
                  <span>{t.name}</span>
                  <span className="count">{t.studyCount}</span>
                </a>
              </li>
            ))}
            <li>
              <a href="#/" aria-current={tank === null ? "page" : undefined}>
                <span>분류 없음</span>
                <span className="count">{unfiled}</span>
              </a>
            </li>
          </ul>
          <NewTankForm onCreated={(t) => (location.hash = `#/tank/${t.id}`)} onError={setError} />
        </nav>
        <main className="studies">
          {tankInfo?.description ? <p className="tank-desc">{tankInfo.description}</p> : null}
          <NewStudyForm thinktankId={tank} onError={setError} />
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <h2>{tankInfo ? `${tankInfo.name}의 연구` : "분류 없는 연구"}</h2>
          {studies.length === 0 ? (
            <p className="empty">아직 맡긴 연구가 없습니다. 위에서 첫 질문을 맡겨 보세요.</p>
          ) : (
            <ol className="study-list">
              {studies.map((s) => (
                <li key={s.id}>
                  <a href={`#/study/${s.id}`}>
                    <span className="q">{s.question}</span>
                    <span className={`status status-${s.status}`}>
                      {STATUS_LABEL[s.status]}
                      {s.status === "running" ? `, ${stageLabel(s.stage)}` : ""}
                    </span>
                    <span className="date">{formatDate(s.created_at)}</span>
                  </a>
                </li>
              ))}
            </ol>
          )}
        </main>
      </div>
    </div>
  );
}

function NewTankForm({ onCreated, onError }: { onCreated: (t: ThinkTank) => void; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    api.createThinkTank(name, desc).then(
      (r) => {
        setOpen(false);
        setName("");
        setDesc("");
        onCreated(r.thinktank);
      },
      (err: Error) => onError(err.message),
    );
  };
  if (!open) {
    return (
      <button type="button" className="quiet" onClick={() => setOpen(true)}>
        새 연구소 만들기
      </button>
    );
  }
  return (
    <form className="tank-form" onSubmit={submit}>
      <label>
        이름
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} placeholder="예: AI와 에너지" />
      </label>
      <label>
        무엇을 탐구하나요
        <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} maxLength={500} />
      </label>
      <div className="row">
        <button type="submit">만들기</button>
        <button type="button" className="quiet" onClick={() => setOpen(false)}>
          취소
        </button>
      </div>
    </form>
  );
}

function NewStudyForm({ thinktankId, onError }: { thinktankId: string | null; onError: (m: string) => void }) {
  const [question, setQuestion] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    api.createStudy({ question, hypothesis: hypothesis.trim() || null, thinktankId }).then(
      (r) => (location.hash = `#/study/${r.study.id}`),
      (err: Error) => {
        setBusy(false);
        onError(err.message);
      },
    );
  };
  return (
    <form className="study-form" onSubmit={submit}>
      <label className="question-field">
        <span>무엇을 알고 싶나요</span>
        <textarea value={question} onChange={(e) => setQuestion(e.target.value)} required rows={3} maxLength={2000} />
      </label>
      <label className="hypothesis-field">
        <span>맡기기 전에, 내 예상은</span>
        <textarea
          value={hypothesis}
          onChange={(e) => setHypothesis(e.target.value)}
          rows={2}
          maxLength={2000}
          placeholder="한 줄이면 충분합니다. 비워 둬도 됩니다."
        />
        <small>보고서 맨 앞에 그대로 실려서, 나중에 결과와 비교할 수 있습니다.</small>
      </label>
      <button type="submit" disabled={busy || !question.trim()}>
        {busy ? "맡기는 중" : "연구 맡기기"}
      </button>
    </form>
  );
}
