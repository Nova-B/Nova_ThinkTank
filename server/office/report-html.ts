// 보고서 HTML: 볼트에 .md 옆에 두는 단독 파일이자, 사무실 앱의 보고서 탭이 iframe으로 보여 주는 문서.
// 내용과 순서는 report-model.ts가 정한다. AI가 쓴 글은 전부 이스케이프하고(속성값 포함), 링크는 http(s)만 만든다.
// 문서 안의 CSP는 아래 고정 스크립트(해시)만 실행을 허용한다 — 단독 파일·앱 iframe·/report.html 어디서 열어도 같다.
import { createHash } from "node:crypto";
import {
  buildReportModel,
  DISAGREEMENT,
  firstSentence,
  HORIZON,
  RELIABILITY,
  SCOPE,
  STANCE,
  STRENGTH_LABEL,
  VERDICT,
  type ClaimView,
  type ReportInput,
  type ReportModel,
  type Strength,
} from "./report-model.js";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function link(url: string, text: string): string {
  return /^https?:\/\//.test(url) ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>` : esc(text);
}

function meter(s: Strength): string {
  return `<span class="meter s${s}" title="근거 신호 ${STRENGTH_LABEL[s]} (참고 지표)"><i></i><i></i><i></i><span>${STRENGTH_LABEL[s]}</span></span>`;
}

/** 근거 표시(A1)를 누르면 접힌 근거를 펼치고 그 자리로 간다. 이 문자열의 해시만 CSP에서 실행이 허용된다 */
const SCRIPT = `function openTarget(){var el=location.hash&&document.getElementById(decodeURIComponent(location.hash.slice(1)));if(el&&el.tagName==="DETAILS"){el.open=true;el.scrollIntoView({block:"start"});}}window.addEventListener("hashchange",openTarget);openTarget();`;
export const REPORT_SCRIPT_HASH = `sha256-${createHash("sha256").update(SCRIPT).digest("base64")}`;
const FONTS = "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600&family=Noto+Serif+KR:wght@400;600;700&display=swap";
export const REPORT_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  `script-src '${REPORT_SCRIPT_HASH}'`,
  "img-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** 근거 주장 표시. 마우스를 올리면 주장 문장, 누르면 부록의 해당 근거로 간다 */
function chips(ids: string[], claims: Map<string, ClaimView>): string {
  if (!ids.length) return "";
  return `<span class="chips">${ids
    .map((id) => {
      const c = claims.get(id);
      const tip = c ? (c.revised ?? c.statement) : "";
      return `<a class="chip" href="#claim-${esc(id)}" title="${esc(tip)}">${esc(id)}</a>`;
    })
    .join("")}</span>`;
}

const VERDICT_CLASS = { upheld: "v-upheld", overturned: "v-overturned", unresolved: "v-unresolved", declined: "v-declined" } as const;

function verdictCounts(m: ReportModel): string {
  const c = m.glance.verdicts.counts;
  const parts = [
    `<span class="v-upheld">${VERDICT.upheld} <b>${c.upheld}</b></span>`,
    `<span class="v-overturned">${VERDICT.overturned} <b>${c.overturned}</b></span>`,
    `<span class="v-unresolved">${VERDICT.unresolved} <b>${c.unresolved}</b></span>`,
  ];
  if (c.declined) parts.push(`<span class="v-declined">${VERDICT.declined} <b>${c.declined}</b></span>`);
  return parts.join("");
}

function warning(m: ReportModel): string {
  const v = m.glance.verdicts;
  if (!v.warn) return "";
  return `<p class="warn">편집장이 반론을 거의 모두(${v.counts.upheld}/${v.decided}) 유지했습니다. 반론이 정말 다 옳았을 수도 있지만,
AI는 반박을 받으면 쉽게 따라가는 경향이 있습니다. <a href="#verification">검증 기록</a>의 재반박 근거를 직접 확인해 보세요.</p>`;
}

