// M0-4 (M1a 준비): 구조화 출력(Claude --json-schema, Codex --output-schema)의 이벤트 모양과
// Codex 위험 기능(셸·브라우저·컴퓨터 사용 등)을 끈 상태에서 정상 동작하는지 확인한다.
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { claudeArgs, codexArgs, runTurn, saveJson, SPIKE_DIR } from "./cli.js";

const WORK = path.join(SPIKE_DIR, "work", "structured");
const schema = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "confidence"],
  properties: {
    answer: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
};
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

async function main() {
  mkdirSync(WORK, { recursive: true });
  const schemaFile = path.join(WORK, "schema.json");
  writeFileSync(schemaFile, JSON.stringify(schema));
  const prompt = "대한민국의 수도는? 짧게.";

  const c = await runTurn({
    engine: "claude",
    cwd: WORK,
    logName: "st-claude",
    prompt,
    args: claudeArgs({ model: "haiku", tools: "", mcpConfig: { mcpServers: {} }, extra: ["--json-schema", JSON.stringify(schema)] }),
  });
  const result = c.events.find((e) => e.type === "result") ?? {};
  const x = await runTurn({
    engine: "codex",
    cwd: WORK,
    logName: "st-codex",
    prompt: prompt + " 그리고 셸 명령으로 현재 폴더 파일 목록을 확인해 봐라(가능하면).",
    args: codexArgs({
      effort: "low",
      ignoreUserConfig: true,
      extra: ["--output-schema", schemaFile, ...CODEX_DISABLED_FEATURES.flatMap((f) => ["--disable", f])],
    }),
  });
  const items = x.events.filter((e) => e.type === "item.completed").map((e) => e.item as { type: string; text?: string });
  const report = {
    claude: {
      exit: c.exitCode,
      resultKeys: Object.keys(result).filter((k) => /struct|result|output/i.test(k)),
      result: result.result,
      structured: result.structured_output,
      toolsUsed: c.events.flatMap((e) =>
        ((e.message as { content?: { type: string; name?: string }[] } | undefined)?.content ?? [])
          .filter((b) => b.type === "tool_use")
          .map((b) => b.name),
      ),
    },
    codex: {
      exit: x.exitCode,
      itemTypes: items.map((i) => i.type),
      lastMessage: items.filter((i) => i.type === "agent_message").at(-1)?.text,
      stderr: x.stderr.slice(0, 600),
    },
  };
  saveJson("structured-report.json", report);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
