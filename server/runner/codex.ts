import type { EngineAdapter, NormalizedEvent, TurnSpec } from "./types.js";

const RATE_LIMIT_TEXT = /rate.?limit|usage limit|too many requests|429/i;

/**
 * codex-cli 0.163.0은 기본으로 셸·브라우저·컴퓨터 사용 등이 켜져 있다(spikes/m0/RESULTS.md #21).
 * 연구 직원에게는 웹 검색과 사내 메신저 외의 도구를 주지 않는다.
 */
export const CODEX_DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "apps",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "in_app_browser",
  "image_generation",
  "multi_agent",
  "plugins",
  "hooks",
  "skill_search",
];

function tomlString(value: string): string {
  return JSON.stringify(value);
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  query?: string;
  action?: { type?: string; query?: string; url?: string };
  server?: string;
  tool?: string;
  status?: string;
  error?: unknown;
  arguments?: Record<string, unknown>;
  command?: string;
  message?: string;
}

/** `codex exec --json` 어댑터 (codex-cli 0.163.0 실측). 증분 텍스트는 없고 항목 단위로 온다. */
export const codexAdapter: EngineAdapter = {
  engine: "codex",

  buildArgs(spec: TurnSpec): string[] {
    const args = spec.resumeSessionId ? ["exec", "resume", spec.resumeSessionId] : ["exec"];
    args.push("--json", "--skip-git-repo-check", "--ignore-user-config");
    // `exec resume`에는 --sandbox가 없어 -c로 통일한다.
    args.push("-c", 'sandbox_mode="read-only"');
    args.push("-c", `web_search=${tomlString(spec.webSearch ? "live" : "disabled")}`);
    for (const feature of CODEX_DISABLED_FEATURES) args.push("--disable", feature);
    if (spec.model) args.push("--model", spec.model);
    if (spec.effort) args.push("-c", `model_reasoning_effort=${tomlString(spec.effort)}`);
    if (spec.instructions) args.push("-c", `developer_instructions=${tomlString(spec.instructions)}`);
    if (spec.mcp) {
      const p = `mcp_servers.${spec.mcp.name}`;
      args.push("-c", `${p}.command=${tomlString(spec.mcp.command)}`);
      args.push("-c", `${p}.args=${JSON.stringify(spec.mcp.args)}`);
      const env = Object.entries(spec.mcp.env)
        .map(([k, v]) => `${k}=${tomlString(v)}`)
        .join(", ");
      args.push("-c", `${p}.env={ ${env} }`);
      // approve는 승인 정책일 뿐 허용 목록이 아니다 → 노출할 도구 자체를 enabled_tools로 제한한다
      args.push("-c", `${p}.enabled_tools=${JSON.stringify(spec.mcp.tools)}`);
      // exec 모드는 승인 정책이 never라, 도구마다 approve를 주지 않으면 호출이 실패한다
      for (const tool of spec.mcp.tools) args.push("-c", `${p}.tools.${tool}.approval_mode="approve"`);
    }
    if (spec.outputSchemaFile) args.push("--output-schema", spec.outputSchemaFile);
    args.push("-");
    return args;
  },

  createParser() {
    let lastMessage: string | null = null;
    return (e: Record<string, unknown>): NormalizedEvent[] => {
      const out: NormalizedEvent[] = [];
      const item = e.item as CodexItem | undefined;
      if (e.type === "thread.started" && typeof e.thread_id === "string") {
        out.push({ kind: "session", sessionId: e.thread_id });
      } else if (e.type === "item.started" && item?.type === "mcp_tool_call") {
        const arg = item.arguments?.question ?? item.arguments?.to;
        out.push({ kind: "tool_call", tool: `${item.server}/${item.tool}`, detail: typeof arg === "string" ? arg : "" });
      } else if (e.type === "item.completed" && item) {
        switch (item.type) {
          case "agent_message":
            if (item.text) {
              lastMessage = item.text;
              out.push({ kind: "message", text: item.text });
            }
            break;
          case "web_search": {
            // 검색과 페이지 열기가 같은 web_search 타입으로 온다
            const action = item.action?.type;
            const detail = action === "open_page" ? (item.action?.url ?? "") : (item.action?.query ?? item.query ?? "");
            out.push({ kind: "tool_call", tool: action === "open_page" ? "web_open" : "web_search", detail });
            break;
          }
          case "mcp_tool_call":
            out.push({
              kind: "tool_result",
              tool: `${item.server}/${item.tool}`,
              ok: item.status === "completed" && !item.error,
            });
            break;
          case "command_execution":
            // 셸을 껐으므로 나오면 안 된다. 나오면 그대로 드러낸다.
            out.push({ kind: "tool_call", tool: "shell", detail: item.command ?? "" });
            break;
          case "error":
            out.push({ kind: "error", message: item.message ?? "error", rateLimited: RATE_LIMIT_TEXT.test(item.message ?? "") });
            break;
        }
      } else if (e.type === "turn.completed") {
        const usage = e.usage as
          | { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number }
          | undefined;
        out.push({
          kind: "usage",
          inputTokens: usage?.input_tokens,
          cachedInputTokens: usage?.cached_input_tokens,
          outputTokens: usage?.output_tokens,
        });
        if (lastMessage !== null) out.push({ kind: "final", output: lastMessage });
      } else if (e.type === "turn.failed" || e.type === "error") {
        const err = (e.error as { message?: string } | undefined)?.message ?? (e.message as string | undefined) ?? "turn failed";
        out.push({ kind: "error", message: err, rateLimited: RATE_LIMIT_TEXT.test(err) });
      }
      return out;
    };
  },

  classifyStderr(stderr: string): NormalizedEvent[] {
    const text = stderr.trim();
    if (!text) return [];
    return [{ kind: "error", message: text.slice(-500), rateLimited: RATE_LIMIT_TEXT.test(text) }];
  },
};
