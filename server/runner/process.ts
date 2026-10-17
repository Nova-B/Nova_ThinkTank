import { spawn, execFileSync } from "node:child_process";

export interface ProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  stdin: string;
  deadlineMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  onLine: (line: string) => void;
}

export type StopReason = "deadline" | "output_limit" | "aborted" | "handler_error" | null;

export interface ProcessResult {
  exitCode: number | null;
  stderr: string;
  stopReason: StopReason;
  /** onLine이 던진 예외. 스트림 콜백 밖으로 새면 프로세스 전체가 죽으므로 잡아서 여기로 돌려준다 */
  handlerError: Error | null;
  durationMs: number;
}

// Windows에서는 child.kill()이 손자 프로세스(CLI가 띄운 MCP 서버 등)를 남길 수 있어 트리째 종료한다.
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // 이미 끝난 프로세스
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 이미 끝난 프로세스
    }
  }
}

const MAX_STDERR_CHARS = 64_000;

/** 셸 없이 프로세스를 띄우고 stdout을 줄 단위로 넘긴다. 마감·출력 상한·취소 시 트리째 종료한다. */
export function runProcess(opts: ProcessOptions): Promise<ProcessResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      resolve({ exitCode: null, stderr: "", stopReason: "aborted", handlerError: null, durationMs: 0 });
      return;
    }
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let stopReason: StopReason = null;
    let handlerError: Error | null = null;
    let outBytes = 0;
    let buffer = "";
    let stderr = "";

    const stop = (reason: Exclude<StopReason, null>) => {
      if (stopReason) return;
      stopReason = reason;
      if (child.pid) killTree(child.pid);
    };
    const timer = setTimeout(() => stop("deadline"), opts.deadlineMs);
    const onAbort = () => stop("aborted");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const emit = (raw: string) => {
      const line = raw.trim();
      if (!line || handlerError) return;
      try {
        opts.onLine(line);
      } catch (err) {
        handlerError = err instanceof Error ? err : new Error(String(err));
        stop("handler_error");
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outBytes += Buffer.byteLength(chunk);
      if (outBytes > opts.maxOutputBytes) {
        stop("output_limit");
        return;
      }
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        emit(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.slice(0, MAX_STDERR_CHARS - stderr.length);
    });
    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (exitCode) => {
      cleanup();
      if (!stopReason) emit(buffer); // 마지막 줄에 개행이 없어도 읽는다
      resolve({ exitCode, stderr, stopReason, handlerError, durationMs: Date.now() - started });
    });

    // CLI가 stdin을 다 읽기 전에 끝나면 EPIPE가 난다. 결과는 close에서 판단한다.
    child.stdin.on("error", () => {});
    child.stdin.end(opts.stdin);
  });
}
