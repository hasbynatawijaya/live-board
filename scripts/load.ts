// Load test: N clients on one board. Measures how long an edit takes to reach
// the other clients, and how long everyone takes to resync after the server
// restarts. The server runs as its own process; clients share this process,
// so one clock measures both ends.
//
//   npm run load -- --clients 20 --edits 30
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import WebSocket from "ws";
import * as Y from "yjs";
import { BoardProvider } from "../src/client/provider";

const { values } = parseArgs({
  options: {
    clients: { type: "string", default: "20" },
    edits: { type: "string", default: "30" },
    port: { type: "string", default: "4321" },
  },
});
const CLIENTS = Number(values.clients);
const EDITS = Number(values.edits);
const PORT = Number(values.port);
const BOARD = `load-${Date.now()}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, timeoutMs: number) {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > timeoutMs) throw new Error("timed out");
    await sleep(5);
  }
  return performance.now() - start;
}

function startServer(dataDir: string): Promise<ChildProcess> {
  // One process (node with the tsx loader), so killing it really stops the server.
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve) => child.stdout!.once("data", () => resolve(child)));
}

function stopServer(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGKILL"); // a crash, not a clean shutdown
  });
}

function percentile(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

const dataDir = await mkdtemp(join(tmpdir(), "live-board-load-"));
let server = await startServer(dataDir);

type Client = { doc: Y.Doc; provider: BoardProvider; bench: Y.Map<number> };
const clients: Client[] = Array.from({ length: CLIENTS }, () => {
  const doc = new Y.Doc();
  const provider = new BoardProvider(`ws://localhost:${PORT}/board/${BOARD}`, doc, {
    WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
  });
  return { doc, provider, bench: doc.getMap<number>("bench") };
});
const allSynced = () => clients.every((c) => c.provider.status.state === "connected" && c.provider.status.synced);
await waitFor(allSynced, 20_000);
console.error(`${CLIENTS} clients synced`);

// Each write stores its send time under a unique key; every other client
// records how long it took to see that key.
const latencies: number[] = [];
const sentAt = new Map<string, number>();
for (const c of clients) {
  c.bench.observe((event) => {
    if (event.transaction.local) return;
    const now = performance.now();
    for (const key of event.keysChanged) {
      const t = sentAt.get(key);
      if (t !== undefined) latencies.push(now - t);
    }
  });
}

const expected = CLIENTS * EDITS * (CLIENTS - 1);
for (let round = 0; round < EDITS; round++) {
  for (const [i, c] of clients.entries()) {
    const key = `${i}:${round}`;
    sentAt.set(key, performance.now());
    c.bench.set(key, round);
  }
  await sleep(50);
}
console.error(`writes sent, waiting for ${expected} deliveries`);
await waitFor(() => latencies.length >= expected, 30_000).catch((e) => {
  console.error(`only ${latencies.length} of ${expected} deliveries arrived`);
  throw e;
});
latencies.sort((a, b) => a - b);

// Recovery: kill the server mid-session, edit while it's down, restart it.
await stopServer(server);
await waitFor(() => clients.every((c) => c.provider.status.state !== "connected"), 10_000);
clients[0]!.bench.set("offline-edit", 1);
await sleep(1000);
const restartedAt = performance.now();
server = await startServer(dataDir);
await waitFor(allSynced, 60_000);
const resyncMs = performance.now() - restartedAt;
await waitFor(() => clients.every((c) => c.bench.get("offline-edit") === 1), 10_000);
const offlineEditMs = performance.now() - restartedAt;

console.log(JSON.stringify({
  clients: CLIENTS,
  editsPerClient: EDITS,
  deliveries: latencies.length,
  latencyMs: {
    p50: +percentile(latencies, 50).toFixed(1),
    p95: +percentile(latencies, 95).toFixed(1),
    max: +latencies[latencies.length - 1]!.toFixed(1),
  },
  afterServerRestart: {
    allClientsResyncedMs: Math.round(resyncMs),
    offlineEditEverywhereMs: Math.round(offlineEditMs),
  },
}, null, 2));

clients.forEach((c) => c.provider.destroy());
await stopServer(server);
await rm(dataDir, { recursive: true, force: true });
process.exit(0);
