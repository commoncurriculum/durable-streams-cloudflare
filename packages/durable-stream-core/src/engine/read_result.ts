/**
 * Builder utilities for constructing ReadResult objects.
 *
 * These helpers reduce boilerplate and ensure consistency across:
 * - read_path.ts
 * - stream.ts
 * - segments.ts
 */

import type { ContentStrategy } from "./content_strategy";

export type ReadResult = {
  body: ArrayBuffer;
  nextOffset: number;
  upToDate: boolean;
  closedAtTail: boolean;
  hasData: boolean;
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
    strategy?: ContentStrategy;
  } = {}
): ReadResult {
  const body = opts.strategy ? opts.strategy.emptyBody() : new ArrayBuffer(0);
  return {
    body,
    nextOffset: offset,
    upToDate: opts.upToDate ?? false,
    closedAtTail: opts.closedAtTail ?? false,
    hasData: false,
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
  source?: "hot" | "r2";
}): ReadResult {
  const upToDate = params.nextOffset === params.tailOffset;
  return {
    body: params.body,
    nextOffset: params.nextOffset,
    upToDate,
    closedAtTail: params.closed && upToDate,
    hasData: true,
    source: params.source,
  };
}
