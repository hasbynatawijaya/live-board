// Message types on the wire. Every message starts with one varint type.
// Sync and awareness payloads follow the y-protocols formats.
export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
// App-level heartbeat. Browsers can't send WebSocket ping frames, so the
// client sends PING and the server answers PONG.
export const MESSAGE_PING = 2;
export const MESSAGE_PONG = 3;

export const ROOM_PATTERN = /^[a-z0-9-]{1,40}$/;
export const MAX_MESSAGE_BYTES = 1_000_000;
