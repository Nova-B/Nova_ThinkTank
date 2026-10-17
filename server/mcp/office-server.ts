// 사내 메신저 MCP 서버 (stdio). 직원 CLI가 자식 프로세스로 띄우고, 오케스트레이터와 같은 SQLite 파일을 연다.
// 직원 식별은 환경변수로 받는다. 직원이 인자로 자기 ID를 바꿔 말할 수 없게 하기 위해서다.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Store } from "../store/store.js";
import { OfficeTools, type ToolResult } from "./office-tools.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} 환경변수가 필요하다`);
    process.exit(2);
  }
  return v;
}

const store = new Store(requireEnv("NOVA_DB"));
const tools = new OfficeTools(store, {
  studyId: requireEnv("NOVA_STUDY_ID"),
  employeeId: requireEnv("NOVA_EMPLOYEE_ID"),
  turnId: process.env.NOVA_TURN_ID ?? null,
  turnKind: requireEnv("NOVA_TURN_KIND"),
  maxAsks: Number(process.env.NOVA_MAX_ASKS ?? "2"),
});

const reply = (r: ToolResult) => ({ isError: !r.ok, content: [{ type: "text" as const, text: r.text }] });

const server = new McpServer({ name: "office", version: "0.1.0" });

server.registerTool(
  "ask_colleague",
  {
    description:
      "같은 연구의 동료 리서처에게 질문을 남긴다. 답을 기다리지 않고 요청 ID를 바로 돌려준다. " +
      "답은 이 턴이 끝난 뒤 다음 턴에 전달된다. 꼭 필요할 때만 쓴다.",
    inputSchema: {
      to: z.string().describe(`질문할 동료 ID. 가능한 값: ${tools.colleagues().join(", ")}`),
      question: z.string().describe("구체적인 질문 한 가지"),
    },
  },
  async ({ to, question }) => reply(tools.askColleague(to, question)),
);

server.registerTool(
  "check_answers",
  { description: "내가 동료에게 보낸 질문과 받은 답을 확인한다.", inputSchema: {} },
  async () => reply(tools.checkAnswers()),
);

process.on("exit", () => store.close());
await server.connect(new StdioServerTransport());
