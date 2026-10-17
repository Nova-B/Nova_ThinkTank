// 보고서 모델: 산출물들을 "읽는 순서"대로 한 번 정리한다. Markdown(볼트)과 HTML(파일·앱)이 모두 이걸 그린다.
//
// 읽는 순서(2026-10-17 사용자 결정):
//   내 예상 → 한눈에 보기(결론이 아닌 지도) → 핵심 발견 → 행동 제안 → 이견·미해결
//   → 검증 기록(접힘: 반론·재반박·판정) → 부록(접힘: 근거 목록·범위) → 사후 검토
import type { StudyRow } from "../store/store.js";
import type { Employee } from "./roster.js";
import type { Brief, Claim, Counter, Critique, Rebuttal, ReportDraft, SourceReview } from "./schemas.js";

export const STANCE = { accept: "수용", partial: "부분 수용", reject: "거부" } as const;
export const VERDICT = {
  upheld: "반론 유지",
  overturned: "재반박 인정",
  unresolved: "미해결",
  // M1a(재반박 단계 전): 편집장이 반론을 받아들이지 않았다. 재반박이 있었던 것은 아니다
  declined: "반론 미수용(재반박 단계 전)",
} as const;
export const SCOPE = { macro: "거시 (사회·산업·국가)", personal: "개인" } as const;
export const HORIZON = { now: "지금", "1-3y": "1~3년", "3-10y": "3~10년" } as const;
export const DISAGREEMENT = { unresolved: "미해결", partially_resolved: "일부 해소", resolved: "해소" } as const;
export const RELIABILITY = { high: "높음", medium: "보통", low: "낮음", unverifiable: "확인 불가" } as const;

export type Verdict = keyof typeof VERDICT;
export type Strength = 1 | 2 | 3;
export const STRENGTH_LABEL: Record<Strength, string> = { 1: "약함", 2: "보통", 3: "강함" };

/** 판정. M1a 보고서는 accepted: boolean으로 저장돼 있어 그때의 뜻대로 옮긴다 */
export function verdictOf(r: { verdict?: Verdict; accepted?: boolean }): Verdict {
  if (r.verdict) return r.verdict;
  if (r.accepted === true) return "upheld";
  if (r.accepted === false) return "declined";
  return "unresolved";
}

/**
 * 반론을 거의 다 유지했다면 반론이 다 옳았다는 뜻일 수도, 반론 쪽으로 기우는 성향(아첨)일 수도 있다.
 * 둘을 구별할 수 없으니 읽는 사람에게 알린다. 반론이 적으면 우연일 수 있어 5개 이상일 때만.
 */
export function verdictSummary(draft: ReportDraft, total: number) {
  const counts = { upheld: 0, overturned: 0, unresolved: 0, declined: 0 };
  for (const r of draft.redteamResponses) counts[verdictOf(r as never)]++;
  const decided = counts.upheld + counts.overturned + counts.unresolved + counts.declined;
  const warn = total >= 5 && decided > 0 && counts.upheld / decided >= 0.9;
  return { counts, decided, warn };
}

export interface ReportInput {
  study: StudyRow;
  roster: Employee[];
  brief: Brief;
  claims: Claim[];
  review: SourceReview;
  critique: Critique;
  draft: ReportDraft;
  researcherQuestions: { who: string; question: string }[];
  rebuttals?: { who: string; rebuttal: Rebuttal }[];
  counter?: Counter | null;
}

export interface ChallengeView {
  no: number;
  severity: string;
  type: string;
  claimIds: string[];
  argument: string;
  wouldChangeConclusion: boolean;
  rebuttals: { who: string; stance: keyof typeof STANCE; argument: string; evidence: { title: string; url: string }[]; revisedClaim: string | null }[];
  counter: { verdict: "concede" | "maintain"; argument: string } | null;
  verdict: Verdict | null;
  response: string | null;
  resolveBy: string | null;
}

export interface ClaimView extends Claim {
  /** 이 주장 하나만 겨냥한 반론의 재반박에서 리서처가 고친 문장(있으면) */
  revised: string | null;
  /** 여러 주장을 함께 겨냥한 반론에서 고친 문장. 이 주장만의 수정인지 알 수 없어 따로 보여 준다 */
  relatedRevisions: { no: number; text: string }[];
  /** 이 주장을 겨냥한 반론의 판정들 */
  verdicts: { no: number; verdict: Verdict; severity: string }[];
  strength: Strength;
}

