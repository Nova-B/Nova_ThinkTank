import type { EngineAdapter, NormalizedEvent, TurnSpec } from "./types.js";

const WEB_TOOLS = ["WebSearch", "WebFetch"];
const RATE_LIMIT_TEXT = /rate.?limit|usage limit|limit reached|429/i;

interface ContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
  tool_use_id?: string;
  is_error?: boolean;
}

function toolDetail(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const pick = input.query ?? input.url ?? input.question ?? input.to;
  return typeof pick === "string" ? pick : JSON.stringify(input).slice(0, 200);
}

/** `claude -p --output-format stream-json --verbose` 어댑터 (Claude Code 2.1.302 실측, spikes/m0/RESULTS.md) */
export const claudeAdapter: EngineAdapter = {
  engine: "claude",

  buildArgs(spec: TurnSpec): string[] {
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (spec.model) args.push("--model", spec.model);
    if (spec.resumeSessionId) args.push("--resume", spec.resumeSessionId);
    else if (spec.newSessionId) args.push("--session-id", spec.newSessionId);
    if (spec.instructions) args.push("--append-system-prompt", spec.instructions);

    // 내장 도구는 웹 검색·가져오기만. 파일·셸 도구는 아예 노출하지 않는다.
    args.push("--tools", spec.webSearch ? WEB_TOOLS.join(",") : "");
    // --strict-mcp-config가 없으면 사용자의 claude.ai 커넥터(Gmail·Docs 등)가 직원에게 붙는다.
    const servers = spec.mcp
      ? { [spec.mcp.name]: { command: spec.mcp.command, args: spec.mcp.args, env: spec.mcp.env } }
      : {};
    args.push("--mcp-config", JSON.stringify({ mcpServers: servers }), "--strict-mcp-config");
    // 사용자 설정(훅 등)과 스킬을 직원 세션에 들이지 않는다.
    args.push("--setting-sources", "project", "--disable-slash-commands");

    const allowed = [
      ...(spec.webSearch ? WEB_TOOLS : []),
      ...(spec.mcp?.tools.map((t) => `mcp__${spec.mcp!.name}__${t}`) ?? []),
    ];
    if (allowed.length) args.push("--allowedTools", allowed.join(","));
    if (spec.outputSchema) args.push("--json-schema", JSON.stringify(spec.outputSchema));
    return args;
  },

  createParser() {
    const toolNames = new Map<string, string>();
    return (e: Record<string, unknown>): NormalizedEvent[] => {
      const out: NormalizedEvent[] = [];
      if (e.type === "system" && e.subtype === "init" && typeof e.session_id === "string") {
        out.push({ kind: "session", sessionId: e.session_id });
      } else if (e.type === "assistant" || e.type === "user") {
        const content = (e.message as { content?: ContentBlock[] } | undefined)?.content ?? [];
        for (const block of content) {
          if (block.type === "text" && block.text?.trim()) {
            out.push({ kind: "message", text: block.text });
          } else if (block.type === "tool_use" && block.name) {
            if (block.id) toolNames.set(block.id, block.name);
            // 구조화 출력은 도구 호출 모양으로 오지만 최종 출력이므로 도구로 세지 않는다
            if (block.name !== "StructuredOutput") {
              const target = typeof block.input?.to === "string" ? block.input.to : undefined;
              out.push({
                kind: "tool_call",
                tool: block.name,
                detail: toolDetail(block.name, block.input),
                ...(target ? { target } : {}),
              });
            }
          } else if (block.type === "tool_result" && block.tool_use_id) {
            const tool = toolNames.get(block.tool_use_id) ?? "unknown";
            if (tool !== "StructuredOutput") out.push({ kind: "tool_result", tool, ok: !block.is_error });
          }
        }
      } else if (e.type === "rate_limit_event") {
        const info = e.rate_limit_info as
          | {
              status?: string;
              resetsAt?: number;
              unifiedWindows?: Record<string, { utilization?: number }>;
            }
          | undefined;
        out.push({
          kind: "rate_limit",
          status: info?.status ?? "unknown",
          fiveHour: info?.unifiedWindows?.five_hour?.utilization,
          sevenDay: info?.unifiedWindows?.seven_day?.utilization,
          resetsAt: info?.resetsAt,
        });
      } else if (e.type === "result") {
        const usage = e.usage as
          | { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number }
          | undefined;
        out.push({
          kind: "usage",
          inputTokens: usage?.input_tokens,
          cachedInputTokens: usage?.cache_read_input_tokens,
          outputTokens: usage?.output_tokens,
          costUsdEstimate: typeof e.total_cost_usd === "number" ? e.total_cost_usd : undefined,
        });
        if (e.is_error) {
          const text = typeof e.result === "string" ? e.result : String(e.subtype ?? "error");
          out.push({
            kind: "error",
            message: text,
            rateLimited: e.api_error_status === 429 || RATE_LIMIT_TEXT.test(text),
          });
        } else if (e.structured_output !== undefined && e.structured_output !== null) {
          out.push({ kind: "final", output: e.structured_output });
        } else if (typeof e.result === "string") {
          out.push({ kind: "final", output: e.result });
        }
      }
      return out;
    };
  },

  classifyStderr(stderr: string): NormalizedEvent[] {
    if (!stderr.trim()) return [];
    return [{ kind: "error", message: stderr.trim().slice(0, 500), rateLimited: RATE_LIMIT_TEXT.test(stderr) }];
  },
};
