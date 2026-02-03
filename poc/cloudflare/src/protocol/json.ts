import { toUint8Array } from "./encoding";

export type JsonMessage = {
  body: ArrayBuffer;
  sizeBytes: number;
};

export type JsonParseResult = {
  messages: JsonMessage[];
  emptyArray: boolean;
  error?: string;
};

export function parseJsonMessages(bodyBytes: Uint8Array): JsonParseResult {
  const text = new TextDecoder().decode(bodyBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { messages: [], emptyArray: false, error: "invalid JSON" };
  }

  const values = Array.isArray(parsed) ? parsed : [parsed];
  if (values.length === 0) {
    return { messages: [], emptyArray: true };
  }

  const encoder = new TextEncoder();
  const messages = values.map((value) => {
    const serialized = JSON.stringify(value);
    const encoded = encoder.encode(serialized);
    return { body: encoded.buffer, sizeBytes: encoded.byteLength };
  });

  return { messages, emptyArray: false };
}

export function buildJsonArray(
  messages: Array<{ body: ArrayBuffer | Uint8Array | string | number[]; sizeBytes: number }>,
): ArrayBuffer {
  const decoder = new TextDecoder();
  const parts = messages.map((msg) => decoder.decode(toUint8Array(msg.body)));
  const joined = `[${parts.join(",")}]`;
  return new TextEncoder().encode(joined).buffer;
}

export function emptyJsonArray(): ArrayBuffer {
  return new TextEncoder().encode("[]").buffer;
}
