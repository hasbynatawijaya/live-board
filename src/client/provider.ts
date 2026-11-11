import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import type * as Y from "yjs";
import { MESSAGE_AWARENESS, MESSAGE_PING, MESSAGE_PONG, MESSAGE_SYNC } from "../shared/protocol";
import { backoffDelay } from "./backoff";

export type ConnectionStatus =
  | { state: "connecting" }
  | { state: "connected"; synced: boolean }
  | { state: "waiting"; retryInMs: number }
  | { state: "offline" };

type Options = {
  // Lets Node scripts pass the `ws` package; browsers use the global.
  WebSocketImpl?: typeof WebSocket;
  pingEveryMs?: number;
  // No message at all for this long means the connection is dead.
  silenceTimeoutMs?: number;
};

// Keeps one Y.Doc in sync with the server over a WebSocket, and reconnects
// on its own. Edits made while disconnected stay in the doc and are sent
// during the next handshake.
export class BoardProvider {
  readonly awareness: Awareness;
  status: ConnectionStatus = { state: "connecting" };

  private ws: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private destroyed = false;
  private listeners = new Set<(status: ConnectionStatus) => void>();
  private readonly WS: typeof WebSocket;
  private readonly pingEveryMs: number;
  private readonly silenceTimeoutMs: number;

  private readonly url: string;
  readonly doc: Y.Doc;

  constructor(url: string, doc: Y.Doc, options: Options = {}) {
    this.url = url;
    this.doc = doc;
    this.WS = options.WebSocketImpl ?? WebSocket;
    this.pingEveryMs = options.pingEveryMs ?? 5000;
    this.silenceTimeoutMs = options.silenceTimeoutMs ?? 15_000;
    this.awareness = new Awareness(doc);

    doc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwarenessUpdate);
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.onOnline);
      window.addEventListener("offline", this.onOffline);
    }
    this.connect();
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Forces the socket closed, as a dropped network would. Used by tests.
  disconnect() {
    this.ws?.close();
  }

  destroy() {
    this.destroyed = true;
    this.clearTimers();
    removeAwarenessStates(this.awareness, [this.doc.clientID], "local");
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwarenessUpdate);
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.onOnline);
      window.removeEventListener("offline", this.onOffline);
    }
    this.ws?.close();
    this.awareness.destroy();
  }

  private connect() {
    if (this.destroyed) return;
    this.setStatus({ state: "connecting" });
    const ws = new this.WS(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      this.setStatus({ state: "connected", synced: false });

      // Handshake: send our state vector; the server answers with what we're
      // missing (step 2) and sends its own step 1 for what it is missing.
      const step1 = encoding.createEncoder();
      encoding.writeVarUint(step1, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(step1, this.doc);
      this.send(encoding.toUint8Array(step1));

      if (this.awareness.getLocalState() !== null) {
        this.sendAwareness([this.doc.clientID]);
      }

      this.pingTimer = setInterval(() => this.heartbeat(), this.pingEveryMs);
    };

    ws.onmessage = (event: MessageEvent) => {
      this.lastMessageAt = Date.now();
      this.handleMessage(new Uint8Array(event.data as ArrayBuffer));
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      // Other people's cursors are stale once we can't hear updates.
      const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
      if (others.length > 0) removeAwarenessStates(this.awareness, others, "connection-lost");
      this.scheduleReconnect();
    };

    // onclose always follows onerror, so reconnecting is handled there.
    ws.onerror = () => {};
  }

  private handleMessage(data: Uint8Array) {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    switch (type) {
      case MESSAGE_SYNC: {
        const reply = encoding.createEncoder();
        encoding.writeVarUint(reply, MESSAGE_SYNC);
        const kind = syncProtocol.readSyncMessage(decoder, reply, this.doc, this);
        if (encoding.length(reply) > 1) this.send(encoding.toUint8Array(reply));
        if (kind === syncProtocol.messageYjsSyncStep2 && this.status.state === "connected" && !this.status.synced) {
          this.setStatus({ state: "connected", synced: true });
        }
        break;
      }
      case MESSAGE_AWARENESS:
        applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
        break;
      case MESSAGE_PONG:
        break;
    }
  }

  private heartbeat() {
    if (Date.now() - this.lastMessageAt > this.silenceTimeoutMs) {
      // The socket looks open but nothing comes through. Close it so the
      // reconnect logic takes over instead of waiting for TCP to notice.
      this.ws?.close();
      return;
    }
    const ping = encoding.createEncoder();
    encoding.writeVarUint(ping, MESSAGE_PING);
    this.send(encoding.toUint8Array(ping));
  }

  private scheduleReconnect() {
    if (this.destroyed) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      // The browser will fire "online"; retrying before that is wasted work.
      this.setStatus({ state: "offline" });
      return;
    }
    const delay = backoffDelay(this.attempt++);
    this.setStatus({ state: "waiting", retryInMs: delay });
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private onOnline = () => {
    if (this.ws || this.destroyed) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.attempt = 0;
    this.connect();
  };

  private onOffline = () => {
    this.ws?.close();
  };

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    // Updates that came from the server don't go back to it.
    if (origin === this) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.send(encoding.toUint8Array(encoder));
  };

  private onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === this || origin === "connection-lost") return;
    this.sendAwareness([...added, ...updated, ...removed]);
  };

  private sendAwareness(clients: number[]) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(this.awareness, clients));
    this.send(encoding.toUint8Array(encoder));
  }

  private send(message: Uint8Array) {
    // lib0 returns Uint8Array<ArrayBufferLike>; the bytes are a plain ArrayBuffer.
    if (this.ws && this.ws.readyState === this.WS.OPEN) this.ws.send(message as Uint8Array<ArrayBuffer>);
  }

  private clearTimers() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pingTimer = null;
    this.retryTimer = null;
  }

  private setStatus(status: ConnectionStatus) {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }
}
