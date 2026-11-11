import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addNote, deleteNote, listNotes, moveNote, setText, BOARD_WIDTH, NOTE_SIZE } from "./board";

function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

describe("board model", () => {
  it("keeps notes inside the board", () => {
    const doc = new Y.Doc();
    const id = addNote(doc, 99999, -50);
    expect(listNotes(doc)[0]).toMatchObject({ id, x: BOARD_WIDTH - NOTE_SIZE, y: 0 });
  });

  it("keeps both changes when one person moves a note and another edits its text", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const id = addNote(a, 10, 10);
    sync(a, b);

    moveNote(a, id, 300, 200); // offline on A
    setText(b, id, "Ship v1"); // offline on B
    sync(a, b);

    for (const doc of [a, b]) {
      expect(listNotes(doc)[0]).toMatchObject({ x: 300, y: 200, text: "Ship v1" });
    }
  });

  it("resolves the same property edited twice to one value on both sides", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const id = addNote(a, 0, 0);
    sync(a, b);
    setText(a, id, "from A");
    setText(b, id, "from B");
    sync(a, b);
    expect(listNotes(a)[0]?.text).toBe(listNotes(b)[0]?.text);
  });

  it("deletes a note everywhere", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const id = addNote(a, 0, 0);
    sync(a, b);
    deleteNote(b, id);
    sync(a, b);
    expect(listNotes(a)).toEqual([]);
  });
});
