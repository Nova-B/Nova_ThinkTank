// 사무실 웹 앱 서버.
//   npm run office               개발 모드 (Vite가 화면 코드를 바로 반영)
//   npm run office -- --prod     빌드된 화면(web/dist) 제공. 먼저 npm run build:web
// 옵션: --port 4317 --export-dir <볼트 폴더> --data-dir <폴더>. nova.config.json(Git 제외)에 exportDir을 둘 수 있다.
import { EventEmitter } from "node:events";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createApi, toStreamMessage } from "../http/app.js";
import { DEFAULT_LIMITS, Orchestrator } from "../office/orchestrator.js";
import { DEFAULT_ROSTER } from "../office/roster.js";
import { runTurn } from "../runner/turn.js";
import { Store } from "../store/store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);

const { values } = parseArgs({
  options: {
    port: { type: "string" },
    prod: { type: "boolean" },
    "export-dir": { type: "string" },
    "data-dir": { type: "string" },
  },
});

interface LocalConfig {
  exportDir?: string;
  port?: number;
}
const configFile = path.join(ROOT, "nova.config.json");
const config: LocalConfig = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {};

const dataDir = path.resolve(values["data-dir"] ?? process.env.NOVA_DATA_DIR ?? path.join(ROOT, "data"));
const exportDir = values["export-dir"] ?? process.env.NOVA_EXPORT_DIR ?? config.exportDir ?? null;
const wantedPort = Number(values.port ?? process.env.NOVA_PORT ?? config.port ?? 4317);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const store = new Store(path.join(dataDir, "nova.db"));
const bus = new EventEmitter();
bus.setMaxListeners(100);

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
  onEvent: (studyId, employee, event, id) => bus.emit("message", toStreamMessage(studyId, employee, event, id)),
});

let port = wantedPort;
const api = createApi({ store, orchestrator, roster: DEFAULT_ROSTER, bus, port: () => port, isAlive });
const stale = api.recoverStale(isAlive);
if (stale) console.log(`앱이 꺼져 멈춰 있던 연구 ${stale}개를 '멈춤'으로 표시했다`);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function serveStatic(dist: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://local").pathname);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    let file = path.join(dist, urlPath);
    // dist 밖으로 나가는 경로는 막고, 없는 경로는 index.html(SPA)
    const inside = !path.relative(dist, file).startsWith("..") && !path.isAbsolute(path.relative(dist, file));
    if (!inside || !existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, "index.html");
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    createReadStream(file)
      .on("error", () => res.destroy())
      .pipe(res);
  };
}

async function main() {
  const webRoot = path.join(ROOT, "web");
  let web: (req: IncomingMessage, res: ServerResponse) => void;
  let closeVite: (() => Promise<void>) | null = null;
  if (values.prod) {
    const dist = path.join(webRoot, "dist");
    if (!existsSync(dist)) throw new Error("web/dist가 없다. 먼저 npm run build:web");
    web = serveStatic(dist);
  } else {
    const { createServer: createVite } = await import("vite");
    const vite = await createVite({
      root: webRoot,
      configFile: path.join(webRoot, "vite.config.ts"),
      server: { middlewareMode: true, hmr: { port: wantedPort + 1 } },
      appType: "spa",
    });
    closeVite = () => vite.close();
    web = (req, res) => vite.middlewares(req, res);
  }

  // 화면 요청에서 난 예외가 연구를 돌리는 서버 전체를 죽이지 않게 한다
  const server = createServer(async (req, res) => {
    try {
      if (await api.handle(req, res)) return;
      web(req, res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  server.listen(wantedPort, "127.0.0.1", () => {
    port = (server.address() as AddressInfo).port;
    console.log(`🏢 Nova ThinkTank 사무실: http://127.0.0.1:${port}`);
    if (exportDir) console.log(`   보고서 내보내기: ${exportDir}`);
  });

  const shutdown = async () => {
    console.log("\n종료 중… 진행 중인 연구는 멈춤으로 남고, 다시 열면 이어서 실행할 수 있다.");
    // 직원 CLI가 고아 프로세스로 남지 않게 먼저 끊고, 각 연구가 '멈춤'을 기록할 때까지 기다린 뒤 DB를 닫는다
    await api.abortAll();
    server.close();
    await closeVite?.();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
