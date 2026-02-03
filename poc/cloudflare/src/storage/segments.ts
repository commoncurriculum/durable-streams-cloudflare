const LENGTH_PREFIX_BYTES = 4;
const MAX_SEGMENT_MESSAGE_BYTES = 64 * 1024 * 1024;

export function encodeStreamPathBase64Url(path: string): string {
  const bytes = new TextEncoder().encode(path);
  if (bytes.length === 0) return "";
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function buildSnapshotKey(streamId: string, timestampMs: number): string {
  const encoded = encodeStreamPathBase64Url(streamId);
  return `stream/${encoded}/snapshot-${timestampMs}.seg`;
}

export function encodeSegmentMessages(messages: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const message of messages) {
    if (message.byteLength > MAX_SEGMENT_MESSAGE_BYTES) {
      throw new Error("segment message too large");
    }
    total += LENGTH_PREFIX_BYTES + message.byteLength;
  }

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;

  for (const message of messages) {
    view.setUint32(offset, message.byteLength);
    offset += LENGTH_PREFIX_BYTES;
    out.set(message, offset);
    offset += message.byteLength;
  }

  return out;
}

export const segmentFormat = {
  lengthPrefixBytes: LENGTH_PREFIX_BYTES,
  maxMessageBytes: MAX_SEGMENT_MESSAGE_BYTES,
};
