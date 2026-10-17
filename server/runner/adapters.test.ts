import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeAdapter } from "./claude.js";
import { CODEX_DISABLED_FEATURES, codexAdapter } from "./codex.js";
import type { TurnSpec } from "./types.js";

const base: TurnSpec = {
  engine: "claude",
  cwd: ".",
  prompt: "p",
  resumeSessionId: null,
  webSearch: true,
  mcp: { name: "office", command: "node", args: ["s.js"], env: { A: "1" }, tools: ["ask_colleague"] },
  outputSchema: { type: "object" },
  outputSchemaFile: "schema.json",
};

test("claude: 격리 플래그와 허용 도구", () => {
  const args = claudeAdapter.buildArgs({ ...base, newSessionId: "sid" });
  assert.ok(args.includes("--strict-mcp-config"), "claude.ai 커넥터 차단");
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", "WebSearch,WebFetch"]);
  assert.equal(args[args.indexOf("--allowedTools") + 1], "WebSearch,WebFetch,mcp__office__ask_colleague");
  assert.equal(args[args.indexOf("--session-id") + 1], "sid");
  assert.ok(!args.includes("--resume"));
  assert.ok(args.includes("--json-schema"));
});

test("claude: 웹 검색 없으면 내장 도구 0개, 재개는 --resume", () => {
  const args = claudeAdapter.buildArgs({ ...base, webSearch: false, mcp: undefined, resumeSessionId: "old", newSessionId: "x" });
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--resume") + 1], "old");
  assert.ok(!args.includes("--session-id"));
  assert.ok(!args.includes("--allowedTools"));
});

test("claude: 이벤트 정규화", () => {
  const parse = claudeAdapter.createParser();
  const out = [
    { type: "system", subtype: "init", session_id: "s1" },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "WebSearch", input: { query: "IEA 2026" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "StructuredOutput", input: { a: 1 } }] } },
    { type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 10, unifiedWindows: { five_hour: { utilization: 0.2 }, seven_day: { utilization: 0.5 } } } },
    { type: "result", is_error: false, structured_output: { a: 1 }, total_cost_usd: 0.1, usage: { input_tokens: 5, output_tokens: 2 } },
  ].flatMap((e) => parse(e));
  assert.deepEqual(out, [
    { kind: "session", sessionId: "s1" },
    { kind: "tool_call", tool: "WebSearch", detail: "IEA 2026" },
    { kind: "tool_result", tool: "WebSearch", ok: false },
    { kind: "rate_limit", status: "allowed", fiveHour: 0.2, sevenDay: 0.5, resetsAt: 10 },
    { kind: "usage", inputTokens: 5, cachedInputTokens: undefined, outputTokens: 2, costUsdEstimate: 0.1 },
    { kind: "final", output: { a: 1 } },
  ]);
});

test("claude: 오류 결과는 한도 여부를 구분한다", () => {
  const parse = claudeAdapter.createParser();
  const limited = parse({ type: "result", is_error: true, api_error_status: 429, result: "x" });
  assert.deepEqual(limited.at(-1), { kind: "error", message: "x", rateLimited: true });
  const other = claudeAdapter.createParser()({ type: "result", is_error: true, result: "boom" });
  assert.deepEqual(other.at(-1), { kind: "error", message: "boom", rateLimited: false });
});

test("codex: 위험 기능을 끄고, 재개 형식을 지킨다", () => {
  const args = codexAdapter.buildArgs({ ...base, engine: "codex", resumeSessionId: "th1", effort: "low" });
  assert.deepEqual(args.slice(0, 3), ["exec", "resume", "th1"]);
  for (const f of CODEX_DISABLED_FEATURES) assert.ok(args.join(" ").includes(`--disable ${f}`), f);
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes('sandbox_mode="read-only"'));
  assert.ok(args.includes('web_search="live"'));
  assert.ok(args.includes('mcp_servers.office.tools.ask_colleague.approval_mode="approve"'));
  assert.equal(args[args.indexOf("--output-schema") + 1], "schema.json");
  assert.equal(args.at(-1), "-");
});

test("codex: 이벤트 정규화와 최종 출력", () => {
  const parse = codexAdapter.createParser();
  const out = [
    { type: "thread.started", thread_id: "th1" },
    { type: "item.completed", item: { type: "web_search", action: { type: "search", query: "q1" } } },
    { type: "item.completed", item: { type: "web_search", action: { type: "open_page", url: "https://a" } } },
    { type: "item.started", item: { type: "mcp_tool_call", server: "office", tool: "ask_colleague", arguments: { to: "b", question: "왜?" } } },
    { type: "item.completed", item: { type: "mcp_tool_call", server: "office", tool: "ask_colleague", status: "completed", error: null } },
    { type: "item.completed", item: { type: "agent_message", text: '{"a":1}' } },
    { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 8, output_tokens: 1 } },
  ].flatMap((e) => parse(e));
  assert.deepEqual(out, [
    { kind: "session", sessionId: "th1" },
    { kind: "tool_call", tool: "web_search", detail: "q1" },
    { kind: "tool_call", tool: "web_open", detail: "https://a" },
    { kind: "tool_call", tool: "office/ask_colleague", detail: "왜?", target: "b" },
    { kind: "tool_result", tool: "office/ask_colleague", ok: true },
    { kind: "message", text: '{"a":1}' },
    { kind: "usage", inputTokens: 10, cachedInputTokens: 8, outputTokens: 1 },
    { kind: "final", output: '{"a":1}' },
  ]);
});

test("codex: stderr의 사용 한도 오류를 알아본다", () => {
  assert.equal(codexAdapter.classifyStderr("ERROR: You've hit your usage limit")[0]?.kind, "error");
  assert.equal((codexAdapter.classifyStderr("usage limit reached")[0] as { rateLimited?: boolean }).rateLimited, true);
  assert.deepEqual(codexAdapter.classifyStderr("  "), []);
});