export interface ReportModel {
  title: string;
  studyId: string;
  date: string;
  question: string;
  refinedQuestion: string;
  staff: string;
  hypothesis: string | null;
  reflection: string | null;
  glance: {
    findingCount: number;
    actionCount: number;
    openQuestionCount: number;
    verdicts: ReturnType<typeof verdictSummary>;
    challengeCount: number;
    debate: { accept: number; partial: number; reject: number; revised: number; concede: number; maintain: number } | null;
    findings: { no: number; heading: string; strength: Strength }[];
    uncertainties: string[];
    now: { personal: string[]; macro: string[] };
  };
  findings: { no: number; heading: string; body: string; claimIds: string[]; strength: Strength }[];
  actions: { scope: keyof typeof SCOPE; action: string; rationale: string; horizon: keyof typeof HORIZON; claimIds: string[] }[];
  disagreements: ReportDraft["disagreements"];
  openQuestions: string[];
  researcherQuestions: { who: string; question: string }[];
  challenges: ChallengeView[];
  conditionsWhereWrong: string[];
  missingPerspectives: string[];
  claims: ClaimView[];
  reliability: Map<string, { reliability: keyof typeof RELIABILITY; note: string }>;
  scope: { framing: string; lenses: { who: string; lens: string }[]; outOfScope: string[] };
}

/**
 * 근거 신호(참고 지표). 출발점은 **리서처 모델이 스스로 매긴 확신도**라서 사람의 검증이 아니다.
 * 편집장이 결론마다 점수를 매기게 하지 않고, 기록된 사실로 깎아 내리는 쪽으로만 보정한다.
 *   출발: 출처 기반이면 확신도대로(높음 3, 보통 2, 낮음 1), 추론이면 1
 *   상한 2: 출처 본문을 하나도 열어 보지 못했거나, 재반박에서 주장을 고쳤을 때(고친 문장에는 새 출처가 없다)
 *   상한 1: 레드팀이 출처를 모두 신뢰도 낮음·확인 불가로 봤을 때
 *   -1: 심각도 high 반론이 유지됐거나 미해결로 남았을 때
 */
export function claimStrength(
  c: Claim,
  verdicts: { verdict: Verdict; severity: string }[],
  context: { revised?: boolean; reliability?: (url: string) => string | undefined } = {},
): Strength {
  let s = c.kind === "inference" ? 1 : c.confidence === "high" ? 3 : c.confidence === "medium" ? 2 : 1;
  if (c.sources.length && !c.sources.some((x) => x.fetched)) s = Math.min(s, 2);
  if (context.revised) s = Math.min(s, 2);
  const rel = c.sources.map((x) => context.reliability?.(x.url));
  if (rel.length && rel.every((r) => r === "low" || r === "unverifiable")) s = Math.min(s, 1);
  if (verdicts.some((v) => v.severity === "high" && (v.verdict === "upheld" || v.verdict === "unresolved"))) s -= 1;
  return Math.max(1, Math.min(3, s)) as Strength;
}

/** 발견의 신호는 근거 주장들의 평균을 내림한다. 반올림하면 약한 근거가 강한 근거에 묻힌다 */
export function averageStrength(values: Strength[]): Strength {
  if (!values.length) return 1;
  return Math.max(1, Math.min(3, Math.floor(values.reduce((a, b) => a + b, 0) / values.length))) as Strength;
}

/** 편집장이 제목에 직접 붙인 번호("0. ", "3) ")는 지운다. 번호는 보고서가 매긴다 */
export function stripNumber(heading: string): string {
  return heading.replace(/^\s*\d+\s*[.)]\s*/, "");
}

/** 접힌 줄에 보일 첫 문장(너무 길면 자른다). 전체 문장은 펼치면 보인다 */
export function firstSentence(text: string, max = 110): string {
  // "다"만으로 자르면 "발전량보다 더"처럼 문장 중간에서 끊긴다 → 마침표·물음표·느낌표 뒤에서만
  const first = text.split(/(?<=[.!?])\s+/)[0] ?? text;
  return first.length > max ? first.slice(0, max - 1) + "…" : first;
}

