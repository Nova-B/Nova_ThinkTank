// M0 스파이크용 사내 메신저 MCP 서버 (stdio). 직원 CLI가 자식 프로세스로 띄운다.
// ask_colleague 는 답을 기다리지 않고 요청 ID를 바로 돌려준다(비동기 큐). 답은 오케스트레이터가
// 상대 직원의 턴을 돌려 채우고, 질문한 직원은 다음 턴에 check_answers 로 받는다.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export interface AskRequest {
  id: string;
  from: string;
  to: string;
  question: string;
  answer?: string;
  askedAt: string;
  answeredAt?: string;
}

const stateDir = process.env.OFFICE_STATE_DIR;
const employeeId = process.env.OFFICE_EMPLOYEE_ID;
const colleagues = (process.env.OFFICE_COLLEAGUES ?? "").split(",").filter(Boolean);
if (!stateDir || !employeeId) {
  console.error("OFFICE_STATE_DIR, OFFICE_EMPLOYEE_ID 가 필요하다");
  process.exit(2);
}
const queueFile = path.join(stateDir, "asks.json");

function load(): AskRequest[] {
  return existsSync(queueFile) ? (JSON.parse(readFileSync(queueFile, "utf8")) as AskRequest[]) : [];
}
function save(items: AskRequest[]): void {
  mkdirSync(stateDir!, { recursive: true });
  writeFileSync(queueFile, JSON.stringify(items, null, 2));
}

const server = new McpServer({ name: "office", version: "0.0.0" });

server.registerTool(
  "ask_colleague",
  {
    description:
      "동료 직원에게 질문을 남긴다. 답을 기다리지 않고 요청 ID를 바로 돌려준다. 답은 다음 턴에 check_answers 로 확인한다.",
    inputSchema: {
      to: z.string().describe(`질문할 동료 ID. 가능한 값: ${colleagues.join(", ")}`),
      question: z.string().describe("질문 내용"),
    },
  },
  async ({ to, question }) => {
    if (!colleagues.includes(to)) {
      return { isError: true, content: [{ type: "text", text: `알 수 없는 동료: ${to}` }] };
    }
    const items = load();
    const req: AskRequest = {
      id: randomUUID(),
      from: employeeId,
      to,
      question,
      askedAt: new Date().toISOString(),
    };
    items.push(req);
    save(items);
    return { content: [{ type: "text", text: `접수됨. 요청 ID: ${req.id}` }] };
  },
);

server.registerTool(
  "check_answers",
  { description: "내가 동료에게 한 질문들의 답을 확인한다.", inputSchema: {} },
  async () => {
    const mine = load().filter((r) => r.from === employeeId);
    const text = mine.length
      ? mine
          .map((r) => `[${r.id}] ${r.to}에게: ${r.question}\n→ ${r.answer ?? "(아직 답 없음)"}`)
          .join("\n\n")
      : "보낸 질문이 없다.";
    return { content: [{ type: "text", text }] };
  },
);

await server.connect(new StdioServerTransport());
