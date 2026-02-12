/**
 * Types for StreamSubscribersDO storage operations
 *
 * These types define the interfaces and data structures used by the StreamSubscribersDO
 * storage layer, complementing the Drizzle schema definitions.
 */

import type { Subscriber, FanoutState } from "./schema";

/**
 * Re-export Drizzle-inferred types for external use
 */
export type { Subscriber, FanoutState };

/**
 * Subscriber with timestamp information
 */
export interface SubscriberWithTimestamp {
  estuary_id: string;
  subscribed_at: number;
}

/**
 * Interface for StreamSubscribersDO storage operations
 */
export interface StreamSubscribersStorage {
  /**
   * Initialize the database schema
   * Must be called during DO construction within blockConcurrencyWhile
   */
  initSchema(): void;

  /**
   * Add a subscriber (estuary) to this source stream
   */
  addSubscriber(estuaryId: string, timestamp: number): Promise<void>;

  /**
   * Remove a single subscriber from this source stream
   */
  removeSubscriber(estuaryId: string): Promise<void>;

  /**
   * Remove multiple subscribers in bulk
   */
  removeSubscribers(estuaryIds: string[]): Promise<void>;

  /**
   * Get all subscriber IDs (estuary IDs)
   */
  getSubscriberIds(): Promise<string[]>;

  /**
   * Get all subscribers with their subscription timestamps
   */
  getSubscribersWithTimestamps(): Promise<SubscriberWithTimestamp[]>;

  /**
   * Load the next fanout sequence number from storage
   * Used for queue-based fanout ordering
   */
  loadFanoutSeq(): Promise<number>;

  /**
   * Persist the next fanout sequence number to storage
   */
  persistFanoutSeq(seq: number): Promise<void>;
}
