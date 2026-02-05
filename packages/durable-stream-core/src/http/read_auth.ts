export const SESSION_ID_HEADER = "X-Session-Id";

// Note: In the pure core package, read authorization is handled at the edge worker level
// via JWT tokens. The DO doesn't need to check subscription status - that's the
// subscriptions package's responsibility. This file just exports the header constant.
