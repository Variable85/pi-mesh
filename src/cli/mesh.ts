// cli/mesh.ts — debug/admin CLI. Ephemeral clients: alias cli-<rand6>.
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { MeshClient, type SendResult } from "../client/client.js";
import { connectProbe } from "../client/reconnect.js";
import { ALIAS_RAND_CHARS, STATUS_REQ_TIMEOUT_MS } from "../shared/config.js";
import { loadConfig } from "../shared/config.js";
import {
  brokerLockPath,
  brokerSocketPath,
  configPath,
  ledgerPath,
  runtimeDir,
  stateDir,
} from "../shared/paths.js";
import { randomBytes } from "node:crypto";

const TAIL_LINES = 20;
const CLI_SEND_TIMEOUT_MS = 30_000;

function cliAlias(): string {
  return `cli-${randomBytes(ALIAS_RAND_CHARS / 2).toString("hex").slice(0, ALIAS_RAND_CHARS)}`;
}

function argValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function printResult(r: SendResult): void {
  switch (r.status) {
    case "delivered":
      process.stdout.write(`delivered ${r.msgId}\n`);
      break;
    case "queued_offline":
      process.stdout.write(`queued_offline ${r.msgId}\n`);
      break;
    case "reply":
      process.stdout.write(`reply ${r.msgId}: ${r.response}\n`);
      break;
    case "expired":
      process.stdout.write(`expired ${r.msgId ?? ""}\n`);
      break;
    case "blocked":
      process.stdout.write(`blocked: ${r.reason}\n`);
      break;
    case "error":
      process.stdout.write(`error: ${r.reason}\n`);
      break;
  }
}

async function cmdBroker(sub: string | undefined): Promise<number> {
  const dir = runtimeDir();
  const sock = brokerSocketPath(dir);
  switch (sub) {
    case "start": {
      const { spawn } = await import("node:child_process");
      const { brokerEntryPath } = await import("../client/reconnect.js");
      const child = spawn(process.execPath, [brokerEntryPath()], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, MESH_RUNTIME_DIR: dir },
      });
      child.unref();
      process.stdout.write(`broker spawned pid=${child.pid ?? "?"} sock=${sock}\n`);
      return 0;
    }
    case "stop": {
      try {
        const pid = Number(readFileSync(brokerLockPath(dir), "utf8").trim());
        if (Number.isFinite(pid) && pidAlive(pid)) {
          process.kill(pid, "SIGTERM");
          process.stdout.write(`SIGTERM sent to broker pid=${pid}\n`);
          return 0;
        }
      } catch {
  // no lock
      }
      process.stdout.write("no live broker lock found\n");
      return 1;
    }
    case "status": {
      const alive = await connectProbe(sock, STATUS_REQ_TIMEOUT_MS);
      let pid = "?";
      try {
        pid = readFileSync(brokerLockPath(dir), "utf8").trim();
      } catch {
  // no lock
      }
      process.stdout.write(`socket=${sock} reachable=${alive} lockPid=${pid}\n`);
      return alive ? 0 : 1;
    }
    default:
      process.stderr.write("usage: mesh broker start|stop|status\n");
      return 2;
  }
}

async function cmdPeers(args: string[]): Promise<number> {
  const room = argValue(args, "--room");
  const client = new MeshClient({ alias: cliAlias(), noReconnect: true });
  try {
    await client.connect();
  } catch {
    process.stdout.write("blocked: broker_unavailable\n");
    return 1;
  }
  const snap = await client.status(room);
  // M1/M2: per-peer extension version + broker counters in the CLI too
  for (const p of snap.peers) {
    const v = p.clientVersion !== undefined && p.clientVersion !== "" ? `v${p.clientVersion}` : "v?";
    process.stdout.write(`${p.alias}\trooms=${p.rooms.join(",")}\tv=${v}\tsince=${p.since ?? "?"}\n`);
  }
  if (snap.stats !== undefined) {
    const s = snap.stats;
    process.stdout.write(`broker: relayed=${s.relayed} refused=${s.refused} mailboxDelivered=${s.mailboxDelivered} mailboxDropped=${s.mailboxDropped}\n`);
  }
  await client.close();
  return 0;
}

async function cmdSend(args: string[]): Promise<number> {
  const [to, ...rest] = args.filter((a) => !a.startsWith("--"));
  const text = rest.join(" ");
  if (!to || text === "") {
    process.stderr.write("usage: mesh send <alias> <texte> [--room R] [--await] [--timeout MS]\n");
    return 2;
  }
  const client = new MeshClient({ alias: cliAlias(), noReconnect: true });
  const result = await client.send({
    to,
    message: text,
    room: argValue(args, "--room"),
    awaitReply: hasFlag(args, "--await"),
    timeoutMs: Number(argValue(args, "--timeout") ?? CLI_SEND_TIMEOUT_MS),
  });
  printResult(result);
  await client.close();
  return result.status === "error" || result.status === "blocked" ? 1 : 0;
}

