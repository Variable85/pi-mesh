// shared/paths.ts — runtime/state directory resolution (D19). No Pi imports (I9).
import os from "node:os";
import path from "node:path";

export const BROKER_SOCK_NAME = "broker.sock";
export const BROKER_LOCK_NAME = "broker.lock";
export const RUNTIME_DIR_PREFIX = "mesh-";
export const STATE_DIR_NAME = ".mesh";
export const POLICY_FILE_NAME = "policy.json";
export const CONFIG_FILE_NAME = "config.json";
export const LEDGER_FILE_NAME = "ledger.jsonl";

/** Runtime dir (socket, lock): $MESH_RUNTIME_DIR or $TMPDIR/mesh-<uid>. */
export function runtimeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MESH_RUNTIME_DIR;
  if (override && override.trim().length > 0) return override;
  return path.join(os.tmpdir(), `${RUNTIME_DIR_PREFIX}${os.userInfo().uid}`);
}

/** State dir (ledger, transcripts, policy, config): $MESH_STATE_DIR or <cwd>/.mesh. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MESH_STATE_DIR;
  if (override && override.trim().length > 0) return override;
  return path.join(process.cwd(), STATE_DIR_NAME);
}

export function brokerSocketPath(dir?: string): string {
  return path.join(dir ?? runtimeDir(), BROKER_SOCK_NAME);
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

const SAFE_STEM_REGEX = /[^a-zA-Z0-9._-]/g;
const SAFE_STEM_FALLBACK = "x";

/** Filesystem-safe stem for per-alias files (ledger, transcripts). */
export function safeFileStem(alias: string): string {
  const cleaned = alias.trim().replace(SAFE_STEM_REGEX, SAFE_STEM_FALLBACK);
  return cleaned.length > 0 ? cleaned : SAFE_STEM_FALLBACK;
}
