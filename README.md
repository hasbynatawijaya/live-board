# Live Board

A real-time collaborative board of sticky notes. Several people edit at once, see each other's cursors, and keep working offline; their edits merge when they reconnect.

Built on [Yjs](https://github.com/yjs/yjs) (a CRDT) with a small WebSocket server and client provider written for this project on top of `y-protocols`.

## Features

- Add, move, edit, recolour and delete notes; double-click the board or use “Add note”
- Live cursors and a list of who's on the board
- Keyboard support: Tab to a note, arrow keys move it (Shift for bigger steps), Enter edits, Escape leaves the text, Delete removes it
- Undo and redo of your own changes only (Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z)
- Offline: edits are kept in IndexedDB and sent when the connection comes back
- Boards by URL: `?board=team-retro`

## How sync works

- **Data model.** Notes live in one `Y.Map`; each note is its own `Y.Map`. Two people changing different properties of one note (one moves it, one edits its text) both keep their change. The same property changed by two people at once resolves to one value, the same on every client.
- **Handshake.** On connect, client and server each send a state vector (sync step 1) and answer with the updates the other is missing (sync step 2). Edits made offline are simply part of that answer, so no separate "replay queue" is needed.
- **Reconnect.** The client reconnects with exponential backoff and full jitter (random delay up to 0.5 s, 1 s, 2 s … capped at 15 s). Without jitter, every client that lost the same server would reconnect at the same instant. When the browser reports it is offline, the client waits for the `online` event instead of retrying.
- **Dead connections.** Browsers can't send WebSocket ping frames, so the client sends an app-level ping every 5 s and closes the socket after 15 s of silence. The server pings sockets and drops ones that stop answering.
- **Presence** (names, colours, cursors) uses the Yjs awareness protocol. It is not stored in the document; the server removes a person's presence when their connection closes.
- **Persistence.** The server snapshots each board to disk every 2 s when it changed and when the last person leaves, writing to a temp file and renaming it so a crash never leaves half a snapshot.

## Measurements

`npm run load` starts the server as its own process, connects simulated clients, and measures how long each edit takes to reach every other client. It then kills the server (SIGKILL, like a crash), makes an edit while it's down, restarts it, and measures how long until all clients are synced and see that edit.

Apple M1 Pro, everything on one machine (no real network latency):

| Clients | Edits delivered | Latency p50 | p95 | Max | Server killed → all clients resynced |
|---|---|---|---|---|---|
| 20 (3 runs) | 11,400 per run | 3.8–4.4 ms | 8.3–9.0 ms | 12–23 ms | 3.2–3.8 s |
| 50 | 49,000 | 18.5 ms | 35.1 ms | 66.3 ms | 4.0 s |

Resync time includes 1 s of downtime, the server's start-up, and each client's jittered backoff. Real networks add their own latency on top; these numbers show the server and protocol cost, not what a user far from the server would see.

Other checks: 13 unit and integration tests (real server and clients in Node, including edits made while the server was down), 5 Playwright tests with two browser contexts (live sync, keyboard moves, presence, offline then reconnect, axe scan with 0 violations).

## Run it

Needs Node 24.

```sh
npm install
npm run server     # sync server on :1234, snapshots in ./data
npm run dev        # app on :5173 (open it in two windows)
```

`VITE_SYNC_URL` points the app at another server (default `ws://<host>:1234`). The server reads `PORT` and `DATA_DIR`.

Checks: `npm run lint`, `npm test`, `npm run test:e2e`, `npm run build`, `npm run load`.

## Limits

- Note text is one value per note, not a shared text type: two people typing in the same note at the same moment keep one person's version.
- No accounts or permissions; anyone with a board's URL can edit it.
- One server process; scaling out would need a shared pub/sub between servers.
- Snapshots are whole-document files; very large boards would want incremental storage.
