import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import { createNotesStore, LOCAL_ORIGIN, notesMap } from "./board";
import { BoardProvider, type ConnectionStatus } from "./provider";

export type Presence = {
  name: string;
  color: string;
  cursor: { x: number; y: number } | null;
};

export type Peer = Presence & { clientId: number };

const SYNC_URL = import.meta.env.VITE_SYNC_URL ?? `ws://${location.hostname}:1234`;

// One doc, provider and offline store per board name, for the life of the page.
export function useBoard(board: string) {
  const { doc, provider, undo, store } = useMemo(() => {
    const doc = new Y.Doc();
    // Load what this browser saved earlier, so the board shows instantly and
    // offline edits survive a reload.
    new IndexeddbPersistence(`live-board:${board}`, doc);
    const provider = new BoardProvider(`${SYNC_URL}/board/${board}`, doc);
    // Undo only what this tab did, never other people's edits.
    const undo = new Y.UndoManager(notesMap(doc), { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 400 });
    return { doc, provider, undo, store: createNotesStore(doc) };
  }, [board]);

  useEffect(
    () => () => {
      store.destroy();
      undo.destroy();
      provider.destroy();
      doc.destroy();
    },
    [doc, provider, undo, store],
  );

  const notes = useSyncExternalStore(store.subscribe, store.getSnapshot);

  const [status, setStatus] = useState<ConnectionStatus>(provider.status);
  useEffect(() => provider.onStatus(setStatus), [provider]);

  const [peers, setPeers] = useState<Peer[]>([]);
  useEffect(() => {
    const update = () => {
      const list: Peer[] = [];
      provider.awareness.getStates().forEach((state, clientId) => {
        if (clientId !== doc.clientID && state && typeof state.name === "string") {
          list.push({ clientId, ...(state as Presence) });
        }
      });
      setPeers(list.sort((a, b) => a.name.localeCompare(b.name)));
    };
    provider.awareness.on("change", update);
    update();
    return () => provider.awareness.off("change", update);
  }, [provider, doc]);

  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  useEffect(() => {
    const update = () => {
      setCanUndo(undo.undoStack.length > 0);
      setCanRedo(undo.redoStack.length > 0);
    };
    undo.on("stack-item-added", update);
    undo.on("stack-item-popped", update);
    undo.on("stack-cleared", update);
    return () => {
      undo.off("stack-item-added", update);
      undo.off("stack-item-popped", update);
      undo.off("stack-cleared", update);
    };
  }, [undo]);

  return { doc, provider, notes, status, peers, undo, canUndo, canRedo };
}
