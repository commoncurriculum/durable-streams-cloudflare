# Chapter 3: Authentication

Both the core and subscription workers implement per-project JWT authentication using HMAC-SHA256 signing secrets stored in a KV namespace. Auth is optional -- both workers can run without it -- but is required for any multi-tenant or production deployment.

## Architecture

```
Client ── Bearer <JWT> ──> Worker ── KV lookup (REGISTRY) ──> Verify signature ──> Route
```

1. Client sends a JWT in the `Authorization: Bearer <token>` header.
2. Worker extracts the project ID from the request path (`/v1/:projectId/...`).
3. Worker looks up the project's signing secret from the `REGISTRY` KV namespace (key = project ID, value = `{ signingSecret: "..." }`).
4. Worker verifies the JWT signature (HS256) and validates claims.
5. On success, the request proceeds. On failure, 401 or 403.

## JWT Claims

| Claim | Type | Required | Description |
|-------|------|----------|-------------|
| `sub` | string | Yes | Project ID. Must match the project segment in the URL. |
| `scope` | `"write"` or `"read"` | Yes | Access scope. |
| `exp` | number | Yes | Expiration time (Unix timestamp in seconds). |
| `stream_id` | string | No | Optional. Restricts the token to a specific stream. |

The `alg` header must be `HS256`. No other algorithms are accepted.

## KV Registry

The `REGISTRY` KV namespace stores per-project configuration. Each key is a project ID, each value is a JSON object:

```json
{ "signingSecrets": ["primary-key", "old-key-during-rotation"] }
```

`signingSecrets[0]` is the **primary key** used for minting new JWTs. All keys in the array are tried during verification (short-circuit on first match), enabling zero-downtime key rotation.

The legacy single-key format `{ "signingSecret": "..." }` is still readable — `lookupProjectConfig` normalizes it to an array on read. New writes always use the array format.

Both core and subscription workers bind to the same `REGISTRY` namespace. Every authenticated request performs one KV read to look up the signing secrets. KV reads are cached at the edge by Cloudflare.

Projects are registered via the core worker's RPC method `registerProject(projectId, signingSecret)`, which writes the KV entry.

## Key Rotation

To rotate a project's signing secret with zero downtime:

1. **Add the new key**: Call `addSigningKey(projectId, newSecret)`. This prepends the new key as primary. Both old and new keys are now valid.
2. **Wait for token expiry**: Allow all in-flight JWTs signed with the old key to expire (depends on your token TTL — typically 1 hour).
3. **Remove the old key**: Call `removeSigningKey(projectId, oldSecret)`. Only the new key remains.

The `addSigningKey` and `removeSigningKey` RPC methods are available on `CoreWorker`. `removeSigningKey` refuses to remove the last key — at least one signing secret must always exist.

## Core Worker Auth

The core worker uses two separate auth callbacks -- one for mutations, one for reads:

```ts
import { createStreamWorker, projectJwtAuth } from "@durable-streams-cloudflare/core";

const { authorizeMutation, authorizeRead } = projectJwtAuth();
export default createStreamWorker({ authorizeMutation, authorizeRead });
```

### Scope Enforcement

| Operation | Required scope |
|-----------|---------------|
| `PUT` (create stream) | `write` |
| `POST` (append) | `write` |
| `DELETE` (delete stream) | `write` |
| `GET` / `HEAD` (read) | `read` or `write` |
| `GET ?live=sse` (SSE) | `read` or `write` |
| `GET ?live=long-poll` (long-poll) | `read` or `write` |

### Stream-Scoped Tokens

If the JWT contains a `stream_id` claim, core's read auth verifies that `stream_id` matches the stream portion of the request path. This restricts the token to a single stream -- useful for granting clients read access to one stream without access to others in the same project.

Mutation auth does not check `stream_id` (mutations already require `write` scope).

### Public Stream Bypass

Core supports public streams via a `public` column on the `stream_meta` table (added via migration). When a stream is marked public, read auth is bypassed -- no JWT required for reads. Writes still require auth. The public flag is set during stream creation and stored in KV metadata.