async function cmdRoom(args: string[], sub: string): Promise<number> {
  const room = args[0];
  if (room === undefined) {
    process.stderr.write(`usage: mesh ${sub} <room>
`);
    return 2;
  }
  const client = new MeshClient({ alias: cliAlias(), noReconnect: true });
  try {
    await client.connect();
    if (sub === "join") {
      await client.join(room, args.includes("observer") ? "observer" : "member");
      process.stdout.write(`joined ${room}
`);
    } else if (sub === "leave") {
      await client.leave(room);
      process.stdout.write(`left ${room}
`);
    } else if (sub === "status") {
      const snap = await client.status(room);
      for (const p of snap.peers) {
        process.stdout.write(`${p.alias}	rooms=${p.rooms.join(",")}	since=${p.since ?? "?"}
`);
      }
    }
  } catch (err) {
    process.stderr.write(`${sub} failed: ${err instanceof Error ? err.message : String(err)}
`);
    await client.close();
    return 1;
  }
  await client.close();
  return 0;
}

async function cmdReserve(args: string[]): Promise<number> {
  const paths = args.filter((a) => !a.startsWith("--") && !a.startsWith("reason"));
  const reasonIdx = args.indexOf("--reason");
  const reason = reasonIdx !== -1 ? args[reasonIdx + 1] : undefined;
  if (paths.length === 0) {
    process.stderr.write("usage: mesh reserve <path> [--reason R]\n");
    return 2;
  }
  const client = new MeshClient({ alias: cliAlias(), noReconnect: true });
  try {
    await client.connect();
    const res = await client.reserve(paths, reason);
    if (res.status === "delivered") {
      process.stdout.write(`reserved ${paths.join(", ")}
`);
      await new Promise((r) => setTimeout(r, 1500)); // keep the claim alive a moment
    } else {
      process.stderr.write(`reserve failed: ${"reason" in res ? res.reason : res.status}
`);
    }
    await client.close();
    return res.status === "delivered" ? 0 : 1;
  } catch (err) {
    process.stderr.write(`reserve failed: ${err instanceof Error ? err.message : String(err)}
`);
    await client.close();
    return 1;
  }
}

async function cmdTail(): Promise<number> {
  const path = ledgerPath(stateDir());
  if (!existsSync(path)) {
    process.stdout.write("(no ledger)\n");
    return 0;
  }
  const content = await readFile(path, "utf8");
  const lines = content.split("\n").filter((l) => l.trim() !== "");
  for (const line of lines.slice(-TAIL_LINES)) process.stdout.write(line + "\n");
  return 0;
}

async function cmdDoctor(): Promise<number> {
  const dir = runtimeDir();
  const sock = brokerSocketPath(dir);
  const lock = brokerLockPath(dir);
  const cfg = loadConfig(stateDir());
  const url = cfg.brokerUrl;
  const listen = cfg.listen;
  const reachable = url !== undefined
    ? await connectProbe(
        url.startsWith("unix://") ? url.slice("unix://".length) : url,
        STATUS_REQ_TIMEOUT_MS,
      )
    : await connectProbe(sock, STATUS_REQ_TIMEOUT_MS);
  let lockInfo = "absent";
  let stale = false;
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8").trim());
    if (Number.isFinite(pid)) {
      const alive = pidAlive(pid);
      lockInfo = `pid=${pid} alive=${alive}`;
      stale = !alive;
    } else {
      lockInfo = "present (no pid)";
    }
  }
  let cfgInfo = "absent (defaults)";
  if (existsSync(configPath(stateDir()))) cfgInfo = configPath(stateDir());
  process.stdout.write(
    [
      `runtimeDir: ${dir}`,
      `socket: ${sock} reachable=${reachable}`,
      `lock: ${lockInfo}${stale ? " STALE" : ""}`,
      `config: ${cfgInfo}`,
      `protocol: mesh.v1`,
    ].join("\n") + "\n",
  );
  return reachable ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "broker":
      return cmdBroker(args[0]);
    case "peers":
      return cmdPeers(args);
    case "send":
      return cmdSend(args);
    case "tail":
      return cmdTail();
    case "doctor":
      return cmdDoctor();
    default:
      process.stderr.write(
        "usage: mesh broker start|stop|status | peers [--room R] | send <alias> <texte> [--room R] [--await] [--timeout MS] | tail | doctor\n",
      );
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`mesh cli fatal: ${String(err)}\n`);
    process.exit(1);
  });
