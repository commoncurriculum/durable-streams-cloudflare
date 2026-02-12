/**
 * Builder utilities for constructing ReadResult objects.
 *
 * These helpers reduce boilerplate and ensure consistency across:
 * - read.ts
 * - read-messages.ts
 * - http/v1/streams/read/path.ts
 */

export type ReadResult = {
  body: ArrayBuffer;
  nextOffset: number;
  upToDate: boolean;
  closedAtTail: boolean;
  hasData: boolean;
  writeTimestamp: number;
  source?: "hot" | "r2";
  error?: Response;
};

/**
 * Build an empty read result (no data available).
 */
export function emptyResult(
  offset: number,
  opts: {
    source?: "hot" | "r2";
    upToDate?: boolean;
    closedAtTail?: boolean;
    emptyBody?: ArrayBuffer;
  } = {}
): ReadResult {
  return {
    body: opts.emptyBody ?? new ArrayBuffer(0),
    nextOffset: offset,
    upToDate: opts.upToDate ?? false,
    closedAtTail: opts.closedAtTail ?? false,
    hasData: false,
    writeTimestamp: 0,
    source: opts.source,
  };
}

/**
 * Build an error read result.
 */
export function errorResult(
  offset: number,
  error: Response,
  source?: "hot" | "r2"
): ReadResult {
  return {
    body: new ArrayBuffer(0),
    nextOffset: offset,
    upToDate: false,
    closedAtTail: false,
    hasData: false,
    writeTimestamp: 0,
    source,
    error,
  };
}

/**
 * Build a gap result (at a segment boundary with no data).
 */
export function gapResult(
  offset: number,
  closedAtTail: boolean,
  source?: "hot" | "r2"
): ReadResult {
  return {
    body: new ArrayBuffer(0),
    nextOffset: offset,
    upToDate: false,
    closedAtTail,
    hasData: false,
    writeTimestamp: 0,
    source,
  };
}

/**
 * Build a successful data result.
 */
export function dataResult(params: {
  body: ArrayBuffer;
  nextOffset: number;
  tailOffset: number;
  closed: boolean;
  writeTimestamp?: number;
  source?: "hot" | "r2";
}): ReadResult {
  const upToDate = params.nextOffset === params.tailOffset;
  return {
    body: params.body,
    nextOffset: params.nextOffset,
    upToDate,
    closedAtTail: params.closed && upToDate,
    hasData: true,
    writeTimestamp: params.writeTimestamp ?? 0,
    source: params.source,
  };
}