## Subscription Worker Auth

The subscription worker uses a single auth callback with action-based scope mapping:

```ts
import { createSubscriptionWorker, projectJwtAuth } from "@durable-streams-cloudflare/subscription";

export default createSubscriptionWorker({ authorize: projectJwtAuth() });
```

### Scope Enforcement

| Action | Required scope |
|--------|---------------|
| `publish` | `write` |
| `unsubscribe` | `write` |
| `deleteSession` | `write` |
| `subscribe` | `read` or `write` |
| `getSession` | `read` or `write` |
| `touchSession` | `read` or `write` |

The subscription auth also checks that `claims.sub === route.project` (the JWT's subject must match the project in the URL) and validates the optional `stream_id` claim against the stream in the route (if applicable).

### Custom Auth

Both workers support custom auth callbacks for non-JWT authentication:

```ts
// Core: separate callbacks for mutations and reads
createStreamWorker({
  authorizeMutation: async (request, doKey, env, timing) => { ... },
  authorizeRead: async (request, doKey, env, timing) => { ... },
});

// Subscription: single callback with route context
createSubscriptionWorker({
  authorize: async (request, route, env) => { ... },
});
```

The subscription `route` parameter is a discriminated union providing the parsed action, project, and IDs (see Chapter 9 for the full `SubscriptionRoute` type).

## Minting JWTs

To mint a JWT for a client, sign it with the project's signing secret using HS256:

```ts
// Node.js example (jose library)
import * as jose from "jose";

const secret = new TextEncoder().encode("your-project-signing-secret");
const token = await new jose.SignJWT({
  sub: "my-project",
  scope: "read",
})
  .setProtectedHeader({ alg: "HS256" })
  .setExpirationTime("1h")
  .sign(secret);
```

For stream-scoped tokens, add the `stream_id` claim:

```ts
const token = await new jose.SignJWT({
  sub: "my-project",
  scope: "read",
  stream_id: "chat-room-1",
})
  .setProtectedHeader({ alg: "HS256" })
  .setExpirationTime("1h")
  .sign(secret);
```

## SSE Auth Note

`EventSource` cannot set custom headers. For SSE connections, use:
- **Cookie auth** (if the Worker is on the same domain)
- **Short-lived signed token in the query string** (e.g., `?token=<jwt>`)
- **`fetch()` streaming** or **WebSocket** if you need header-based auth

## No Auth Mode

Both workers can run without auth for development or single-tenant deployments:

```ts
// Core: omit auth callbacks
export default createStreamWorker();

// Subscription: omit authorize
export default createSubscriptionWorker();
```

Health check endpoints (`GET /health`) always bypass auth in both workers.

## Auth × Edge Cache Interaction

Auth runs **before** the edge cache. The flow in `create_worker.ts` is:

```
Request → parse path → auth check → cache lookup → DO
```

An unauthenticated request is rejected at the auth step and never reaches `caches.default.match()`. This means:

1. User A authenticates (valid JWT), cache MISS → response fetched from DO, stored in `caches.default`.
2. User B authenticates (different valid JWT, same project), same URL → cache HIT, served from cache.
3. User C fails auth → 401/403, never sees cached data.

This is correct: any valid reader of a stream gets the same immutable data at a given offset. The cache is a transparent acceleration layer behind the auth wall.

### Cache Key Contains No Auth Info

The cache key is the bare URL (`request.url`). No `Authorization` header, no token hash, no `Vary` header. This is intentional — varying the cache key by token would fragment the cache and destroy request collapsing (the core scaling mechanism: 1M readers → 1 DO hit per poll cycle).

Responses carry `Cache-Control: public, max-age=60` (catch-up reads) or `public, max-age=20` (long-poll). The CDN can serve these cached responses to anyone who requests the URL — auth only runs in the worker, which the CDN can bypass on cache hits.

See `docs/12-cdn-reader-key.md` for the design addressing this gap.
