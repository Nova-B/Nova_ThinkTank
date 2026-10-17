// M0-3: 직원 격리·권한·웹 검색·취소 확인.
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { claudeArgs, codexArgs, runTurn, saveJson, SPIKE_DIR, type TurnResult } from "./cli.js";

const require = createRequire(import.meta.url);
const TSX_CLI = path.join(path.dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs");
const MCP_SCRIPT = path.join(SPIKE_DIR, "office-mcp.ts");
const STATE = path.join(SPIKE_DIR, "state", "isolation");
const WORK = path.join(SPIKE_DIR, "work", "isolation");
const officeMcp = {
  mcpServers: {
    office: {
      command: process.execPath,
      args: [TSX_CLI, MCP_SCRIPT],
      env: { OFFICE_STATE_DIR: STATE, OFFICE_EMPLOYEE_ID: "iso", OFFICE_COLLEAGUES: "other" },
    },
  },
};

function init(r: TurnResult) {
  const e = r.events.find((x) => x.type === "system" && x.subtype === "init") ?? {};
  return {
    tools: e.tools,
    mcp: e.mcp_servers,
    skills: (e.skills as unknown[] | undefined)?.length,
    plugins: (e.plugins as { name: string }[] | undefined)?.map((p) => p.name),
    memory: e.memory_paths,
  };
}

function result(r: TurnResult) {
  const e = r.events.find((x) => x.type === "result") ?? {};
  return { exit: r.exitCode, isError: e.is_error, text: e.result, denials: e.permission_denials };
}

function claudeToolUses(r: TurnResult): string[] {
  return r.events.flatMap((e) =>
    ((e.message as { content?: { type: string; name?: string }[] } | undefined)?.content ?? [])
      .filter((c) => c.type === "tool_use")
      .map((c) => c.name ?? "?"),
  );
}

function codexItems(r: TurnResult): string[] {
  return r.events
    .filter((e) => e.type === "item.completed")
    .map((e) => (e.item as { type: string }).type);
}

function codexText(r: TurnResult): string {
  const items = r.events.filter((e) => e.type === "item.completed").map((e) => e.item as { type: string; text?: string });
  return items.filter((i) => i.type === "agent_message").map((i) => i.text).join("\n");
}

function officeMcpProcesses(): number {
  if (process.platform !== "win32") return -1;
  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-Command", // 이 조회를 하는 powershell 자신도 명령줄에 문자열을 담고 있어 node 프로세스만 센다
      "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*office-mcp.ts*' } | Measure-Object).Count"],
    { encoding: "utf8" },
  );
  return Number(out.trim());
}

async function main() {
  rmSync(WORK, { recursive: true, force: true });
  const report: Record<string, unknown> = {};
  const question = "오늘 날짜 기준으로 가장 최근에 발표된 국제에너지기구(IEA) 보고서 제목 하나와 그 URL을 알려줘. 반드시 웹 검색을 써라.";

  // A. --safe-mode 가 스킬·플러그인·메모리를 끄면서 --mcp-config 는 살려 두는지
  const a = await runTurn({
    engine: "claude",
    cwd: WORK,
    logName: "iso-claude-safe-mode",
    prompt: "'ok' 라고만 답해.",
    args: claudeArgs({ model: "haiku", tools: "", mcpConfig: officeMcp, extra: ["--safe-mode"] }),
  });
  report.claudeSafeMode = { ...init(a), ...result(a) };

  // B. Claude 웹 검색: 내장 도구를 WebSearch·WebFetch 로만 제한
  const b = await runTurn({
    engine: "claude",
    cwd: WORK,
    logName: "iso-claude-websearch",
    prompt: question,
    args: claudeArgs({
      model: "haiku",
      tools: "WebSearch,WebFetch",
      allowedTools: ["WebSearch", "WebFetch"],
      mcpConfig: { mcpServers: {} },
    }),
  });
  report.claudeWebSearch = { tools: init(b).tools, used: claudeToolUses(b), ...result(b), ms: b.durationMs };

  // C. Codex 웹 검색 (exec 모드에서 켜는 설정)
  const c = await runTurn({
    engine: "codex",
    cwd: WORK,
    logName: "iso-codex-websearch",
    prompt: question,
    args: codexArgs({ effort: "low", ignoreUserConfig: true, extra: ["-c", 'web_search="live"'] }),
  });
  report.codexWebSearch = { exit: c.exitCode, items: codexItems(c), text: codexText(c), stderr: c.stderr.slice(0, 400), ms: c.durationMs };

  // D. Codex 읽기 전용 샌드박스에서 파일 쓰기 시도
  const target = path.join(WORK, "should-not-exist.txt");
  const d = await runTurn({
    engine: "codex",
    cwd: WORK,
    logName: "iso-codex-readonly",
    prompt: `셸 명령으로 현재 폴더에 should-not-exist.txt 파일을 만들고 'hi' 를 써라. 실패하면 실패했다고 답해라.`,
    args: codexArgs({ effort: "low", ignoreUserConfig: true, sandbox: "read-only" }),
  });
  report.codexReadOnly = { exit: d.exitCode, items: codexItems(d), fileCreated: existsSync(target), text: codexText(d) };

  // E. MCP 를 단 Claude 턴을 도중에 트리 종료 → MCP 자식이 남는지, 재개되는지
  const sid = randomUUID();
  const before = officeMcpProcesses();
  const e1 = await runTurn({
    engine: "claude",
    cwd: WORK,
    logName: "iso-claude-cancel",
    prompt: "에너지 전환의 역사를 3000자 분량으로 자세히 써라.",
    killAfterMs: 6000,
    args: claudeArgs({ model: "haiku", sessionId: sid, tools: "", mcpConfig: officeMcp }),
  });
  await new Promise((r) => setTimeout(r, 1500));
  const after = officeMcpProcesses();
  const e2 = await runTurn({
    engine: "claude",
    cwd: WORK,
    logName: "iso-claude-cancel-resume",
    prompt: "직전에 내가 무엇을 써 달라고 했는지 한 문장으로 말해라.",
    args: claudeArgs({ model: "haiku", resume: sid, tools: "", mcpConfig: officeMcp }),
  });
  report.claudeCancel = {
    killRequested: e1.killRequested,
    killedExit: e1.exitCode,
    sawInit: e1.events.some((x) => x.type === "system"),
    mcpProcsBefore: before,
    mcpProcsAfter: after,
    resume: result(e2),
  };

  saveJson("isolation-report.json", report);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
