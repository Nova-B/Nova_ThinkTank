// M0 스파이크용 CLI 실행기. 제품 코드가 아니라 현재 CLI 버전의 동작을 확인하기 위한 최소 구현이다.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Engine = "claude" | "codex";

export interface Executable {
  command: string;
  prefixArgs: string[];
}

export interface TurnResult {
  exitCode: number | null;
  events: Record<string, unknown>[];
  stderr: string;
  durationMs: number;
  /** 종료를 요청했는지. 실제로 트리가 종료됐는지는 따로 확인하지 않는다. */
  killRequested: boolean;
}

export const SPIKE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const LOG_DIR = path.join(SPIKE_DIR, "logs");
const DEFAULT_DEADLINE_MS = 5 * 60_000;

function npmGlobalRoot(): string | null {
  if (process.env.APPDATA) {
    const guess = path.join(process.env.APPDATA, "npm", "node_modules");
    if (existsSync(guess)) return guess;
  }
  try {
    // 고정 인자만 넘기므로 shell 사용이 주입 위험을 만들지 않는다. Windows의 npm.cmd 는 shell 없이 못 띄운다.
    return execFileSync("npm", ["root", "-g"], { encoding: "utf8", shell: true }).trim();
  } catch {
    return null;
  }
}

// Windows에서 spawn("claude")는 ENOENT, "claude.cmd"는 EINVAL 이다 → 실제 실행 파일을 직접 띄운다.
export function resolveExecutable(engine: Engine): Executable {
  const root = npmGlobalRoot();
  if (engine === "claude") {
    const exe = root && path.join(root, "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (exe && existsSync(exe)) return { command: exe, prefixArgs: [] };
    return { command: "claude", prefixArgs: [] };
  }
  const js = root && path.join(root, "@openai", "codex", "bin", "codex.js");
  if (js && existsSync(js)) return { command: process.execPath, prefixArgs: [js] };
  return { command: "codex", prefixArgs: [] };
}

export interface RunOptions {
  engine: Engine;
  args: string[];
  prompt: string;
  cwd: string;
  logName: string;
  env?: Record<string, string>;
  killAfterMs?: number;
  onEvent?: (event: Record<string, unknown>) => void;
}

// Windows에서는 child.kill()이 손자 프로세스(MCP 서버 등)를 남길 수 있어 트리째 종료한다.
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // 이미 끝난 프로세스
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      process.kill(pid, "SIGKILL");
    }
  }
}

export function runTurn(opts: RunOptions): Promise<TurnResult> {
  const exe = resolveExecutable(opts.engine);
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(opts.cwd, { recursive: true });
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(exe.command, [...exe.prefixArgs, ...opts.args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const events: Record<string, unknown>[] = [];
    const rawLines: string[] = [];
    let buffer = "";
    let stderr = "";
    let killRequested = false;
    const kill = () => {
      killRequested = true;
      if (child.pid) killTree(child.pid);
    };
    // 스파이크라도 멈춘 CLI가 영원히 붙잡지 않도록 기본 상한을 둔다
    const timer = setTimeout(kill, opts.killAfterMs ?? DEFAULT_DEADLINE_MS);

    const handleLine = (raw: string) => {
      const line = raw.trim();
      if (!line) return;
      rawLines.push(line);
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return; // JSON이 아닌 줄은 원본 로그에만 남긴다
      }
      events.push(event);
      opts.onEvent?.(event); // 콜백 예외는 삼키지 않는다
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      handleLine(buffer); // 마지막 줄에 개행이 없어도 이벤트로 읽는다
      writeFileSync(path.join(LOG_DIR, `${opts.logName}.jsonl`), rawLines.join("\n") + "\n");
      if (stderr) writeFileSync(path.join(LOG_DIR, `${opts.logName}.stderr.txt`), stderr);
      resolve({ exitCode, events, stderr, durationMs: Date.now() - started, killRequested });
    });

    // CLI가 stdin을 읽기 전에 끝나면 EPIPE가 난다. 결과는 close 이벤트로 판단한다.
    child.stdin.on("error", () => {});
    child.stdin.end(opts.prompt);
  });
}

export function claudeArgs(o: {
  model?: string;
  sessionId?: string;
  resume?: string;
  system?: string;
  mcpConfig?: object;
  allowedTools?: string[];
  tools?: string;
  extra?: string[];
}): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (o.model) args.push("--model", o.model);
  if (o.sessionId) args.push("--session-id", o.sessionId);
  if (o.resume) args.push("--resume", o.resume);
  if (o.system) args.push("--append-system-prompt", o.system);
  if (o.tools !== undefined) args.push("--tools", o.tools);
  if (o.mcpConfig) args.push("--mcp-config", JSON.stringify(o.mcpConfig), "--strict-mcp-config");
  if (o.allowedTools?.length) args.push("--allowedTools", o.allowedTools.join(","));
  if (o.extra) args.push(...o.extra);
  return args;
}

export interface CodexMcp {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  approveTools: string[];
}

export function codexArgs(o: {
  model?: string;
  effort?: string;
  resume?: string;
  developerInstructions?: string;
  mcp?: CodexMcp;
  ignoreUserConfig?: boolean;
  sandbox?: "read-only" | "workspace-write";
  extra?: string[];
}): string[] {
  const args = o.resume ? ["exec", "resume", o.resume] : ["exec"];
  args.push("--json", "--skip-git-repo-check");
  if (o.ignoreUserConfig) args.push("--ignore-user-config");
  // `exec resume` 에는 --sandbox 플래그가 없어 -c 로 통일한다.
  args.push("-c", `sandbox_mode="${o.sandbox ?? "read-only"}"`);
  if (o.model) args.push("--model", o.model);
  if (o.effort) args.push("-c", `model_reasoning_effort="${o.effort}"`);
  if (o.developerInstructions) {
    args.push("-c", `developer_instructions=${JSON.stringify(o.developerInstructions)}`);
  }
  if (o.mcp) {
    const p = `mcp_servers.${o.mcp.name}`;
    args.push("-c", `${p}.command=${JSON.stringify(o.mcp.command)}`);
    args.push("-c", `${p}.args=${JSON.stringify(o.mcp.args)}`);
    const env = Object.entries(o.mcp.env)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(", ");
    args.push("-c", `${p}.env={ ${env} }`);
    for (const tool of o.mcp.approveTools) {
      args.push("-c", `${p}.tools.${tool}.approval_mode="approve"`);
    }
  }
  if (o.extra) args.push(...o.extra);
  args.push("-");
  return args;
}

export function saveJson(name: string, data: unknown): void {
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(path.join(LOG_DIR, name), JSON.stringify(data, null, 2) + "\n");
}
