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
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
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

// ============================================================================
// SegmentReader: handles streaming read of length-prefixed messages
// ============================================================================

class SegmentReader {
  private buffer = new Uint8Array(0);
  private reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader();
  }

  /** Read the next length-prefixed message, or null if stream ended */
  async nextMessage(): Promise<
    { message: Uint8Array } | { truncated: true } | null
  > {
    if (!(await this.ensureBytes(LENGTH_PREFIX_BYTES))) {
      return this.buffer.byteLength === 0 ? null : { truncated: true };
    }

    const length = new DataView(
      this.buffer.buffer,
      this.buffer.byteOffset
    ).getUint32(0);
    if (length > MAX_SEGMENT_MESSAGE_BYTES) {
      return { truncated: true };
    }

    if (!(await this.ensureBytes(LENGTH_PREFIX_BYTES + length))) {
      return { truncated: true };
    }

    const message = this.buffer.slice(
      LENGTH_PREFIX_BYTES,
      LENGTH_PREFIX_BYTES + length
    );
    this.buffer = this.buffer.slice(LENGTH_PREFIX_BYTES + length);
    return { message };
  }

  private async ensureBytes(needed: number): Promise<boolean> {
    while (this.buffer.byteLength < needed) {
      const { value, done } = await this.reader.read();
      if (done || !value) return false;
      this.appendBuffer(value);
    }
    return true;
  }

  private appendBuffer(next: Uint8Array): void {
    if (this.buffer.byteLength === 0) {
      this.buffer = new Uint8Array(next);
      return;
    }
    const merged = new Uint8Array(this.buffer.byteLength + next.byteLength);
    merged.set(this.buffer, 0);
    merged.set(next, this.buffer.byteLength);
    this.buffer = merged;
  }
}

// ============================================================================
// MessageCollector: strategy-based collection of messages up to byte limit
// ============================================================================

interface MessageCollector {
  readonly messages: Uint8Array[];
  readonly outputStart: number;
  add(message: Uint8Array): void;
  isFull(): boolean;
}

class JsonMessageCollector implements MessageCollector {
  messages: Uint8Array[] = [];
  outputStart: number;
  private collectedBytes = 0;
  private messageIndex = 0;
  private readonly targetIndex: number;

  constructor(
    offset: number,
    private segmentStart: number,
    private maxChunkBytes: number
  ) {
    this.targetIndex = offset - segmentStart;
    this.outputStart = segmentStart;
  }

  add(message: Uint8Array): void {
    if (this.messageIndex < this.targetIndex) {
      this.messageIndex++;
      return;
    }
    if (this.messages.length === 0) {
      this.outputStart = this.segmentStart + this.messageIndex;
    }
    this.messages.push(message);
    this.collectedBytes += message.byteLength;
    this.messageIndex++;
  }

  isFull(): boolean {
    return this.collectedBytes >= this.maxChunkBytes;
  }
}

class BinaryMessageCollector implements MessageCollector {
  messages: Uint8Array[] = [];
  outputStart: number;
  private collectedBytes = 0;
  private cursor: number;

  constructor(
    private offset: number,
    segmentStart: number,
    private maxChunkBytes: number
  ) {
    this.cursor = segmentStart;
    this.outputStart = segmentStart;
  }

  add(message: Uint8Array): void {
    const end = this.cursor + message.byteLength;
    if (end <= this.offset) {
      this.cursor = end;
      return;
    }
    if (this.messages.length === 0) {
      this.outputStart = this.cursor;
    }
    this.messages.push(message);
    this.collectedBytes += message.byteLength;
    this.cursor = end;
  }

  isFull(): boolean {
    return this.collectedBytes >= this.maxChunkBytes;
  }
}

// ============================================================================
// Main entry point
// ============================================================================

export async function readSegmentMessages(params: {
  body: ReadableStream<Uint8Array>;
  offset: number;
  segmentStart: number;
  maxChunkBytes: number;
  isJson: boolean;
}): Promise<{
  messages: Uint8Array[];
  segmentStart: number;
  truncated: boolean;
}> {
  const { body, offset, segmentStart, maxChunkBytes, isJson } = params;

  const reader = new SegmentReader(body);
  const collector: MessageCollector = isJson
    ? new JsonMessageCollector(offset, segmentStart, maxChunkBytes)
    : new BinaryMessageCollector(offset, segmentStart, maxChunkBytes);

  while (!collector.isFull()) {
    const result = await reader.nextMessage();

    if (result === null) {
      break;
    }

    if ("truncated" in result) {
      return {
        messages: collector.messages,
        segmentStart: collector.outputStart,
        truncated: true,
      };
    }

    collector.add(result.message);
  }

  return {
    messages: collector.messages,
    segmentStart: collector.outputStart,
    truncated: false,
  };
}
