// 사용법:
//   npm run study -- "질문" [--hypothesis "내 예상"] [--export-dir <폴더>]
//   npm run study -- --resume <studyId>
//   npm run study -- --list
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_LIMITS, Orchestrator, type OfficeEvent } from "../office/orchestrator.js";
import { DEFAULT_ROSTER, type Employee } from "../office/roster.js";
import { runTurn } from "../runner/turn.js";
import { Store } from "../store/store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    hypothesis: { type: "string" },
    "no-hypothesis": { type: "boolean" },
    resume: { type: "string" },
    list: { type: "boolean" },
    "export-dir": { type: "string" },
    "data-dir": { type: "string" },
  },
});

const dataDir = path.resolve(values["data-dir"] ?? process.env.NOVA_DATA_DIR ?? path.join(ROOT, "data"));
const exportDir = values["export-dir"] ?? process.env.NOVA_EXPORT_DIR ?? null;
const store = new Store(path.join(dataDir, "nova.db"));

const ICON: Record<string, string> = {
  web_search: "🔎",
  WebSearch: "🔎",
  web_open: "📄",
  WebFetch: "📄",
};

function time(): string {
  return new Date().toLocaleTimeString("ko-KR", { hour12: false });
}

function print(employee: Employee | null, event: OfficeEvent): void {
  const who = employee ? `[${employee.label}]` : "[연구소]";
  const line = (() => {
    switch (event.kind) {
      case "stage":
        return `━━ 단계: ${event.stage} ━━`;
      case "turn_started":
        return `▶ ${event.step} 시작${event.attempt > 1 ? ` (${event.attempt}번째 시도)` : ""}`;
      case "turn_finished":
        return `■ ${event.step} ${event.status} ${Math.round(event.durationMs / 1000)}초${event.error ? ` — ${event.error}` : ""}`;
      case "tool_call": {
        const icon = ICON[event.tool] ?? (event.tool.includes("ask_colleague") ? "💬" : "🔧");
        return `${icon} ${event.tool}${event.detail ? `: ${event.detail.slice(0, 120)}` : ""}`;
      }
      case "tool_result":
        return event.ok ? null : `⚠ ${event.tool} 실패`;
      case "rate_limit":
        return event.fiveHour !== undefined ? `⏳ 한도 5시간 ${Math.round(event.fiveHour * 100)}% · 7일 ${Math.round((event.sevenDay ?? 0) * 100)}%` : null;
      case "error":
        return `⚠ ${event.message.slice(0, 300)}`;
      default:
        return null; // message·usage·final·session은 DB에만 남긴다
    }
  })();
  if (line) console.log(`${time()} ${who} ${line}`);
}

async function askHypothesis(): Promise<string | null> {
  if (values.hypothesis !== undefined) return values.hypothesis.trim() || null;
  if (values["no-hypothesis"] || !process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("🪞 연구를 맡기기 전에, 내 예상을 한 줄 적어 주세요 (Enter = 건너뛰기)\n> ");
  rl.close();
  return answer.trim() || null;
}

async function main(): Promise<void> {
  if (values.list) {
    for (const s of store.listStudies()) {
      console.log(`${s.id}  ${s.status.padEnd(13)} ${s.stage.padEnd(9)} ${s.question.slice(0, 60)}`);
    }
    return;
  }

  const controller = new AbortController();
  let interrupts = 0;
  process.on("SIGINT", () => {
    interrupts++;
    if (interrupts === 1) {
      console.log("\n⏸ 멈추는 중… 진행 중인 턴을 종료하고 저장한다. 한 번 더 누르면 즉시 끝낸다.");
      controller.abort();
    } else {
      process.exit(130);
    }
  });

  const orchestrator = new Orchestrator({
    store,
    dataDir,
    roster: DEFAULT_ROSTER,
    runTurn,
    limits: DEFAULT_LIMITS,
    officeMcp: {
      command: process.execPath,
      args: [path.join(path.dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs"), path.join(ROOT, "server", "mcp", "office-server.ts")],
    },
    exportDir,
    signal: controller.signal,
    onEvent: (_studyId, employee, event) => print(employee, event),
  });

  let studyId = values.resume;
  if (!studyId) {
    const question = positionals.join(" ").trim();
    if (!question) {
      console.error('질문이 필요하다: npm run study -- "질문"');
      process.exitCode = 2;
      return;
    }
    const hypothesis = await askHypothesis();
    studyId = orchestrator.createStudy(question, hypothesis).id;
    console.log(`📁 Study ${studyId} 시작${hypothesis ? "" : " (가설 건너뜀)"}`);
  } else {
    console.log(`📁 Study ${studyId} 이어서 실행`);
  }

  const result = await orchestrator.run(studyId);
  switch (result.status) {
    case "completed":
      console.log(`\n✅ 완료 — 보고서: ${result.report_path}`);
      break;
    case "waiting_limit":
      console.log(`\n⏳ 한도 대기: ${result.error}\n   나중에 이어서: npm run study -- --resume ${studyId}`);
      process.exitCode = 3;
      break;
    case "paused":
      console.log(`\n⏸ 멈춤. 이어서: npm run study -- --resume ${studyId}`);
      process.exitCode = 130;
      break;
    default:
      console.log(`\n❌ ${result.status}: ${result.error}\n   이어서: npm run study -- --resume ${studyId}`);
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => store.close());
