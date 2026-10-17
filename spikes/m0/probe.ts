// M0-1: 현재 CLI 버전의 이벤트 형식, 세션 ID 위치, 재개 후 기억을 확인한다.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { claudeArgs, codexArgs, runTurn, saveJson, SPIKE_DIR, type TurnResult } from "./cli.js";

const WORK = path.join(SPIKE_DIR, "work", "probe");

function typeSummary(r: TurnResult): string[] {
  return r.events.map((e) => {
    const sub = (e.subtype ?? (e.item as { type?: string } | undefined)?.type ?? "") as string;
    return sub ? `${String(e.type)}/${sub}` : String(e.type);
  });
}

function lastText(r: TurnResult): string {
  for (const e of [...r.events].reverse()) {
    if (e.type === "result" && typeof e.result === "string") return e.result;
    const item = e.item as { type?: string; text?: string } | undefined;
    if (e.type === "item.completed" && item?.type === "agent_message") return item.text ?? "";
  }
  return "";
}

async function main() {
  const report: Record<string, unknown> = {};

  // Claude: --session-id 로 세션 ID를 앱이 먼저 정할 수 있는지
  const claudeSession = randomUUID();
  const c1 = await runTurn({
    engine: "claude",
    args: claudeArgs({ model: "haiku", sessionId: claudeSession, tools: "" }),
    prompt: "코드워드는 HERON-5521 이다. '기억함' 한 단어로만 답해.",
    cwd: WORK,
    logName: "claude-new",
  });
  const c2 = await runTurn({
    engine: "claude",
    args: claudeArgs({ model: "haiku", resume: claudeSession, tools: "" }),
    prompt: "아까 코드워드가 뭐였지? 코드워드만 답해.",
    cwd: WORK,
    logName: "claude-resume",
  });
  const initEvent = c1.events.find((e) => e.type === "system" && e.subtype === "init");
  report.claude = {
    presetSessionId: claudeSession,
    initSessionId: initEvent?.session_id,
    resumeSessionId: c2.events.find((e) => e.type === "result")?.session_id,
    newExit: c1.exitCode,
    resumeExit: c2.exitCode,
    remembered: lastText(c2).includes("HERON-5521"),
    eventTypes: [...new Set([...typeSummary(c1), ...typeSummary(c2)])],
    resultKeys: Object.keys(c2.events.find((e) => e.type === "result") ?? {}),
    durationsMs: [c1.durationMs, c2.durationMs],
  };

  // Codex: thread.started 의 thread_id, exec resume 후 기억
  const x1 = await runTurn({
    engine: "codex",
    args: codexArgs({ effort: "low", ignoreUserConfig: true }),
    prompt: "코드워드는 OSPREY-3308 이다. '기억함' 한 단어로만 답해.",
    cwd: WORK,
    logName: "codex-new",
  });
  const threadId = x1.events.find((e) => e.type === "thread.started")?.thread_id as string | undefined;
  const x2 = threadId
    ? await runTurn({
        engine: "codex",
        args: codexArgs({ effort: "low", ignoreUserConfig: true, resume: threadId }),
        prompt: "아까 코드워드가 뭐였지? 코드워드만 답해.",
        cwd: WORK,
        logName: "codex-resume",
      })
    : null;
  report.codex = {
    threadId,
    newExit: x1.exitCode,
    resumeExit: x2?.exitCode,
    remembered: x2 ? lastText(x2).includes("OSPREY-3308") : false,
    eventTypes: [...new Set([...typeSummary(x1), ...(x2 ? typeSummary(x2) : [])])],
    turnCompleted: x2?.events.find((e) => e.type === "turn.completed"),
    stderrHead: x1.stderr.slice(0, 400),
    durationsMs: [x1.durationMs, x2?.durationMs],
  };

  saveJson("probe-report.json", report);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
