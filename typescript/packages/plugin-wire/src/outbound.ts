import type { Writable } from "node:stream";
import type { WebSocket } from "ws";

export type WriteLine = (line: string) => void | boolean | Promise<void>;
export type Delivery = (send: () => void) => Promise<void>;

// Do not pass another RPC frame to Node's internal write queue while the
// previous frame is still being written. The next frame retains its fence.
export const streamWriter = (stream: Writable): WriteLine => line => new Promise((resolve, reject) => {
	stream.write(line, error => error ? reject(error) : resolve());
});
export const socketWriter = (socket: WebSocket): WriteLine => line => new Promise((resolve, reject) => {
	socket.send(line.slice(0, -1), error => error ? reject(error) : resolve());
});
