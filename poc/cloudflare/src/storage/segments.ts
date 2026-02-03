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

export function buildSegmentKey(streamId: string, readSeq: number): string {
  const encoded = encodeStreamPathBase64Url(streamId);
  return `stream/${encoded}/segment-${readSeq}.seg`;
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

export async function readSegmentMessages(params: {
  body: ReadableStream<Uint8Array>;
  offset: number;
  segmentStart: number;
  maxChunkBytes: number;
  isJson: boolean;
}): Promise<{ messages: Uint8Array[]; segmentStart: number; truncated: boolean }> {
  const { body, offset, segmentStart, maxChunkBytes, isJson } = params;
  const reader = body.getReader();
  let buffer = new Uint8Array(0);
  let truncated = false;
  let messages: Uint8Array[] = [];
  let collectedBytes = 0;
  let outputStart = segmentStart;

  const appendBuffer = (next: Uint8Array): void => {
    const chunk = new Uint8Array(next);
    if (buffer.byteLength === 0) {
      buffer = chunk;
      return;
    }
    const merged = new Uint8Array(buffer.byteLength + chunk.byteLength);
    merged.set(buffer, 0);
    merged.set(chunk, buffer.byteLength);
    buffer = merged;
  };

  const readMore = async (): Promise<boolean> => {
    const { value, done } = await reader.read();
    if (done || !value) return false;
    appendBuffer(value);
    return true;
  };

  let cursor = segmentStart;
  let messageIndex = 0;

  while (true) {
    while (buffer.byteLength < LENGTH_PREFIX_BYTES) {
      const ok = await readMore();
      if (!ok) {
        if (buffer.byteLength !== 0) truncated = true;
        return { messages, segmentStart: outputStart, truncated };
      }
    }

    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const length = view.getUint32(0);
    if (length > MAX_SEGMENT_MESSAGE_BYTES) {
      truncated = true;
      return { messages, segmentStart: outputStart, truncated };
    }

    const needed = LENGTH_PREFIX_BYTES + length;
    while (buffer.byteLength < needed) {
      const ok = await readMore();
      if (!ok) {
        truncated = true;
        return { messages, segmentStart: outputStart, truncated };
      }
    }

    const message = buffer.slice(LENGTH_PREFIX_BYTES, needed);
    buffer = buffer.slice(needed);

    if (isJson) {
      if (messageIndex < offset - segmentStart) {
        messageIndex += 1;
        cursor += 1;
        continue;
      }

      if (messages.length === 0) {
        outputStart = segmentStart + messageIndex;
      }

      messages.push(message);
      collectedBytes += message.byteLength;
      messageIndex += 1;
      cursor += 1;
    } else {
      const end = cursor + message.byteLength;
      if (end <= offset) {
        cursor = end;
        continue;
      }

      if (messages.length === 0) {
        outputStart = cursor;
      }

      messages.push(message);
      collectedBytes += message.byteLength;
      cursor = end;
    }

    if (collectedBytes >= maxChunkBytes) {
      return { messages, segmentStart: outputStart, truncated };
    }
  }
}
