import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Engine } from "./types.js";

export interface Executable {
  command: string;
  prefixArgs: string[];
}

function npmGlobalRoot(): string | null {
  if (process.env.APPDATA) {
    const guess = path.join(process.env.APPDATA, "npm", "node_modules");
    if (existsSync(guess)) return guess;
  }
  try {
    // 고정 인자뿐이라 shell 사용이 주입 위험을 만들지 않는다. Windows의 npm.cmd는 shell 없이 못 띄운다.
    return execFileSync("npm", ["root", "-g"], { encoding: "utf8", shell: true }).trim();
  } catch {
    return null;
  }
}

const cache = new Map<Engine, Executable>();

/**
 * Windows에서 spawn("claude")는 ENOENT, "claude.cmd"는 EINVAL이다(M0 스파이크).
 * 그래서 실제 실행 파일을 찾아 셸 없이 띄운다. NOVA_CLAUDE_BIN / NOVA_CODEX_JS로 덮어쓸 수 있다.
 */
export function resolveExecutable(engine: Engine): Executable {
  const hit = cache.get(engine);
  if (hit) return hit;
  let found: Executable;
  if (engine === "claude") {
    const override = process.env.NOVA_CLAUDE_BIN;
    const root = override ? null : npmGlobalRoot();
    const exe = override ?? (root && path.join(root, "@anthropic-ai", "claude-code", "bin", "claude.exe"));
    found = exe && existsSync(exe) ? { command: exe, prefixArgs: [] } : { command: "claude", prefixArgs: [] };
  } else {
    const override = process.env.NOVA_CODEX_JS;
    const root = override ? null : npmGlobalRoot();
    const js = override ?? (root && path.join(root, "@openai", "codex", "bin", "codex.js"));
    found =
      js && existsSync(js)
        ? { command: process.execPath, prefixArgs: [js] }
        : { command: "codex", prefixArgs: [] };
  }
  cache.set(engine, found);
  return found;
}
