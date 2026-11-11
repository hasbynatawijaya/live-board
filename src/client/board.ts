import * as Y from "yjs";

// Notes live in one Y.Map keyed by id. Each note is its own Y.Map, so two
// people changing different properties of one note (one moves it, one edits
// the text) both keep their change. The same property edited twice at once
// resolves to one of the two values, the same on every client.

export const COLORS = ["yellow", "pink", "blue", "green"] as const;
export type NoteColor = (typeof COLORS)[number];

export type Note = {
  id: string;
  text: string;
  x: number;
  y: number;
  color: NoteColor;
  createdAt: number;
};

export const BOARD_WIDTH = 2000;
export const BOARD_HEIGHT = 1200;
export const NOTE_SIZE = 180;

// Changes made by this tab carry this origin, so undo only reverts our own edits.
export const LOCAL_ORIGIN = "local";

export function notesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>("notes");
}

function clamp(value: number, max: number): number {
  return Math.round(Math.min(Math.max(value, 0), max));
}

export function addNote(doc: Y.Doc, x: number, y: number, color: NoteColor = "yellow"): string {
  const id = crypto.randomUUID();
  doc.transact(() => {
    const note = new Y.Map<unknown>();
    note.set("text", "");
    note.set("x", clamp(x, BOARD_WIDTH - NOTE_SIZE));
    note.set("y", clamp(y, BOARD_HEIGHT - NOTE_SIZE));
    note.set("color", color);
    note.set("createdAt", Date.now());
    notesMap(doc).set(id, note);
  }, LOCAL_ORIGIN);
  return id;
}

export function moveNote(doc: Y.Doc, id: string, x: number, y: number) {
  const note = notesMap(doc).get(id);
  if (!note) return;
  doc.transact(() => {
    note.set("x", clamp(x, BOARD_WIDTH - NOTE_SIZE));
    note.set("y", clamp(y, BOARD_HEIGHT - NOTE_SIZE));
  }, LOCAL_ORIGIN);
}

export function setText(doc: Y.Doc, id: string, text: string) {
  const note = notesMap(doc).get(id);
  if (!note) return;
  doc.transact(() => note.set("text", text.slice(0, 500)), LOCAL_ORIGIN);
}

export function setColor(doc: Y.Doc, id: string, color: NoteColor) {
  const note = notesMap(doc).get(id);
  if (!note) return;
  doc.transact(() => note.set("color", color), LOCAL_ORIGIN);
}

export function deleteNote(doc: Y.Doc, id: string) {
  doc.transact(() => notesMap(doc).delete(id), LOCAL_ORIGIN);
}

function toNote(id: string, note: Y.Map<unknown>): Note {
  const color = note.get("color");
  return {
    id,
    text: String(note.get("text") ?? ""),
    x: Number(note.get("x") ?? 0),
    y: Number(note.get("y") ?? 0),
    color: COLORS.includes(color as NoteColor) ? (color as NoteColor) : "yellow",
    createdAt: Number(note.get("createdAt") ?? 0),
  };
}

// Oldest first, so newer notes paint on top. Ties break on id so every
// client draws the same order.
export function listNotes(doc: Y.Doc): Note[] {
  const notes: Note[] = [];
  notesMap(doc).forEach((note, id) => notes.push(toNote(id, note)));
  return notes.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

// For useSyncExternalStore: the snapshot only changes when the doc does.
export function createNotesStore(doc: Y.Doc) {
  let snapshot = listNotes(doc);
  const listeners = new Set<() => void>();
  const onUpdate = () => {
    snapshot = listNotes(doc);
    listeners.forEach((l) => l());
  };
  doc.on("update", onUpdate);
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    destroy: () => doc.off("update", onUpdate),
  };
}
