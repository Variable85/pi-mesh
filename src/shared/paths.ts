// shared/paths.ts — runtime/state directory resolution (D19). No Pi imports (I9).
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export const BROKER_SOCK_NAME = "broker.sock";
export const BROKER_LOCK_NAME = "broker.lock";
export const RUNTIME_DIR_PREFIX = "mesh-";
export const STATE_DIR_NAME = ".mesh";
export const POLICY_FILE_NAME = "policy.json";
export const CONFIG_FILE_NAME = "config.json";
export const LEDGER_FILE_NAME = "ledger.jsonl";

/** True on win32: AF_UNIX is unavailable there (listen → EACCES on most
 *  builds), so brokerSocketPath falls back to named pipes. */
export const IS_WINDOWS: boolean = process.platform === "win32";

/** Runtime dir (socket, lock): $MESH_RUNTIME_DIR or $TMPDIR/mesh-<uid>. */
export function runtimeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MESH_RUNTIME_DIR;
  if (override && override.trim().length > 0) return override;
  let uid = "0";
  try {
    uid = String(os.userInfo().uid);
  } catch {
    // uid unavailable (unusual) → stable fallback
  }
  return path.join(os.tmpdir(), `${RUNTIME_DIR_PREFIX}${uid}`);
}

/** State dir (ledger, transcripts, policy, config): $MESH_STATE_DIR or <cwd>/.mesh. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MESH_STATE_DIR;
  if (override && override.trim().length > 0) return override;
  return path.join(process.cwd(), STATE_DIR_NAME);
}

/**
 * Socket endpoint for a given runtime dir.
 *
 * Windows: AF_UNIX sockets are unsupported (server.listen on a path throws
 * EACCES on win32) → use a named pipe instead. The pipe name is derived from
 * a stable hash of the dir so every process agrees on the endpoint while
 * different runtime dirs (hermetic tests, MESH_RUNTIME_DIR overrides) stay
 * isolated. Pipes are kernel objects: no file to clean up, and stale pipes
 * simply refuse connections.
 *
 * POSIX: <dir>/broker.sock as before.
 */
export function socketPathForDir(dir: string): string {
  if (IS_WINDOWS) {
    const hash = createHash("sha256")
      .update(path.resolve(dir))
      .digest("hex")
      .slice(0, 12);
    return `\\\\.\\pipe\\${RUNTIME_DIR_PREFIX}${hash}-broker`;
  }
  return path.join(dir, BROKER_SOCK_NAME);
}

export function brokerSocketPath(dir?: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MESH_RUNTIME_DIR;
  if (override && override.trim().length > 0) return socketPathForDir(override);
  return socketPathForDir(dir ?? runtimeDir(env));
}

export function brokerLockPath(dir?: string): string {
  return path.join(dir ?? runtimeDir(), BROKER_LOCK_NAME);
}

export function policyPath(dir?: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MESH_POLICY;
  if (override && override.trim().length > 0) return override;
  return path.join(dir ?? stateDir(env), POLICY_FILE_NAME);
}

export function configPath(dir?: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dir ?? stateDir(env), CONFIG_FILE_NAME);
}

export function ledgerPath(dir?: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dir ?? stateDir(env), LEDGER_FILE_NAME);
}

