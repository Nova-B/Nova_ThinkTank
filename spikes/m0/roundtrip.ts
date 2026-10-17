// M0-2: 실제 직원 간 왕복 질문. 질문(MCP ask_colleague) → 오케스트레이터가 상대 직원 턴 실행 →
// 질문한 직원이 재개된 다음 턴에서 check_answers 로 답을 받는지. Claude→Codex, Codex→Claude 둘 다.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { claudeArgs, codexArgs, runTurn, saveJson, SPIKE_DIR, type Engine, type TurnResult } from "./cli.js";
import type { AskRequest } from "./office-mcp.js";

const require = createRequire(import.meta.url);
const TSX_CLI = path.join(path.dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs");
const MCP_SCRIPT = path.join(SPIKE_DIR, "office-mcp.ts");
const STATE = path.join(SPIKE_DIR, "state", "roundtrip");
const QUEUE = path.join(STATE, "asks.json");

interface Employee {
  id: string;
  engine: Engine;
  sessionId?: string;
}

function finalText(r: TurnResult): string {
  for (const e of [...r.events].reverse()) {
    if (e.type === "result" && typeof e.result === "string") return e.result;
    const item = e.item as { type?: string; text?: string } | undefined;
    if (e.type === "item.completed" && item?.type === "agent_message") return item.text ?? "";
  }
  return "";
}

function toolCalls(r: TurnResult): string[] {
  const names: string[] = [];
  for (const e of r.events) {
    const content = (e.message as { content?: { type: string; name?: string }[] } | undefined)?.content;
    for (const c of content ?? []) if (c.type === "tool_use" && c.name) names.push(c.name);
    const item = e.item as { type?: string; server?: string; tool?: string; status?: string } | undefined;
    if (e.type === "item.completed" && item?.type === "mcp_tool_call") {
      names.push(`${item.server}/${item.tool}:${item.status}`);
    }
  }
  return names;
}

async function turn(emp: Employee, colleagues: string[], prompt: string, logName: string) {
  const env = {
    OFFICE_STATE_DIR: STATE,
    OFFICE_EMPLOYEE_ID: emp.id,
    OFFICE_COLLEAGUES: colleagues.join(","),
  };
  const cwd = path.join(SPIKE_DIR, "work", "roundtrip", emp.id);
  if (emp.engine === "claude") {
    const fresh = !emp.sessionId;
    if (fresh) emp.sessionId = randomUUID();
    return runTurn({
      engine: "claude",
      cwd,
      logName,
      prompt,
      args: claudeArgs({
        model: "haiku",
        ...(fresh ? { sessionId: emp.sessionId } : { resume: emp.sessionId }),
        tools: "",
        mcpConfig: { mcpServers: { office: { command: process.execPath, args: [TSX_CLI, MCP_SCRIPT], env } } },
        allowedTools: ["mcp__office__ask_colleague", "mcp__office__check_answers"],
      }),
    });
  }
  const r = await runTurn({
    engine: "codex",
    cwd,
    logName,
    prompt,
    args: codexArgs({
      effort: "low",
      ignoreUserConfig: true,
      resume: emp.sessionId,
      mcp: {
        name: "office",
        command: process.execPath,
        args: [TSX_CLI, MCP_SCRIPT],
        env,
        approveTools: ["ask_colleague", "check_answers"],
      },
    }),
  });
  emp.sessionId ??= r.events.find((e) => e.type === "thread.started")?.thread_id as string | undefined;
  return r;
}

async function scenario(asker: Employee, answerer: Employee, code: string) {
  const ids = [asker.id, answerer.id];
  const t1 = await turn(
    asker,
    ids.filter((i) => i !== asker.id),
    `너는 연구소 리서처 ${asker.id}다. office 도구 ask_colleague 로 동료 ${answerer.id}에게 ` +
      `"AI 데이터센터 전력 수요 전망에서 가장 흔한 과장 요인 하나는?" 이라고 물어라. 묻고 나서 '질문 보냄' 이라고만 답하고 턴을 끝내라.`,
    `rt-${asker.id}-ask`,
  );
  const queue: AskRequest[] = existsSync(QUEUE) ? JSON.parse(readFileSync(QUEUE, "utf8")) : [];
  const pending = queue.filter((q) => q.from === asker.id && !q.answer);

  // 오케스트레이터: 받은 질문마다 상대 직원 턴을 돌려 답을 채운다.
  // 스파이크는 순차 실행이라 파일 큐로 충분하다. 동시 쓰기는 M1a에서 SQLite 트랜잭션으로 바꾼다.
  const answerFailures: { id: string; exit: number | null }[] = [];
  for (const q of pending) {
    const a = await turn(
      answerer,
      ids.filter((i) => i !== answerer.id),
      `너는 연구소 레드팀 ${answerer.id}다. 동료 ${q.from}의 질문에 두 문장 이내로 답해라. ` +
        `답 맨 끝에 확인코드 ${code} 를 그대로 붙여라.\n\n질문: ${q.question}`,
      `rt-${answerer.id}-answer`,
    );
    const answer = finalText(a);
    if (a.exitCode !== 0 || !answer) {
      answerFailures.push({ id: q.id, exit: a.exitCode });
      continue;
    }
    // 답을 만드는 동안 다른 요청이 추가됐을 수 있으니 다시 읽어서 해당 항목만 갱신한다
    const latest: AskRequest[] = JSON.parse(readFileSync(QUEUE, "utf8"));
    const target = latest.find((x) => x.id === q.id);
    if (target) {
      target.answer = q.answer = answer;
      target.answeredAt = new Date().toISOString();
    }
    writeFileSync(QUEUE, JSON.stringify(latest, null, 2));
  }

  const t2 = await turn(
    asker,
    ids.filter((i) => i !== asker.id),
    `check_answers 로 동료의 답을 확인하고, 답을 한 문장으로 요약한 뒤 답에 있던 확인코드를 그대로 적어라.`,
    `rt-${asker.id}-check`,
  );
  return {
    asker: asker.engine,
    answerer: answerer.engine,
    askExit: t1.exitCode,
    askTools: toolCalls(t1),
    queued: pending.length,
    answer: pending[0]?.answer,
    answerFailures,
    checkExit: t2.exitCode,
    checkTools: toolCalls(t2),
    checkText: finalText(t2),
    codeReceived: finalText(t2).includes(code),
    durationsMs: [t1.durationMs, t2.durationMs],
  };
}

async function main() {
  rmSync(STATE, { recursive: true, force: true });
  const s1 = await scenario({ id: "researcher-claude", engine: "claude" }, { id: "redteam-codex", engine: "codex" }, "KESTREL-0912");
  const s2 = await scenario({ id: "researcher-codex", engine: "codex" }, { id: "redteam-claude", engine: "claude" }, "PLOVER-4471");
  const report = { claudeAsksCodex: s1, codexAsksClaude: s2 };
  saveJson("roundtrip-report.json", report);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
