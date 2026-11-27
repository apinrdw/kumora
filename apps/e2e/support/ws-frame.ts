import type { WebSocket } from "ws"

/**
 * A frame's data under ws's default `nodebuffer` binary type: a Buffer, or a
 * string for a text frame that arrives through `addEventListener`. ws types
 * it wider, with the `ArrayBuffer` and `Buffer[]` of the other binary types.
 */
export const wsFrame = (data: WebSocket.Data) => data as Buffer | string
