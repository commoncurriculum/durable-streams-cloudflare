/**
 * Retry utility with exponential backoff.
 */

export interface RetryOptions {
  /**
   * Maximum number of attempts before giving up.
   * Default: 3
   */
  maxAttempts?: number;

  /**
   * Initial delay in milliseconds before the first retry.
   * Default: 100
   */
  initialDelayMs?: number;

  /**
   * Multiplier for exponential backoff.
   * Each retry delay is: initialDelayMs * (backoffMultiplier ^ attemptNumber)
   * Default: 2
   */
  backoffMultiplier?: number;

  /**
   * Maximum delay in milliseconds (caps the exponential growth).
   * Default: 30000 (30 seconds)
   */
  maxDelayMs?: number;

  /**
   * Predicate to determine if an error should trigger a retry.
   * Receives the error and the current attempt number (1-based).
   * Return true to retry, false to fail immediately.
   * Default: always retry
   */
  shouldRetry?: (error: Error, attempt: number) => boolean;
}

/**
 * Execute a function with automatic retries using exponential backoff.
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration options
 * @returns The result of the function if successful
 * @throws The last error if all retries are exhausted or shouldRetry returns false
 *
 * @example
 * // Basic usage with defaults
 * const result = await withRetry(() => fetchData());
 *
 * @example
 * // Custom retry logic
 * const result = await withRetry(
 *   () => apiCall(),
 *   {
 *     maxAttempts: 5,
 *     initialDelayMs: 200,
 *     shouldRetry: (error, attempt) => {
 *       // Don't retry on 4xx errors
 *       if (error.message.includes('4')) return false;
 *       return attempt < 5;
 *     }
 *   }
 * );
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 100,
    backoffMultiplier = 2,
    maxDelayMs = 30000,
    shouldRetry = () => true,
  } = options;

  let lastError: Error;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt++;

    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry
      if (attempt >= maxAttempts || !shouldRetry(lastError, attempt)) {
        throw lastError;
      }

      // Calculate delay with exponential backoff
      const delay = Math.min(
        initialDelayMs * Math.pow(backoffMultiplier, attempt - 1),
        maxDelayMs,
      );

      // Wait before retrying
      await sleep(delay);
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError!;
}

/**
 * Sleep for a specified duration.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