export function buildReportModel(input: ReportInput): ReportModel {
  const { study, roster, brief, critique, draft } = input;
  const rebuttals = input.rebuttals ?? [];
  const counter = input.counter ?? null;
  const verdicts = verdictSummary(draft, critique.challenges.length);

  const challenges: ChallengeView[] = critique.challenges.map((c, i) => {
    const no = i + 1;
    const r = draft.redteamResponses.find((x) => x.challengeNo === no) as
      | (ReportDraft["redteamResponses"][number] & { accepted?: boolean })
      | undefined;
    const last = counter?.replies.find((x) => x.challengeNo === no);
    return {
      no,
      severity: c.severity,
      type: c.type,
      claimIds: c.claimIds,
      argument: c.argument,
      wouldChangeConclusion: c.wouldChangeConclusion,
      rebuttals: rebuttals.flatMap(({ who, rebuttal }) =>
        rebuttal.responses
          .filter((x) => x.challengeNo === no)
          .map((x) => ({ who, stance: x.stance, argument: x.argument, evidence: x.evidence, revisedClaim: x.revisedClaim })),
      ),
      counter: last ? { verdict: last.verdict, argument: last.argument } : null,
      verdict: r ? verdictOf(r as never) : null,
      response: r?.response ?? null,
      resolveBy: (r as { resolveBy?: string | null } | undefined)?.resolveBy ?? null,
    };
  });

  const reliabilityByUrl = new Map(input.review.sources.map((s) => [s.url, s.reliability] as const));
  const claims: ClaimView[] = input.claims.map((c) => {
    const against = challenges
      .filter((ch) => ch.claimIds.includes(c.id) && ch.verdict)
      .map((ch) => ({ no: ch.no, verdict: ch.verdict!, severity: ch.severity }));
    // 고친 문장은 재반박 하나에 하나다. 그 반론이 이 주장 하나만 겨냥했을 때만 주장 문장을 대신한다.
    // 여러 주장을 함께 겨냥한 반론의 고친 문장을 주장마다 복사하면 서로 다른 주장이 같은 문장이 된다.
    const mine = (ch: ChallengeView) => ch.rebuttals.filter((r) => r.revisedClaim && r.who === c.author).map((r) => ({ no: ch.no, text: r.revisedClaim! }));
    const targeting = challenges.filter((ch) => ch.claimIds.includes(c.id));
    const revised = targeting.filter((ch) => ch.claimIds.length === 1).flatMap(mine).at(-1)?.text ?? null;
    const relatedRevisions = targeting.filter((ch) => ch.claimIds.length > 1).flatMap(mine);
    const strength = claimStrength(c, against, {
      revised: revised !== null || relatedRevisions.length > 0,
      reliability: (url) => reliabilityByUrl.get(url),
    });
    return { ...c, revised, relatedRevisions, verdicts: against, strength };
  });
  const byId = new Map(claims.map((c) => [c.id, c]));
  const strengthOf = (ids: string[]) =>
    averageStrength(ids.map((id) => byId.get(id)?.strength).filter((x): x is Strength => x !== undefined));

  const findings = draft.findings.map((f, i) => ({ no: i + 1, heading: stripNumber(f.heading), body: f.body, claimIds: f.claimIds, strength: strengthOf(f.claimIds) }));
  const uncertainties = [
    ...draft.disagreements.filter((d) => d.status === "unresolved").map((d) => d.topic),
    ...draft.openQuestions,
  ].slice(0, 3);
  const nowActions = (scope: "personal" | "macro") =>
    draft.actions.filter((a) => a.scope === scope && a.horizon === "now").map((a) => a.action).slice(0, 3);

  let debate: ReportModel["glance"]["debate"] = null;
  if (rebuttals.length) {
    debate = { accept: 0, partial: 0, reject: 0, revised: 0, concede: 0, maintain: 0 };
    for (const { rebuttal } of rebuttals) {
      for (const x of rebuttal.responses) {
        debate[x.stance]++;
        if (x.revisedClaim) debate.revised++;
      }
    }
    debate.concede = counter?.replies.filter((x) => x.verdict === "concede").length ?? 0;
    debate.maintain = counter?.replies.filter((x) => x.verdict === "maintain").length ?? 0;
  }

  return {
    title: draft.title,
    studyId: study.id,
    date: study.created_at.slice(0, 10),
    question: study.question,
    refinedQuestion: brief.refinedQuestion,
    staff: roster.map((e) => `${e.label}(${e.engine === "claude" ? "Claude" : "Codex"})`).join(", "),
    hypothesis: study.hypothesis,
    reflection: study.reflection?.trim() || null,
    glance: {
      findingCount: draft.findings.length,
      actionCount: draft.actions.length,
      openQuestionCount: draft.openQuestions.length,
      verdicts,
      challengeCount: critique.challenges.length,
      debate,
      findings: findings.map((f) => ({ no: f.no, heading: f.heading, strength: f.strength })),
      uncertainties,
      now: { personal: nowActions("personal"), macro: nowActions("macro") },
    },
    findings,
    actions: draft.actions,
    disagreements: draft.disagreements,
    openQuestions: draft.openQuestions,
    researcherQuestions: input.researcherQuestions,
    challenges,
    conditionsWhereWrong: critique.conditionsWhereWrong,
    missingPerspectives: critique.missingPerspectives,
    claims,
    reliability: new Map(input.review.sources.map((s) => [s.url, { reliability: s.reliability, note: s.note }])),
    scope: {
      framing: brief.framing,
      lenses: brief.assignments.map((a) => ({ who: roster.find((e) => e.id === a.researcherId)?.label ?? a.researcherId, lens: a.lens })),
      outOfScope: brief.outOfScope,
    },
  };
}
