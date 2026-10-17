import { AskLimitError, type Store } from "../store/store.js";

export interface OfficeContext {
  studyId: string;
  employeeId: string;
  turnId: string | null;
  /** 'research' 턴에서만 질문할 수 있다. 답변·수정 턴에서 또 물으면 질문이 꼬리를 문다(깊이 1). */
  turnKind: string;
  maxAsks: number;
}

export type ToolResult = { ok: true; text: string } | { ok: false; text: string };

/** 사내 메신저 도구 본체. 권한은 프롬프트가 아니라 여기서 검사한다. */
export class OfficeTools {
  constructor(
    private readonly store: Store,
    private readonly ctx: OfficeContext,
  ) {}

  private roster() {
    return this.store.studyEmployees(this.ctx.studyId);
  }

  colleagues(): string[] {
    return this.roster()
      .filter((e) => e.role === "researcher" && e.employee_id !== this.ctx.employeeId)
      .map((e) => e.employee_id);
  }

  /** 연구 명단에 있고, 지금 실행 중인 자기 턴에서 부른 것인지. 끝난 턴의 MCP 프로세스가 남아 있어도 쓰지 못한다. */
  private checkMember(): ToolResult | null {
    const me = this.roster().find((e) => e.employee_id === this.ctx.employeeId);
    if (!me) return { ok: false, text: "이 연구의 직원이 아니다" };
    const turn = this.ctx.turnId ? this.store.getTurn(this.ctx.turnId) : undefined;
    if (!turn || turn.study_id !== this.ctx.studyId || turn.employee_id !== this.ctx.employeeId || turn.status !== "running") {
      return { ok: false, text: "실행 중인 턴이 아니다" };
    }
    return null;
  }

  askColleague(to: string, question: string): ToolResult {
    const denied = this.checkMember();
    if (denied) return denied;
    if (this.ctx.turnKind !== "research") {
      return { ok: false, text: "지금 턴에서는 동료에게 새 질문을 보낼 수 없다" };
    }
    if (!this.colleagues().includes(to)) {
      return { ok: false, text: `질문할 수 없는 상대다: ${to}. 가능한 동료: ${this.colleagues().join(", ") || "없음"}` };
    }
    const trimmed = question.trim();
    if (!trimmed || trimmed.length > 1000) return { ok: false, text: "질문은 1~1000자여야 한다" };
    try {
      const { id, duplicate } = this.store.createAsk({
        studyId: this.ctx.studyId,
        from: this.ctx.employeeId,
        to,
        question: trimmed,
        turnId: this.ctx.turnId,
        maxPerEmployee: this.ctx.maxAsks,
      });
      return {
        ok: true,
        text: duplicate
          ? `같은 질문이 이미 접수돼 있다. 요청 ID: ${id}`
          : `접수됨. 요청 ID: ${id}. 답은 이 턴이 끝난 뒤 전달된다. 기다리지 말고 하던 조사를 계속해라.`,
      };
    } catch (err) {
      if (err instanceof AskLimitError) return { ok: false, text: err.message };
      throw err;
    }
  }

  checkAnswers(): ToolResult {
    const denied = this.checkMember();
    if (denied) return denied;
    const mine = this.store.asksFrom(this.ctx.studyId, this.ctx.employeeId);
    if (!mine.length) return { ok: true, text: "보낸 질문이 없다." };
    const text = mine
      .map((a) => `[${a.id}] ${a.to_employee}에게: ${a.question}\n→ ${a.answer ?? (a.status === "failed" ? "(답을 받지 못함)" : "(아직 답 없음)")}`)
      .join("\n\n");
    return { ok: true, text };
  }
}
