/**
 * Types for EstuaryDO storage operations
 *
 * These types define the interfaces and data structures used by the EstuaryDO
 * storage layer, complementing the Drizzle schema definitions.
 */

import type { Subscription, EstuaryInfo } from "./schema";

/**
 * Re-export Drizzle-inferred types for external use
 */
export type { Subscription, EstuaryInfo };

/**
 * Interface for EstuaryDO storage operations
 */
export interface EstuaryStorage {
  /**
   * Initialize the database schema
   * Must be called during DO construction within blockConcurrencyWhile
   */
  initSchema(): void;

  /**
   * Set estuary metadata (project and estuary ID)
   */
  setEstuaryInfo(project: string, estuaryId: string): Promise<void>;

  /**
   * Get estuary metadata
   * Returns null if not set
   */
  getEstuaryInfo(): Promise<{ project: string; estuary_id: string } | null>;

  /**
   * Add a subscription to a source stream
   */
  addSubscription(streamId: string, timestamp: number): Promise<void>;

  /**
   * Remove a subscription to a source stream
   */
  removeSubscription(streamId: string): Promise<void>;

  /**
   * Get all stream IDs this estuary subscribes to
   */
  getSubscriptions(): Promise<string[]>;

  /**
   * Clear all estuary data (subscriptions and info)
   */
  clearData(): Promise<void>;
}
