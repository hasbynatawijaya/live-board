import { useEffect, useRef, useState } from "react";
import { addNote, BOARD_HEIGHT, BOARD_WIDTH, NOTE_SIZE } from "./client/board";
import { NoteCard } from "./client/NoteCard";
import type { ConnectionStatus } from "./client/provider";
import { useBoard, type Presence } from "./client/useBoard";
import { ROOM_PATTERN } from "./shared/protocol";

const CURSOR_COLORS = ["#c2410c", "#7c3aed", "#0f766e", "#be123c", "#1d4ed8", "#4d7c0f"];

function boardFromUrl(): string {
  const name = new URLSearchParams(location.search).get("board") ?? "demo";
  return ROOM_PATTERN.test(name) ? name : "demo";
}

// Name and colour are per-browser conveniences; storage can be blocked.
function loadIdentity(): { name: string; color: string } {
  try {
    const saved = localStorage.getItem("live-board:identity");
    if (saved) return JSON.parse(saved);
  } catch {
    // ignore
  }
  return {
    name: `Guest ${Math.floor(100 + Math.random() * 900)}`,
    color: CURSOR_COLORS[Math.floor(Math.random() * CURSOR_COLORS.length)]!,
  };
}

function statusText(status: ConnectionStatus): string {
  switch (status.state) {
    case "connecting":
      return "Connecting…";
    case "connected":
      return status.synced ? "Live" : "Syncing…";
    case "waiting":
      return `Reconnecting in ${Math.ceil(status.retryInMs / 1000)}s · changes are saved on this device`;
    case "offline":
      return "Offline · changes are saved on this device";
  }
}

export default function App() {
  const [board] = useState(boardFromUrl);
  const { doc, provider, notes, status, peers, undo, canUndo, canRedo } = useBoard(board);
  const [identity, setIdentity] = useState(loadIdentity);
  const scroller = useRef<HTMLDivElement>(null);
  const cursorFrame = useRef<number | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem("live-board:identity", JSON.stringify(identity));
    } catch {
      // ignore
    }
    const current = provider.awareness.getLocalState() as Presence | null;
    provider.awareness.setLocalState({ ...identity, cursor: current?.cursor ?? null } satisfies Presence);
  }, [identity, provider]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.target as HTMLElement).closest("input, textarea")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) undo.redo();
        else undo.undo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

  function setCursor(cursor: Presence["cursor"]) {
    if (cursorFrame.current !== null) cancelAnimationFrame(cursorFrame.current);
    cursorFrame.current = requestAnimationFrame(() => provider.awareness.setLocalStateField("cursor", cursor));
  }

  function addInView() {
    const el = scroller.current;
    const x = el ? el.scrollLeft + el.clientWidth / 2 - NOTE_SIZE / 2 : 40;
    const y = el ? el.scrollTop + el.clientHeight / 2 - NOTE_SIZE / 2 : 40;
    const id = addNote(doc, x + (Math.random() * 40 - 20), y + (Math.random() * 40 - 20));
    // Focus the new note's text so keyboard users can type straight away.
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(`[data-note="${id}"] textarea`)?.focus());
  }

  const live = status.state === "connected" && status.synced;

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="brand">Live Board <span className="muted">/ {board}</span></h1>
        <p className={`status ${live ? "status-live" : "status-down"}`} role="status">
          <span className="status-dot" aria-hidden="true" />
          {statusText(status)}
        </p>
        <div className="row">
          <button type="button" className="button button-primary" onClick={addInView}>Add note</button>
          <button type="button" className="button" onClick={() => undo.undo()} disabled={!canUndo}>Undo</button>
          <button type="button" className="button" onClick={() => undo.redo()} disabled={!canRedo}>Redo</button>
        </div>
        <div className="presence">
          <label className="name-input">
            <span className="visually-hidden">Your name</span>
            <span className="avatar" style={{ background: identity.color }} aria-hidden="true">{identity.name.slice(0, 1).toUpperCase()}</span>
            <input value={identity.name} maxLength={30} onChange={(e) => setIdentity({ ...identity, name: e.target.value || "Guest" })} />
          </label>
          <ul className="peers" aria-label={`${peers.length} other ${peers.length === 1 ? "person" : "people"} here`}>
            {peers.map((p) => (
              <li key={p.clientId} className="avatar" style={{ background: p.color }} title={p.name}>
                <span aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</span>
                <span className="visually-hidden">{p.name}</span>
              </li>
            ))}
          </ul>
        </div>
      </header>

      <main className="scroller" ref={scroller} aria-label="Board">
        <div
          className="surface"
          style={{ width: BOARD_WIDTH, height: BOARD_HEIGHT }}
          onDoubleClick={(e) => {
            if (e.target !== e.currentTarget) return;
            const rect = e.currentTarget.getBoundingClientRect();
            addNote(doc, e.clientX - rect.left - NOTE_SIZE / 2, e.clientY - rect.top - 20);
          }}
          onPointerMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setCursor({ x: Math.round(e.clientX - rect.left), y: Math.round(e.clientY - rect.top) });
          }}
          onPointerLeave={() => setCursor(null)}
        >
          {notes.length === 0 && (
            <p className="empty">Double-click anywhere or press “Add note”. Open this page in a second window to see changes sync.</p>
          )}
          {notes.map((note, index) => (
            <div key={note.id} data-note={note.id} className="note-slot">
              <NoteCard note={note} doc={doc} index={index} />
            </div>
          ))}
          {peers.map((p) =>
            p.cursor ? (
              <div key={p.clientId} className="cursor" style={{ transform: `translate(${p.cursor.x}px, ${p.cursor.y}px)` }} aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16"><path d="M1 1l5 14 2-6 6-2z" fill={p.color} stroke="white" strokeWidth="1" /></svg>
                <span style={{ background: p.color }}>{p.name}</span>
              </div>
            ) : null,
          )}
        </div>
      </main>
    </div>
  );
}
