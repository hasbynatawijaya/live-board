import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import { addNote, listNotes, moveNote, setText } from "../client/board";
import { BoardProvider } from "../client/provider";
import { startBoardServer, type BoardServer } from "./server";

let dataDir: string;
let server: BoardServer;
const providers: BoardProvider[] = [];

async function waitFor(check: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function client(room = "test-room") {
  const doc = new Y.Doc();
  const provider = new BoardProvider(`ws://localhost:${server.port}/board/${room}`, doc, {
    WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
  });
  providers.push(provider);
  return { doc, provider };
}

const synced = (p: BoardProvider) => p.status.state === "connected" && p.status.synced;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "live-board-"));
  server = await startBoardServer({ port: 0, dataDir, snapshotIntervalMs: 100 });
});

afterEach(async () => {
  providers.splice(0).forEach((p) => p.destroy());
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("sync through the server", () => {
  it("shows a note added by one client to another", async () => {
    const a = client();
    const b = client();
    await waitFor(() => synced(a.provider) && synced(b.provider));

    const id = addNote(a.doc, 40, 60);
    await waitFor(() => listNotes(b.doc).length === 1);
    expect(listNotes(b.doc)[0]).toMatchObject({ id, x: 40, y: 60 });
  });

  it("merges edits made while the server was down once it comes back", async () => {
    const a = client();
    const b = client();
    await waitFor(() => synced(a.provider) && synced(b.provider));
    const id = addNote(a.doc, 0, 0);
    await waitFor(() => listNotes(b.doc).length === 1);

    const port = server.port;
    await server.close();
    await waitFor(() => !synced(a.provider) && !synced(b.provider));

    moveNote(a.doc, id, 500, 400); // offline edit on A
    setText(b.doc, id, "edited offline"); // offline edit on B
    addNote(b.doc, 900, 100);

    server = await startBoardServer({ port, dataDir, snapshotIntervalMs: 100 });
    await waitFor(() => synced(a.provider) && synced(b.provider), 10_000);
    await waitFor(() => listNotes(a.doc).length === 2 && listNotes(b.doc).length === 2);

    expect(listNotes(a.doc)).toEqual(listNotes(b.doc));
    expect(listNotes(a.doc).find((n) => n.id === id)).toMatchObject({ x: 500, y: 400, text: "edited offline" });
  });

  it("keeps the board after a server restart", async () => {
    const a = client();
    const b = client();
    await waitFor(() => synced(a.provider) && synced(b.provider));
    addNote(a.doc, 10, 10);
    // B seeing the note proves the server has it.
    await waitFor(() => listNotes(b.doc).length === 1);
    a.provider.destroy();
    b.provider.destroy();

    const port = server.port;
    await server.close();
    server = await startBoardServer({ port, dataDir });

    const fresh = client();
    await waitFor(() => listNotes(fresh.doc).length === 1);
  });

  it("removes a person's presence when they disconnect", async () => {
    const a = client();
    const b = client();
    await waitFor(() => synced(a.provider) && synced(b.provider));
    a.provider.awareness.setLocalState({ name: "Ana" });
    await waitFor(() => b.provider.awareness.getStates().has(a.doc.clientID));

    a.provider.destroy();
    await waitFor(() => !b.provider.awareness.getStates().has(a.doc.clientID));
  });

  it("keeps rooms separate", async () => {
    const a = client("room-a");
    const b = client("room-b");
    await waitFor(() => synced(a.provider) && synced(b.provider));
    addNote(a.doc, 0, 0);
    await new Promise((r) => setTimeout(r, 200));
    expect(listNotes(b.doc)).toEqual([]);
  });

  it("rejects an invalid board name", async () => {
    const ws = new WebSocket(`ws://localhost:${server.port}/board/Not%20Valid`);
    const code = await new Promise<number>((resolve) => ws.on("close", (c) => resolve(c)));
    expect(code).toBe(1008);
  });
});
