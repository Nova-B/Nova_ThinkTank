import { useEffect, useState } from "react";
import { api } from "../api";

/**
 * 볼트에 저장된 것과 같은 HTML 보고서를 그대로 보여 준다(형식을 한곳에서만 정하기 위해).
 * sandbox에 allow-same-origin이 없어서, 보고서 안의 스크립트는 이 앱의 쿠키·저장소·DOM에 닿지 못한다.
 * 스크립트는 근거 표시(A1)를 누르면 접힌 근거를 펼치는 데만 쓴다.
 */
export function ReportPanel({ studyId, completed, version }: { studyId: string; completed: boolean; version: string }) {
  const [report, setReport] = useState<{ html: string | null; path: string; htmlPath: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!completed) return;
    api.report(studyId).then(
      (r) => setReport({ html: r.html, path: r.path, htmlPath: r.htmlPath }),
      (e: Error) => setError(e.message),
    );
  }, [studyId, completed, version]);

  if (!completed) return <p className="empty">편집장이 보고서를 마치면 여기에 나타납니다.</p>;
  if (error) return <p className="form-error">{error}</p>;
  if (!report) return null;
  return (
    <div className="report">
      <p className="report-path">
        볼트 저장 위치: {report.path}
        {report.htmlPath ? (
          <>
            {" "}
            <a href={`/api/studies/${studyId}/report.html`} target="_blank" rel="noopener noreferrer">
              새 창에서 크게 보기
            </a>
          </>
        ) : null}
      </p>
      {report.html ? (
        <iframe
          className="report-frame"
          title="연구 보고서"
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          srcDoc={report.html}
        />
      ) : (
        <p className="empty">이 연구는 HTML 보고서가 없습니다. 사후 검토를 한 번 저장하면 다시 만들어집니다.</p>
      )}
    </div>
  );
}
