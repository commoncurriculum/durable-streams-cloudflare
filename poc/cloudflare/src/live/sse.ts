import { generateResponseCursor } from "../protocol/cursor";
import { base64Encode } from "../protocol/encoding";

export function buildSseDataEvent(payload: ArrayBuffer, useBase64: boolean): string {
  let output = "event: data\n";

  if (useBase64) {
    const encoded = base64Encode(new Uint8Array(payload));
    output += `data:${encoded}\n\n`;
    return output;
  }

  const text = new TextDecoder().decode(payload);
  const lines = text.split(/\r\n|\n|\r/);
  for (const line of lines) {
    output += `data:${line}\n`;
  }
  output += "\n";
  return output;
}

export function buildSseControlEvent(params: {
  nextOffset: string;
  upToDate: boolean;
  streamClosed: boolean;
  cursor: string;
}): { payload: string; nextCursor: string | null } {
  const control: Record<string, unknown> = {
    streamNextOffset: params.nextOffset,
  };

  if (params.streamClosed) {
    control.streamClosed = true;
    return {
      payload: `event: control\n` + `data:${JSON.stringify(control)}\n\n`,
      nextCursor: null,
    };
  }

  const nextCursor = generateResponseCursor(params.cursor);
  control.streamCursor = nextCursor;
  if (params.upToDate) control.upToDate = true;

  return {
    payload: `event: control\n` + `data:${JSON.stringify(control)}\n\n`,
    nextCursor,
  };
}
