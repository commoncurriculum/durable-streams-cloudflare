/**
 * Stream storage operations
 *
 * This module contains storage-level operations for reading stream data,
 * separate from HTTP protocol concerns.
 */

export { readFromOffset } from "./read";
export { readFromMessages } from "./read-messages";
export {
  emptyResult,
  errorResult,
  gapResult,
  dataResult,
  type ReadResult,
} from "./types";
