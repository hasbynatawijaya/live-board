import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { join } from "node:path";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import { WebSocket, WebSocketServer } from "ws";
import * as Y from "yjs";
import { MAX_MESSAGE_BYTES, MESSAGE_AWARENESS, MESSAGE_PING, MESSAGE_PONG, MESSAGE_SYNC, ROOM_PATTERN } from "../shared/protocol";

type Room = {
  name: string;
  doc: Y.Doc;
  awareness: Awareness;
  // Awareness client ids each connection controls, so they can be removed
  // when that connection drops.
  conns: Map<WebSocket, Set<number>>;
  dirty: boolean;
};

export type BoardServerOptions = {
  port: number;
  dataDir: string;
  snapshotIntervalMs?: number;
  // How long a dead socket may stay silent before it is dropped.
  heartbeatMs?: number;
};

export type BoardServer = {
  port: number;
  close: () => Promise<void>;
  roomCount: () => number;
};

export async function startBoardServer(options: BoardServerOptions): Promise<BoardServer> {
  const { dataDir, snapshotIntervalMs = 2000, heartbeatMs = 30_000 } = options;
  await mkdir(dataDir, { recursive: true });

  const rooms = new Map<string, Promise<Room>>();
  const alive = new WeakMap<WebSocket, boolean>();
  // Saves started in the background; close() waits for them so a restart
  // never reads a snapshot that is still being written.
  const pendingSaves = new Set<Promise<void>>();

  const http: Server = createHttpServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_MESSAGE_BYTES });

  function snapshotPath(name: string) {
    return join(dataDir, `${name}.bin`);
  }

  function saveRoom(room: Room): Promise<void> {
    if (!room.dirty) return Promise.resolve();
    room.dirty = false;
    const tmp = `${snapshotPath(room.name)}.tmp`;
    const state = Y.encodeStateAsUpdate(room.doc);
    // Write then rename, so a crash mid-write never leaves a half snapshot.
    const saving = writeFile(tmp, state).then(() => rename(tmp, snapshotPath(room.name)));
    pendingSaves.add(saving);
    void saving.finally(() => pendingSaves.delete(saving));
    return saving;
  }

  function loadRoom(name: string): Promise<Room> {
    const existing = rooms.get(name);
    if (existing) return existing;

    const loading = (async () => {
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, await readFile(snapshotPath(name)));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const awareness = new Awareness(doc);
      // The server has no presence of its own.
      awareness.setLocalState(null);
      const room: Room = { name, doc, awareness, conns: new Map(), dirty: false };

      doc.on("update", (update: Uint8Array, origin: unknown) => {
        room.dirty = true;
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeUpdate(encoder, update);
        broadcast(room, encoding.toUint8Array(encoder), origin);
      });

      awareness.on(
        "update",
        ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
          const changed = [...added, ...updated, ...removed];
          if (origin instanceof WebSocket) {
            const owned = room.conns.get(origin);
            if (owned) {
              added.forEach((id) => owned.add(id));
              removed.forEach((id) => owned.delete(id));
            }
          }
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
          encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, changed));
          broadcast(room, encoding.toUint8Array(encoder), null);
        },
      );
      return room;
    })();

    rooms.set(name, loading);
    loading.catch(() => rooms.delete(name));
    return loading;
  }

  function broadcast(room: Room, message: Uint8Array, except: unknown) {
    for (const conn of room.conns.keys()) {
      if (conn !== except) send(conn, message);
    }
  }

  function send(conn: WebSocket, message: Uint8Array) {
    if (conn.readyState === WebSocket.OPEN) conn.send(message);
  }

  wss.on("connection", async (conn, req) => {
    const name = new URL(req.url ?? "/", "http://x").pathname.replace(/^\/board\//, "");
    if (!ROOM_PATTERN.test(name)) {
      conn.close(1008, "invalid board name");
      return;
    }
    conn.binaryType = "arraybuffer";
    alive.set(conn, true);
    conn.on("pong", () => alive.set(conn, true));

    // Buffer messages that arrive while the room loads from disk.
    const early: ArrayBuffer[] = [];
    conn.on("message", (data: ArrayBuffer) => early.push(data));

    const room = await loadRoom(name);
    room.conns.set(conn, new Set());
    conn.removeAllListeners("message");

    const handle = (data: ArrayBuffer) => {
      try {
        const decoder = decoding.createDecoder(new Uint8Array(data));
        const encoder = encoding.createEncoder();
        const type = decoding.readVarUint(decoder);
        switch (type) {
          case MESSAGE_SYNC:
            encoding.writeVarUint(encoder, MESSAGE_SYNC);
            syncProtocol.readSyncMessage(decoder, encoder, room.doc, conn);
            // Only send when readSyncMessage wrote a reply (sync step 2).
            if (encoding.length(encoder) > 1) send(conn, encoding.toUint8Array(encoder));
            break;
          case MESSAGE_AWARENESS:
            applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), conn);
            break;
          case MESSAGE_PING:
            encoding.writeVarUint(encoder, MESSAGE_PONG);
            send(conn, encoding.toUint8Array(encoder));
            break;
          default:
            conn.close(1003, "unknown message type");
        }
      } catch {
        conn.close(1007, "malformed message");
      }
    };
    conn.on("message", handle);
    early.forEach(handle);

    conn.on("close", () => {
      const owned = room.conns.get(conn);
      room.conns.delete(conn);
      if (owned && owned.size > 0) removeAwarenessStates(room.awareness, [...owned], null);
      if (room.conns.size === 0) {
        void saveRoom(room).then(() => {
          // Unload idle rooms; a new connection reloads from the snapshot.
          if (room.conns.size === 0) {
            room.awareness.destroy();
            room.doc.destroy();
            rooms.delete(room.name);
          }
        });
      }
    });

    // Start the handshake: our state vector, then everyone's presence.
    const step1 = encoding.createEncoder();
    encoding.writeVarUint(step1, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(step1, room.doc);
    send(conn, encoding.toUint8Array(step1));

    const states = [...room.awareness.getStates().keys()];
    if (states.length > 0) {
      const presence = encoding.createEncoder();
      encoding.writeVarUint(presence, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(presence, encodeAwarenessUpdate(room.awareness, states));
      send(conn, encoding.toUint8Array(presence));
    }
  });

  // Drop sockets that stopped answering pings (a laptop lid closed, a dead network).
  const heartbeat = setInterval(() => {
    for (const conn of wss.clients) {
      if (alive.get(conn) === false) {
        conn.terminate();
        continue;
      }
      alive.set(conn, false);
      conn.ping();
    }
  }, heartbeatMs);

  const snapshots = setInterval(async () => {
    for (const loading of rooms.values()) await saveRoom(await loading);
  }, snapshotIntervalMs);

  await new Promise<void>((resolve) => http.listen(options.port, resolve));
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : options.port;

  return {
    port,
    roomCount: () => rooms.size,
    close: async () => {
      clearInterval(heartbeat);
      clearInterval(snapshots);
      for (const conn of wss.clients) conn.terminate();
      for (const loading of rooms.values()) await saveRoom(await loading);
      await Promise.all(pendingSaves);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
