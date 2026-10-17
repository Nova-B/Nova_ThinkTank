import { useState, type FormEvent } from "react";
import { api } from "../api";
import type { Study } from "../types";

/** 보고서를 읽은 뒤의 내 판단. AI의 결론을 그대로 받아들이지 않기 위한 마지막 칸이다 */
export function ReflectionPanel({ study, onSaved }: { study: Study; onSaved: () => void }) {
  const [text, setText] = useState(study.reflection ?? "");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    api.reflection(study.id, text).then(
      (r) => {
        setBusy(false);
        setNotice(r.reportUpdated ? "저장했습니다. 보고서의 사후 검토 칸에도 들어갔습니다." : "저장했습니다. 보고서가 나오면 사후 검토 칸에 들어갑니다.");
        onSaved();
      },
      (err: Error) => {
        setBusy(false);
        setNotice(err.message);
      },
    );
  };

  return (
    <form className="reflection" onSubmit={submit}>
      {study.hypothesis ? <p className="hypo">맡기기 전 내 예상: {study.hypothesis}</p> : null}
      <label>
        <span>예상과 무엇이 달랐나요? 무엇이 걸렸고, 무엇은 받아들이지 않겠습니까?</span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} maxLength={10000} />
      </label>
      <div className="row">
        <button type="submit" disabled={busy}>
          {busy ? "저장하는 중" : "사후 검토 저장"}
        </button>
        {notice ? <span className="notice" role="status">{notice}</span> : null}
      </div>
    </form>
  );
}
