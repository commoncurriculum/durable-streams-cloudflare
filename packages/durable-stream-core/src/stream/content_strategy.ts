/**
 * Content strategy pattern for handling JSON vs binary content types.
 *
 * This abstraction eliminates duplicated branching logic across:
 * - stream.ts (readFromOffset, readFromMessages)
 * - segments.ts (readSegmentMessages)
 * - read_path.ts (result building)
 */

import { isJsonContentType } from "../protocol/headers";
import { buildJsonArray, emptyJsonArray } from "../protocol/json";
import { concatBuffers } from "../protocol/encoding";

export type ChunkInfo = {
  body: Uint8Array;
  sizeBytes: number;
};

/**
 * Strategy interface for content-type-specific operations.
 */
export interface ContentStrategy {
  /** Build empty response body for this content type */
  emptyBody(): ArrayBuffer;

  /** Build response body from collected chunks */
  buildBody(chunks: ChunkInfo[]): ArrayBuffer;

  /** Calculate next offset after reading chunks */
  nextOffset(startOffset: number, chunks: ChunkInfo[]): number;
}

/**
 * Strategy for JSON content (application/json, text/json, etc.)
 * - Offsets are message indices
 * - Messages are atomic (no partial reads)
 * - Body is wrapped in JSON array
 */
export const jsonStrategy: ContentStrategy = {
  emptyBody(): ArrayBuffer {
    return emptyJsonArray();
  },

  buildBody(chunks: ChunkInfo[]): ArrayBuffer {
    return buildJsonArray(
      chunks.map((c) => ({ body: c.body, sizeBytes: c.sizeBytes }))
    );
  },

  nextOffset(startOffset: number, chunks: ChunkInfo[]): number {
    return startOffset + chunks.length;
  },
};

/**
 * Strategy for binary content (application/octet-stream, etc.)
 * - Offsets are byte positions
 * - Messages can be partially read
 * - Body is concatenated bytes
 */
export const binaryStrategy: ContentStrategy = {
  emptyBody(): ArrayBuffer {
    return new ArrayBuffer(0);
  },

  buildBody(chunks: ChunkInfo[]): ArrayBuffer {
    return concatBuffers(chunks.map((c) => c.body));
  },

  nextOffset(startOffset: number, chunks: ChunkInfo[]): number {
    return startOffset + chunks.reduce((sum, c) => sum + c.sizeBytes, 0);
  },
};

/**
 * Get the appropriate strategy for a content type.
 */
export function getContentStrategy(contentType: string): ContentStrategy {
  return isJsonContentType(contentType) ? jsonStrategy : binaryStrategy;
}