export function renderReportHtml(input: ReportInput): string {
  const m = buildReportModel(input);
  const g = m.glance;
  const claims = new Map(m.claims.map((c) => [c.id, c]));

  const findingsRows = g.findings
    .map((f) => `<tr><td class="no">${f.no}</td><td><a href="#finding-${f.no}">${esc(f.heading)}</a></td><td>${meter(f.strength)}</td></tr>`)
    .join("");

  const findings = m.findings
    .map(
      (f) => `<article class="finding" id="finding-${f.no}">
  <h3><span class="no">${f.no}</span>${esc(f.heading)}</h3>
  <p class="meta">${meter(f.strength)} ${chips(f.claimIds, claims)}</p>
  <p>${esc(f.body)}</p>
</article>`,
    )
    .join("\n");

  const actions = (["personal", "macro"] as const)
    .map((scope) => {
      const items = m.actions.filter((a) => a.scope === scope);
      if (!items.length) return "";
      return `<h3>${SCOPE[scope]}</h3><ul class="actions">${items
        .map(
          (a) => `<li><p><span class="when when-${esc(a.horizon)}">${HORIZON[a.horizon]}</span><b>${esc(a.action)}</b></p>
<p class="why">${esc(a.rationale)} ${chips(a.claimIds, claims)}</p></li>`,
        )
        .join("")}</ul>`;
    })
    .join("");

  const disagreements = m.disagreements.length
    ? `<ul class="disagree">${m.disagreements
        .map(
          (d) => `<li><p><b>${esc(d.topic)}</b> <span class="status st-${esc(d.status)}">${DISAGREEMENT[d.status]}</span></p>
<ul>${d.positions.map((p) => `<li><span class="who">${esc(p.holder)}</span> ${esc(p.view)}</li>`).join("")}</ul></li>`,
        )
        .join("")}</ul>`
    : `<p class="muted">편집장이 기록한 이견이 없습니다.</p>`;

  const challenges = m.challenges
    .map((c) => {
      const verdict = c.verdict ? `<span class="verdict ${esc(VERDICT_CLASS[c.verdict] ?? "")}">${esc(VERDICT[c.verdict] ?? "")}</span>` : `<span class="verdict">판정 없음</span>`;
      const rebuttals = c.rebuttals
        .map(
          (r) => `<li><span class="who">${esc(r.who)}</span> <span class="stance st-${esc(r.stance)}">${STANCE[r.stance]}</span> ${esc(r.argument)}
${r.evidence.length ? `<span class="ev">근거: ${r.evidence.map((e) => link(e.url, e.title)).join(", ")}</span>` : ""}
${r.revisedClaim ? `<span class="revised">고친 주장: ${esc(r.revisedClaim)}</span>` : ""}</li>`,
        )
        .join("");
      const counter = c.counter
        ? `<li><span class="who">레드팀 마지막 답</span> <span class="stance st-${esc(c.counter.verdict)}">${c.counter.verdict === "concede" ? "재반박 인정" : "반론 유지"}</span> ${esc(c.counter.argument)}</li>`
        : "";
      return `<details class="challenge sev-${esc(c.severity)}">
  <summary><span class="no">${c.no}</span><span class="sev">${esc(c.severity)}</span>${verdict}<span class="arg">${esc(firstSentence(c.argument))}</span></summary>
  <div class="body">
    <p>${esc(c.argument)}</p>
    <p class="meta">${esc(c.type)} ${chips(c.claimIds, claims)}${c.wouldChangeConclusion ? ` <span class="changes">결론을 바꿀 수 있음</span>` : ""}</p>
    ${rebuttals || counter ? `<ul class="exchange">${rebuttals}${counter}</ul>` : `<p class="muted">재반박 없음</p>`}
    ${c.response ? `<p class="judge"><b>판정 이유</b> ${esc(c.response)}</p>` : ""}
    ${c.resolveBy ? `<p class="judge"><b>풀리려면</b> ${esc(c.resolveBy)}</p>` : ""}
  </div>
</details>`;
    })
    .join("\n");

  const evidence = m.claims
    .map((c) => {
      const sources = c.sources
        .map((s) => {
          const rel = m.reliability.get(s.url);
          const bits = [s.publishedAt && `발행 ${s.publishedAt}`, `확인 ${s.accessedAt}`, !s.fetched && "본문 미확인"].filter(Boolean).join(", ");
          return `<li>${link(s.url, s.title)} <span class="muted">${esc(bits)}</span>${rel ? ` <span class="rel rel-${esc(rel.reliability)}">레드팀 신뢰도 ${RELIABILITY[rel.reliability]}</span>` : ""}${
            s.quote ? `<blockquote>${esc(s.quote)}</blockquote>` : ""
          }</li>`;
        })
        .join("");
      return `<details class="claim" id="claim-${esc(c.id)}">
  <summary><span class="cid">${esc(c.id)}</span>${meter(c.strength)}<span class="arg">${esc(firstSentence(c.revised ?? c.statement))}</span></summary>
  <div class="body">
    <p>${esc(c.revised ?? c.statement)}</p>
    <p class="meta">${c.kind === "evidence" ? "출처 기반" : "직원 추론"}, 확신 ${esc(c.confidence)}, ${esc(c.author)}${
      c.verdicts.length ? `, 반론 ${c.verdicts.map((v) => `${v.no}번 ${VERDICT[v.verdict]}`).join(", ")}` : ""
    }</p>
    ${c.revised ? `<p><span class="muted">처음 주장:</span> ${esc(c.statement)}</p>` : ""}
    ${c.relatedRevisions.map((r) => `<p><span class="muted">반론 ${r.no}번 재반박에서 함께 고친 주장:</span> ${esc(r.text)}</p>`).join("")}
    ${c.reasoning ? `<p><span class="muted">추론:</span> ${esc(c.reasoning)}</p>` : ""}
    ${sources ? `<ul class="sources">${sources}</ul>` : ""}
  </div>
</details>`;
    })
    .join("\n");

  const debate = g.debate
    ? `<p class="metrics">재반박: 수용 ${g.debate.accept}, 부분 수용 ${g.debate.partial}, 거부 ${g.debate.reject}. 고친 주장 ${g.debate.revised}개.
2라운드 ${g.debate.concede + g.debate.maintain}건 (레드팀이 재반박 인정 ${g.debate.concede}, 반론 유지 ${g.debate.maintain}).</p>`
    : `<p class="metrics muted">이 연구는 재반박 단계가 생기기 전에 진행됐습니다.</p>`;

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">
<title>${esc(m.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<style>${CSS}</style>
</head>
<body>
<div class="page">
<nav class="toc" aria-label="목차">
  <p class="brand">Nova ThinkTank</p>
  <ol>
    <li><a href="#mine">내 예상</a></li>
    <li><a href="#glance">한눈에 보기</a></li>
    <li><a href="#findings">핵심 발견</a></li>
    <li><a href="#actions">행동 제안</a></li>
    <li><a href="#open">이견과 미해결</a></li>
    <li><a href="#verification">검증 기록</a></li>
    <li><a href="#appendix">부록</a></li>
    <li><a href="#reflection">사후 검토</a></li>
  </ol>
</nav>
<main>
<header class="head">
  <p class="q">${esc(m.question)}</p>
  <h1>${esc(m.title)}</h1>
  <p class="meta">다듬은 질문: ${esc(m.refinedQuestion)}</p>
  <p class="meta">${esc(m.date)}, Study ${esc(m.studyId)}. 직원: ${esc(m.staff)}. 이 보고서는 AI 직원들이 썼고, 판단은 읽는 사람의 몫입니다.</p>
</header>

<section id="mine" class="mine">
  <h2>내 예상</h2>
  ${m.hypothesis ? `<p>${esc(m.hypothesis)}</p>` : `<p class="muted">연구를 맡기기 전에 적지 않았습니다. 아래를 읽기 전에 한 줄 적어 보세요.</p>`}
</section>

<section id="glance" class="glance">
  <h2>한눈에 보기</h2>
  <p class="counts"><span>발견 <b>${g.findingCount}</b></span><span>행동 제안 <b>${g.actionCount}</b></span><span>미해결 질문 <b>${g.openQuestionCount}</b></span><span>레드팀 반론 <b>${g.challengeCount}</b></span></p>
  <p class="verdicts">${verdictCounts(m)}</p>
  ${warning(m)}
  <table class="map"><thead><tr><th>#</th><th>핵심 발견</th><th>근거 신호</th></tr></thead><tbody>${findingsRows}</tbody></table>
  <div class="two">
    <div><h3>가장 큰 불확실성</h3><ul>${g.uncertainties.map((u) => `<li>${esc(u)}</li>`).join("") || `<li class="muted">없음</li>`}</ul></div>
    <div><h3>지금 할 수 있는 일</h3>
      ${g.now.personal.length ? `<p class="label">개인</p><ul>${g.now.personal.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : ""}
      ${g.now.macro.length ? `<p class="label">거시</p><ul>${g.now.macro.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : ""}
      ${!g.now.personal.length && !g.now.macro.length ? `<p class="muted">당장 할 일로 분류된 제안이 없습니다.</p>` : ""}
    </div>
  </div>
  <p class="note">근거 신호는 참고 지표입니다. 리서처 모델이 스스로 매긴 확신도에서 출발해, 출처 본문을 못 열었거나 주장을 고쳤으면 보통까지,
  레드팀이 출처를 모두 낮게 봤으면 약함까지 낮추고, 심각도 high 반론이 유지·미해결이면 한 단계 더 낮춥니다. 발견은 근거 주장들의 평균을 내림합니다. 사람의 검증이 아닙니다.</p>
</section>

<section id="findings"><h2>핵심 발견</h2>${findings}</section>

<section id="actions"><h2>행동 제안</h2>${actions}</section>

<section id="open">
  <h2>이견과 미해결 질문</h2>
  <h3>이견</h3>${disagreements}
  <h3>미해결 질문</h3><ul>${m.openQuestions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>
  ${
    m.researcherQuestions.length
      ? `<details class="plain"><summary>리서처가 조사 중 남긴 질문 원문 (${m.researcherQuestions.length}개)</summary><ul>${m.researcherQuestions
          .map((q) => `<li>${esc(q.question)} <span class="muted">${esc(q.who)}</span></li>`)
          .join("")}</ul></details>`
      : ""
  }
</section>

<section id="verification">
  <h2>검증 기록</h2>
  <p class="verdicts">${verdictCounts(m)}</p>
  ${debate}
  ${warning(m)}
  <p class="muted">반론을 누르면 재반박과 판정 이유가 펼쳐집니다.</p>
  ${challenges}
  <h3>이 연구의 결론이 틀리게 되는 조건</h3>
  <ul class="wrong">${m.conditionsWhereWrong.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
  ${
    m.missingPerspectives.length
      ? `<details class="plain"><summary>레드팀이 본 빠진 관점 (${m.missingPerspectives.length}개)</summary><ul>${m.missingPerspectives.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></details>`
      : ""
  }
</section>

<section id="appendix">
  <h2>부록</h2>
  <h3>근거 목록 (주장 ${m.claims.length}개)</h3>
  ${evidence}
  <details class="plain"><summary>연구 범위</summary>
    <p>${esc(m.scope.framing)}</p>
    <ul>${m.scope.lenses.map((l) => `<li><b>${esc(l.who)}</b> ${esc(l.lens)}</li>`).join("")}</ul>
    ${m.scope.outOfScope.length ? `<p class="muted">다루지 않은 것: ${esc(m.scope.outOfScope.join(", "))}</p>` : ""}
  </details>
</section>

<section id="reflection" class="mine">
  <h2>사후 검토</h2>
  <p class="muted">예상과 무엇이 달랐나? 무엇이 걸렸고, 무엇은 받아들이지 않겠는가?</p>
  ${m.reflection ? `<p class="pre">${esc(m.reflection)}</p>` : `<p class="muted">아직 적지 않았습니다. 사무실 앱의 사후 검토 탭이나 볼트의 .md에 적을 수 있습니다.</p>`}
</section>
</main>
</div>
<script>${SCRIPT}</script>
<!-- 글꼴은 본문 뒤에 붙여 문서를 막지 않는다(스크립트 없이). 오프라인이면 시스템 글꼴로 남는다 -->
<link rel="stylesheet" href="${FONTS}">
</body>
</html>
`;
}

const CSS = `
:root {
  --paper: #e8eeea; --paper-2: #dfe7e2; --note: #f5f7f2; --grid: #c9d6d0;
  --ink: #1e393c; --muted: #64797a; --red: #bf3f2b; --green: #2f6b4f; --highlight: #f0d35a;
  --sans: "IBM Plex Sans KR", "Malgun Gothic", system-ui, sans-serif;
  --serif: "Noto Serif KR", "Batang", serif;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root { --paper: #15282b; --paper-2: #1b3134; --note: #213b3e; --grid: #2c4746;
    --ink: #dbe6e1; --muted: #8fa5a3; --red: #e0735e; --green: #7fc29b; --highlight: #b89a22; color-scheme: dark; }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 16px; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
body { margin: 0; background: var(--paper); color: var(--ink); font: 400 16px/1.75 var(--serif); word-break: keep-all; overflow-wrap: anywhere; }
a { color: inherit; }
.page { display: grid; grid-template-columns: 200px minmax(0, 760px); gap: 48px; max-width: 1060px; margin: 0 auto; padding: 40px 24px 80px; }
.toc { position: sticky; top: 24px; align-self: start; font: 500 14px/1.5 var(--sans); }
.toc .brand { font-weight: 600; margin: 0 0 12px; }
.toc ol { list-style: none; margin: 0; padding: 0; border-left: 2px solid var(--grid); }
.toc a { display: block; padding: 5px 12px; text-decoration: none; color: var(--muted); }
.toc a:hover { color: var(--ink); }
h1 { font: 700 30px/1.35 var(--serif); margin: 6px 0 12px; }
h2 { font: 600 22px/1.4 var(--serif); margin: 0 0 14px; padding-top: 14px; border-top: 3px solid var(--ink); }
h3 { font: 600 17px/1.5 var(--serif); margin: 26px 0 8px; }
section { margin-top: 48px; }
p { margin: 0 0 12px; }
ul { padding-left: 1.2em; margin: 0 0 12px; }
li { margin: 4px 0; }
.muted { color: var(--muted); }
.head .q { font: 500 15px/1.5 var(--sans); color: var(--muted); margin: 0; }
.meta, .note, .counts, .verdicts, .metrics, .label, summary, .chip, .meter, .when, .status, .stance, .verdict, .sev, .who, .rel, .cid, .changes, table, .toc { font-family: var(--sans); }
.head .meta { font-size: 14px; color: var(--muted); margin: 0 0 4px; }
.mine { background: var(--note); border: 1.5px solid var(--ink); padding: 18px 22px; }
.mine h2 { border: 0; padding: 0; }
.counts { display: flex; flex-wrap: wrap; gap: 8px 22px; font-size: 15px; }
.counts b { font-size: 20px; }
.verdicts { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 14px; }
.v-upheld { color: var(--red); }
.v-overturned { color: var(--green); }
.v-unresolved, .v-declined { color: var(--muted); }
.warn { border-left: 4px solid var(--red); background: var(--note); padding: 10px 14px; font: 400 14px/1.6 var(--sans); }
table.map { width: 100%; border-collapse: collapse; font-size: 15px; margin: 14px 0 6px; }
.map th { text-align: left; font-weight: 500; color: var(--muted); border-bottom: 1.5px solid var(--ink); padding: 6px 8px; }
.map td { border-bottom: 1px solid var(--grid); padding: 8px; vertical-align: top; }
.map td.no { width: 2.5em; color: var(--muted); }
.map a { text-decoration: none; }
.map a:hover { text-decoration: underline; }
.meter { display: inline-flex; align-items: center; gap: 3px; font-size: 13px; white-space: nowrap; }
.meter i { width: 9px; height: 9px; border: 1.5px solid var(--ink); border-radius: 50%; display: inline-block; }
.meter.s1 i:nth-child(-n+1), .meter.s2 i:nth-child(-n+2), .meter.s3 i:nth-child(-n+3) { background: var(--ink); }
.meter span { margin-left: 4px; color: var(--muted); }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; }
.label { font-size: 13px; color: var(--muted); margin: 8px 0 2px; }
.note { font-size: 13px; color: var(--muted); margin-top: 18px; }
.finding { margin: 0 0 30px; }
.finding h3 { display: flex; gap: 10px; margin-bottom: 4px; }
.no { color: var(--muted); font-family: var(--sans); font-weight: 500; }
.finding .meta { font-size: 13px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.chips { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.chip { font-size: 12px; line-height: 1; padding: 4px 6px; border: 1px solid var(--muted); border-radius: 3px; text-decoration: none; color: var(--muted); }
.chip:hover { border-color: var(--ink); color: var(--ink); background: var(--highlight); }
.actions { list-style: none; padding: 0; }
.actions > li { padding: 10px 0; border-bottom: 1px solid var(--grid); }
.actions p { margin: 0; }
.actions .why { font-size: 15px; color: var(--muted); margin-top: 4px; }
.when { font-size: 12px; padding: 2px 7px; margin-right: 8px; border: 1px solid var(--ink); border-radius: 3px; vertical-align: 2px; }
.when-now { background: var(--highlight); border-color: var(--highlight); color: #1e393c; }
.disagree > li { margin-bottom: 12px; }
.status { font-size: 12px; color: var(--muted); margin-left: 6px; }
.st-unresolved { color: var(--red); }
.who { font-size: 13px; font-weight: 600; margin-right: 4px; }
details { border-top: 1px solid var(--grid); }
details:last-of-type { border-bottom: 1px solid var(--grid); }
summary { cursor: pointer; list-style: none; display: flex; gap: 10px; align-items: baseline; padding: 10px 2px; font-size: 14px; }
summary::-webkit-details-marker { display: none; }
summary::before { content: "▸"; color: var(--muted); }
details[open] > summary::before { content: "▾"; }
summary .arg { font-family: var(--serif); font-size: 15px; flex: 1; }
details[open] > summary .arg { color: var(--muted); }
details .body { padding: 0 4px 14px 22px; }
details.plain summary { font-size: 15px; }
.sev { font-size: 11px; padding: 1px 6px; border: 1px solid var(--muted); border-radius: 3px; color: var(--muted); }
.sev-high .sev { border-color: var(--red); color: var(--red); }
.verdict { font-size: 12px; font-weight: 600; white-space: nowrap; }
.challenge .meta { font-size: 13px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.changes { color: var(--red); }
.exchange { list-style: none; padding: 0; }
.exchange > li { padding: 8px 0 8px 12px; border-left: 2px solid var(--grid); margin: 6px 0; }
.stance { font-size: 12px; padding: 1px 6px; border-radius: 3px; border: 1px solid var(--muted); margin-right: 4px; }
.st-reject, .st-maintain { border-color: var(--red); color: var(--red); }
.st-accept, .st-concede { border-color: var(--green); color: var(--green); }
.ev, .revised { display: block; font: 400 13px/1.6 var(--sans); color: var(--muted); margin-top: 4px; }
.judge { font-size: 15px; }
.judge b { font: 600 13px var(--sans); margin-right: 6px; }
.wrong li::marker { color: var(--red); }
.cid { font-weight: 600; min-width: 2.6em; }
.claim .meta { font-size: 13px; color: var(--muted); }
.sources { font-size: 14px; }
.rel { font-size: 12px; color: var(--muted); }
.rel-low, .rel-unverifiable { color: var(--red); }
blockquote { margin: 4px 0 8px; padding-left: 10px; border-left: 2px solid var(--grid); color: var(--muted); font-size: 14px; }
.pre { white-space: pre-wrap; }
:focus-visible { outline: 3px solid var(--highlight); outline-offset: 2px; }
@media (max-width: 900px) {
  .page { grid-template-columns: 1fr; gap: 0; padding: 24px 16px 60px; }
  .toc { position: static; margin-bottom: 8px; }
  .toc ol { display: flex; flex-wrap: wrap; border: 0; gap: 2px 4px; }
  .toc a { padding: 2px 6px; }
  .two { grid-template-columns: 1fr; gap: 0; }
  h1 { font-size: 24px; }
}
@media print {
  .toc { display: none; }
  .page { display: block; }
  details { break-inside: avoid; }
}
`;
