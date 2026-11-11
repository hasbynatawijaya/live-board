import { useRef } from "react";
import type * as Y from "yjs";
import { COLORS, deleteNote, moveNote, setColor, setText, type Note } from "./board";

const STEP = 10;
const BIG_STEP = 50;

export function NoteCard({ note, doc, index }: { note: Note; doc: Y.Doc; index: number }) {
  const drag = useRef<{ dx: number; dy: number; frame: number | null } | null>(null);
  const label = note.text.trim() ? `Note: ${note.text.trim().slice(0, 40)}` : `Empty note ${index + 1}`;

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { dx: event.clientX - note.x, dy: event.clientY - note.y, frame: null };
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state) return;
    const { clientX, clientY } = event;
    // One document update per frame, not per mouse event.
    if (state.frame !== null) cancelAnimationFrame(state.frame);
    state.frame = requestAnimationFrame(() => moveNote(doc, note.id, clientX - state.dx, clientY - state.dy));
  }

  function onPointerUp() {
    drag.current = null;
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    const step = event.shiftKey ? BIG_STEP : STEP;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      moveNote(doc, note.id, note.x + move[0], note.y + move[1]);
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.querySelector("textarea")?.focus();
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      deleteNote(doc, note.id);
    }
  }

  return (
    <div
      role="group"
      aria-label={label}
      aria-roledescription="movable note"
      tabIndex={0}
      className={`note note-${note.color}`}
      style={{ transform: `translate(${note.x}px, ${note.y}px)` }}
      onKeyDown={onKeyDown}
    >
      <div className="note-grip" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} aria-hidden="true" />
      <textarea
        aria-label="Note text"
        value={note.text}
        maxLength={500}
        placeholder="Write something…"
        onChange={(e) => setText(doc, note.id, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") (e.currentTarget.closest(".note") as HTMLElement | null)?.focus();
        }}
      />
      <div className="note-actions">
        {COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={`swatch swatch-${color}`}
            aria-label={`Colour ${color}`}
            aria-pressed={note.color === color}
            onClick={() => setColor(doc, note.id, color)}
          />
        ))}
        <button type="button" className="note-delete" aria-label="Delete note" onClick={() => deleteNote(doc, note.id)}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
    </div>
  );
}
