import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useState } from "react";
import { api } from "../api";

// 출처 링크는 새 탭에서 연다(사무실 화면을 떠나지 않게). opener로 이 창을 건드리지 못하게 막는다.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** 보고서 Markdown을 HTML로. 내용은 웹에서 가져온 글을 담고 있으므로 반드시 소독한다 */
function toHtml(markdown: string): string {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  const html = marked.parse(body, { async: false, gfm: true });
  // 보고서에는 이미지·미디어·폼이 필요 없다. 원격 이미지는 열람만으로 외부에 요청을 보내므로 막는다
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["target"],
    FORBID_TAGS: ["img", "picture", "source", "video", "audio", "iframe", "object", "embed", "form", "input", "button", "style", "svg", "math"],
    FORBID_ATTR: ["style", "srcset"],
  });
}

export function ReportPanel({ studyId, completed, version }: { studyId: string; completed: boolean; version: string }) {
  const [report, setReport] = useState<{ html: string; path: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!completed) return;
    api.report(studyId).then(
      (r) => setReport({ html: toHtml(r.markdown), path: r.path }),
      (e: Error) => setError(e.message),
    );
  }, [studyId, completed, version]);

  if (!completed) return <p className="empty">편집장이 보고서를 마치면 여기에 나타납니다.</p>;
  if (error) return <p className="form-error">{error}</p>;
  if (!report) return null;
  return (
    <div className="report">
      <p className="report-path">저장 위치: {report.path}</p>
      <article className="report-body" dangerouslySetInnerHTML={{ __html: report.html }} />
    </div>
  );
}
