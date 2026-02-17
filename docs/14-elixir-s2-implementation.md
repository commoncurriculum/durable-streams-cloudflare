# Chapter 14: Elixir + S2 — Stateless API Layer with Durable Stream Storage

A design for scalable real-time streaming using **stateless** Elixir API servers backed by [S2](https://github.com/s2-streamstore/s2) for all durable state. Deployed on Kubernetes with multiple app instances. No in-memory state that would be lost on redeploy.

## Goals

1. **Scalable writes without touching our database.** Writes go to S2 (backed by object storage). Spiky traffic is S2's problem, not ours.
2. **No thundering herd on redeploy.** All state lives in S2, not in app server memory. Redeploying Elixir nodes loses nothing. Clients reconnect to any instance and resume from their last sequence number.
3. **Real-time client protocol.** SSE for live tailing, long-poll for catch-up. Clients who go offline resume seamlessly from their last position.
4. **Horizontally scalable.** Multiple Elixir instances behind a load balancer. No distributed Erlang, no GenServer-per-stream, no in-memory coordination.

## Why S2

[S2](https://s2.dev) is a durable streams API backed entirely by object storage. `s2-lite` is the open-source, self-hostable implementation using [SlateDB](https://slatedb.io) over S3/Tigris.

What S2 gives us that we'd otherwise need to build:

| Capability | S2 provides | Without S2 |
|------------|------------|------------|
| Durable append-only log | ✅ Native — data is on object storage before ACK | Build our own on Postgres/Redis |
| Live tailing (read sessions) | ✅ `readSession` with `waitSecs` blocks until new data arrives | Build pub/sub + polling |
| Catch-up reads | ✅ Read from any sequence number | Query database with offset |
| Sequence numbers | ✅ Monotonic per stream, assigned on append | Generate our own |
| Backpressure | ✅ Append sessions with `maxInflightBytes` | Build our own |
| Ordering | ✅ Single-writer serialization per stream (`streamer` task) | Serialize in our app layer |
| Idempotent appends | ✅ `matchSeqNum` conditional writes | Build fencing ourselves |
| No DB load | ✅ All I/O is object storage | Hammers our DB |

S2's `readSession` is the key feature. It's a streaming read that follows the tail of a stream — when there's no new data, the server holds the connection and waits (up to `waitSecs`). This is exactly the primitive we need for both SSE and long-poll, without building any broadcast infrastructure in our app.

### Managed S2 vs s2-lite

| | Managed ([s2.dev](https://s2.dev)) | s2-lite (self-hosted) |
|---|---|---|
| Scaling | Unlimited streams, fully managed | Single-node binary |
| Durability | Multi-AZ object storage | Whatever you point at (S3, Tigris, MinIO) |
| Ops burden | Zero | You run it on K8s |
| Cost | Usage-based | Infrastructure cost only |
| Availability | Managed SLA | You handle HA |

**Recommendation:** Use **managed S2** for production. Use **s2-lite** (in-memory mode) for local dev and integration tests. s2-lite is single-node, but managed S2 scales horizontally without any changes to our code.

For teams that must self-host everything: run s2-lite backed by S3 with a health-checked K8s deployment. s2-lite restarts are safe — all data is on object storage, and the process reconstructs its in-memory index from SlateDB on startup.

## Architecture

```
                        ┌─────────────────────────────────────────────┐
                        │            Kubernetes Cluster                │
                        │                                             │
    Client ────────────>│  ┌───────────┐  ┌───────────┐               │
    (SSE / long-poll /  │  │ Elixir-1  │  │ Elixir-2  │  ... N       │
     POST append)       │  │ (stateless│  │ (stateless│               │
                        │  │  API)     │  │  API)     │               │
                        │  └─────┬─────┘  └─────┬─────┘               │
                        │        │              │                     │
                        │        └──────┬───────┘                     │
                        │               │                             │
                        │               v                             │
                        │     ┌──────────────────┐                    │
                        │     │   S2 (managed)    │───> Object Storage │
                        │     │   or s2-lite pod  │    (S3 / Tigris)  │
                        │     └──────────────────┘                    │
                        └─────────────────────────────────────────────┘
```

**The Elixir app is a stateless HTTP proxy with auth and protocol translation.** It doesn't hold stream state, subscription state, or connection state that can't be reconstructed from S2. Any instance can handle any request.

### What lives where

| Concern | Where it lives | Why |
|---------|---------------|-----|
| Stream data (messages) | S2 streams | Durable, append-only, tailable |
| Stream metadata (content-type, closed) | S2 stream records (first record = metadata) or a per-project metadata stream | Durable, not in app memory |
| Subscription mappings | S2 metadata stream per project (e.g., `_subscriptions/{streamId}`) | Survives redeploy |
| Session state | S2 (session = just another stream) | Clients resume by sequence number |
| Auth secrets | Kubernetes Secrets → environment variables, or a Vault/config store | Not in S2, not in app memory |
| Nothing | Elixir process memory | **This is the point** |

## Request Flows

### Append (Write)

```
Client ── POST /v1/stream/:project/:stream ──> Any Elixir instance
                                                    │
                                                    │ 1. Validate auth (JWT from env/config)
                                                    │ 2. Forward to S2
                                                    v
                                               S2.append(basin, stream, records)
                                                    │
                                                    │ 3. S2 ACKs after durable write to object storage
                                                    v
                                               204 + Stream-Next-Offset header
```

The Elixir app does not serialize writes — S2 does that internally (one `streamer` task per stream). The app just forwards the request.

```elixir
defmodule DurableStreamsWeb.StreamController do
  use DurableStreamsWeb, :controller

  def append(conn, %{"project" => project, "stream" => stream}) do
    {:ok, body, conn} = Plug.Conn.read_body(conn)
    content_type = get_req_header(conn, "content-type") |> List.first()

    basin = basin_name(project)
    record = %{body: body, headers: [{"content-type", content_type}]}

    case DurableStreams.S2.append(basin, stream, [record]) do
      {:ok, %{end_seq_num: next_offset}} ->
        conn
        |> put_resp_header("stream-next-offset", Integer.to_string(next_offset))
        |> send_resp(204, "")

      {:error, reason} ->
        send_error(conn, reason)
    end
  end
end
```

### SSE Live Read

This is where S2's `readSession` shines. Each SSE connection maps 1:1 to an S2 read session that tails the stream. **No broadcast infrastructure needed in the Elixir app.**

```
Client ── GET /v1/stream/:project/:stream?live=sse ──> Any Elixir instance
                                                            │
                                                            │ 1. Open S2 read session
                                                            │    (start: client's offset,
                                                            │     stop: none — tail forever)
                                                            v
                                                       S2.readSession(basin, stream,
                                                         start: {seqNum: offset})
                                                            │
                                                            │ 2. S2 pushes records as
                                                            │    they're appended
                                                            │ 3. Elixir bridges to SSE
                                                            v
                                                       SSE event stream to client
```

```elixir
def stream_sse(conn, project, stream, offset) do
  conn =
    conn
    |> put_resp_header("content-type", "text/event-stream")
    |> put_resp_header("cache-control", "no-cache")
    |> put_resp_header("connection", "keep-alive")
    |> send_chunked(200)

  basin = basin_name(project)

  # Open a tailing read session on S2
  # This blocks and yields records as they arrive — no polling needed
  {:ok, session} = DurableStreams.S2.read_session(basin, stream,
    start: %{seq_num: offset},
    stop: :none  # tail forever
  )

  # Bridge S2 read session to SSE events
  Enum.reduce_while(session, conn, fn record, conn ->
    event = encode_sse_event(record)
    case Plug.Conn.chunk(conn, event) do
      {:ok, conn} -> {:cont, conn}
      {:error, _} -> {:halt, conn}  # Client disconnected
    end
  end)
end

defp encode_sse_event(record) do
  data = Base.encode64(record.body)
  seq = Integer.to_string(record.seq_num)
  "id: #{seq}\ndata: #{data}\n\n"
end
```

When the client disconnects, the Elixir process exits, which closes the S2 read session. Clean and simple.

When the client reconnects (to any Elixir instance), it sends `Last-Event-ID: <seqNum>` and the new instance opens a fresh S2 read session from that offset. **No state was lost because there was no state to lose.**

### Long-Poll Read

```
Client ── GET /v1/stream/:project/:stream?offset=N ──> Any Elixir instance
                                                            │
                                                            │ 1. S2 read with waitSecs
                                                            v
                                                       S2.read(basin, stream,
                                                         start: {seqNum: N},
                                                         stop: {waitSecs: 30})
                                                            │
                                                            │ 2. Returns immediately if
                                                            │    data exists at offset N,
                                                            │    or waits up to 30s for
                                                            │    new records
                                                            v
                                                       200 + records + Stream-Next-Offset
```

```elixir
def long_poll(conn, project, stream, offset) do
  basin = basin_name(project)

  case DurableStreams.S2.read(basin, stream,
    start: %{seq_num: offset},
    stop: %{wait_secs: 30, count: 100}
  ) do
    {:ok, %{records: records}} when records != [] ->
      last = List.last(records)
      conn
      |> put_resp_header("stream-next-offset", Integer.to_string(last.seq_num + 1))
      |> json(encode_records(records))

    {:ok, %{records: []}} ->
      # Timeout — no new data
      conn
      |> put_resp_header("stream-up-to-date", "true")
      |> send_resp(204, "")

    {:error, reason} ->
      send_error(conn, reason)
  end
end
```

S2's `waitSecs` means the Elixir app doesn't need to implement its own long-poll queue or parking mechanism. S2 handles the waiting.

## Pub/Sub Fan-Out

The current Cloudflare implementation fans out by writing copies to per-session streams. With S2, we have two design options.

### Option A: Fan-Out Writes to Session Streams (Same as Current)

Same model as the Cloudflare implementation — publish writes to the source stream, then copies to each subscriber's session stream. The difference: the Elixir app is stateless, so subscriber lists are stored in S2.

```
Publisher ── POST /publish/:stream ──> Any Elixir instance
                                           │
                                           ├─ 1. Append to source stream in S2
                                           ├─ 2. Read subscriber list from S2
                                           │     (stream: _meta/{project}/subs/{stream})
                                           └─ 3. Fan out: append to each session stream
                                                  (parallel, using Task.async_stream)
```

Subscriber lists are stored as records in a metadata stream:

```
S2 stream: _meta/{project}/subs/{stream}
Records:
  { action: "subscribe", session_id: "alice", ts: ... }
  { action: "subscribe", session_id: "bob", ts: ... }
  { action: "unsubscribe", session_id: "alice", ts: ... }
```

To get the current subscriber list, read the full metadata stream and replay the subscribe/unsubscribe events. This is fast because metadata streams are small (hundreds of records, not millions). For high-frequency publishes, cache the reduced subscriber set in ETS with a short TTL and invalidate on subscription changes.

```elixir
defmodule DurableStreams.Subscriptions do
  @doc """
  Get current subscribers by replaying the subscription log.
  In production, cache this result in ETS with a TTL to avoid
  re-reading on every publish.
  """
  def list_subscribers(basin, stream_id) do
    meta_stream = "_meta/subs/#{stream_id}"

    case DurableStreams.S2.read_all(basin, meta_stream) do
      {:ok, records} ->
        records
        |> Enum.reduce(MapSet.new(), fn record, acc ->
          event = Jason.decode!(record.body)
          case event["action"] do
            "subscribe" -> MapSet.put(acc, event["session_id"])
            "unsubscribe" -> MapSet.delete(acc, event["session_id"])
            _ -> acc
          end
        end)
        |> MapSet.to_list()
        |> then(&{:ok, &1})

      {:error, reason} -> {:error, reason}
    end
  end

  @doc """
  Fan out a message to all subscribers' session streams.
  """
  def fanout(basin, stream_id, payload, content_type) do
    case list_subscribers(basin, stream_id) do
      {:ok, subscribers} ->
        subscribers
        |> Task.async_stream(
          fn session_id ->
            session_stream = "session:#{session_id}"
            DurableStreams.S2.append(basin, session_stream, [
              %{body: payload, headers: [{"content-type", content_type}]}
            ])
          end,
          max_concurrency: 50,
          timeout: 10_000,
          on_timeout: :kill_task
        )
        |> Enum.reduce(%{ok: 0, error: 0}, fn
          {:ok, {:ok, _}}, acc -> %{acc | ok: acc.ok + 1}
          _, acc -> %{acc | error: acc.error + 1}
        end)

      {:error, reason} ->
        {:error, reason}
    end
  end
end
```

**Trade-off:** Write amplification (N writes per publish). Same as the Cloudflare design. Works well at subscriber counts under ~1,000.

### Option B: Direct Read from Source Stream (Simpler, Recommended)

Instead of copying messages to per-session streams, **clients read the source stream directly.** Each client tracks its own offset. No fan-out writes needed.

```
Publisher ── POST /publish/:stream ──> Elixir ──> S2.append(stream)
                                                      │
Reader A ── GET /stream/:stream?live=sse ──> Elixir ──┤──> S2.readSession(stream, from: A's offset)
Reader B ── GET /stream/:stream?live=sse ──> Elixir ──┤──> S2.readSession(stream, from: B's offset)
Reader C ── GET /stream/:stream?live=sse ──> Elixir ──┘──> S2.readSession(stream, from: C's offset)
```

No subscription metadata. No session streams. No fan-out. Each reader opens its own S2 read session on the source stream and gets records as they're appended.

**Why this works:**
- S2's `streamer` task broadcasts to all followers of a stream. It handles the fan-out internally.
- Each read session is independent. Adding readers doesn't affect write throughput.
- Clients remember their offset (in `Last-Event-ID` for SSE, or in a query param for long-poll). No server-side session state.

**When to use fan-out (Option A) instead:**
- When different subscribers need different subsets of the data (filtered views)
- When you need to transform messages per-subscriber
- When subscribers consume from multiple source streams into one session stream

**Recommendation:** Start with Option B. It's simpler, has no write amplification, and S2 handles the read fan-out natively. Add Option A only if you need per-subscriber transformations.

## Thundering Herd: Why It's a Non-Issue

With the Cloudflare implementation, redeploying the Worker means Durable Objects may restart, losing in-memory state (WebSocket connections, long-poll queues). Clients reconnect and re-establish everything — thundering herd.

With the Elixir + S2 design:

| On redeploy | What happens |
|-------------|-------------|
| SSE connections drop | Client reconnects to any new instance, sends `Last-Event-ID`. New instance opens S2 read session from that offset. **Sub-second recovery.** |
| Long-poll requests abort | Client retries with same offset. New instance reads from S2. **Transparent.** |
| In-memory state lost | **There is no in-memory state.** All state is in S2. |
| S2 is unaffected | S2 is a separate service (or managed). It doesn't redeploy when you deploy your app. |

The only "thundering herd" scenario is if S2 itself restarts. With managed S2, this is their problem. With s2-lite, the restart is fast (SlateDB replays from object storage) and clients simply retry their reads — S2 handles them once it's back.

## Multi-Instance Scaling

The Elixir app is stateless, so horizontal scaling is trivial:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: durable-streams
spec:
  replicas: 4  # Scale freely
  selector:
    matchLabels:
      app: durable-streams
  template:
    spec:
      containers:
        - name: app
          image: your-registry/durable-streams:latest
          ports:
            - containerPort: 4000
          env:
            - name: S2_ENDPOINT
              value: "https://your-basin.b.s2.dev"  # Managed S2
            - name: S2_ACCESS_TOKEN
              valueFrom:
                secretKeyRef:
                  name: s2-credentials
                  key: token
          resources:
            requests:
              memory: "128Mi"
              cpu: "100m"
            limits:
              memory: "256Mi"
              cpu: "500m"
          readinessProbe:
            httpGet:
              path: /health
              port: 4000
```

No leader election. No distributed Erlang. No process registries. No sidecar. Each instance independently talks to S2. The load balancer distributes requests.

### What scales where

| Bottleneck | How it scales |
|-----------|--------------|
| HTTP connections (SSE) | Add more Elixir instances |
| Write throughput | S2 handles it (200 batches/sec per stream, tens of MiB/s) |
| Read throughput | S2 handles fan-out to multiple read sessions |
| Number of streams | Managed S2: unlimited. s2-lite: single-node, partition by basin |

The only case where the Elixir layer becomes a bottleneck is if you have so many concurrent SSE connections that you run out of Erlang processes (unlikely — the BEAM handles millions). At that point, add more replicas.

## Elixir Application Structure

```
durable_streams/
├── lib/
│   ├── durable_streams/
│   │   ├── application.ex          # Minimal OTP app (Finch pool, Telemetry)
│   │   ├── s2.ex                   # S2 HTTP client (Req + Finch)
│   │   └── auth.ex                 # JWT verification (JOSE)
│   │
│   └── durable_streams_web/
│       ├── router.ex               # Phoenix router
│       ├── plugs/
│       │   ├── auth_plug.ex        # JWT auth plug
│       │   └── cors_plug.ex        # CORS plug
│       └── controllers/
│           ├── stream_controller.ex    # PUT/POST/GET/HEAD/DELETE
│           ├── publish_controller.ex   # POST /publish/:stream (fan-out)
│           └── health_controller.ex    # GET /health
│
├── config/
│   └── runtime.exs                 # S2_ENDPOINT, auth config from env
├── mix.exs
├── Dockerfile
└── test/
    ├── controllers/
    │   ├── stream_controller_test.exs
    │   └── publish_controller_test.exs
    └── test_helper.exs             # Starts s2-lite in-memory for tests
```

There's intentionally no `GenServer`, no `Supervisor` tree beyond what Phoenix provides, no `Registry`, no `DynamicSupervisor`. The application is a thin HTTP layer.

### S2 Client

```elixir
defmodule DurableStreams.S2 do
  @moduledoc """
  HTTP client for S2. Stateless — reads config from application env.
  """

  def append(basin, stream, records) do
    Req.post(url("/streams/#{stream}/records"),
      json: %{records: Enum.map(records, &encode_record/1)},
      headers: [{"s2-basin", basin}, auth_header()]
    )
    |> handle_append_response()
  end

  def read(basin, stream, opts) do
    params = build_read_params(opts)

    Req.get(url("/streams/#{stream}/records"),
      params: params,
      headers: [{"s2-basin", basin}, auth_header()]
    )
    |> handle_read_response()
  end

  @doc """
  Opens a streaming read session. Returns a Stream that yields records.
  Uses S2's native tailing — blocks until new data arrives.

  Implementation uses Req's streaming response support (:into option)
  to consume S2's chunked HTTP response as an Elixir Stream.
  """
  def read_session(basin, stream, opts) do
    params = build_read_params(opts)

    # open_read_connection/3, read_next_record/1, close_connection/1
    # are implementation details that wrap Req's streaming HTTP client.
    Stream.resource(
      fn -> open_read_connection(basin, stream, params) end,
      fn conn -> read_next_record(conn) end,
      fn conn -> close_connection(conn) end
    )
  end

  def create_stream(basin, stream) do
    Req.post(url("/streams"),
      json: %{stream: stream},
      headers: [{"s2-basin", basin}, auth_header()]
    )
  end

  def check_tail(basin, stream) do
    Req.get(url("/streams/#{stream}"),
      headers: [{"s2-basin", basin}, auth_header()]
    )
    |> handle_tail_response()
  end

  defp url(path), do: "#{endpoint()}#{path}"
  defp endpoint, do: Application.get_env(:durable_streams, :s2_endpoint)
  defp auth_header, do: {"authorization", "Bearer #{s2_token()}"}
  defp s2_token, do: Application.get_env(:durable_streams, :s2_access_token)

  defp encode_record(%{body: body, headers: headers}) do
    %{
      body: Base.encode64(body),
      headers: Enum.map(headers, fn {k, v} -> [k, v] end)
    }
  end
end
```

### Test Setup with s2-lite

Integration tests spin up s2-lite in-memory — no external dependencies:

```elixir
# test/test_helper.exs
# Start s2-lite as a Docker container for integration tests
{_, 0} = System.cmd("docker", [
  "run", "-d", "--name", "s2-lite-test",
  "-p", "18080:80",
  "ghcr.io/s2-streamstore/s2", "lite"
])

# Wait for readiness
:timer.sleep(1000)

Application.put_env(:durable_streams, :s2_endpoint, "http://localhost:18080")
Application.put_env(:durable_streams, :s2_access_token, "ignored")

ExUnit.start()

# Cleanup on exit
System.at_exit(fn _ ->
  System.cmd("docker", ["rm", "-f", "s2-lite-test"])
end)
```

## S2 Protocol vs Durable Streams Protocol

The user's protocol requirements: SSE for real-time, long-poll for catch-up, and seamless offline-to-online transitions. Both the Durable Streams protocol and the S2 protocol solve these problems, but differently.

| Feature | Durable Streams Protocol | S2 Protocol |
|---------|------------------------|-------------|
| Offset format | `readSeq_byteOffset` (segment-aware) | Integer sequence number |
| Live tail | SSE via internal WebSocket bridge | Read session with `waitSecs` |
| Catch-up | GET with offset | Read from any `seqNum` |
| Cursor rotation | `Stream-Cursor` header for cache-busting | Not needed (no CDN caching layer) |
| Producer fencing | `Producer-Id` / `Producer-Epoch` / `Producer-Seq` headers | `matchSeqNum` conditional appends |
| Idempotent writes | Producer epoch/seq dedup | `matchSeqNum` + SDK dedupe patterns |
| Message format | Raw body + content-type | Records with headers + body (richer) |

### Recommendation: Use S2's Protocol Directly

S2's protocol is simpler and already solves the same problems:

- **Offline → online**: Client remembers `seqNum`, reads from there. S2 returns all records since that position instantly (catch-up), then tails for new ones (live).
- **SSE**: The Elixir app bridges S2 read sessions to SSE. Each SSE `id:` field is the S2 `seqNum`. The client's `Last-Event-ID` maps directly to the S2 read position.
- **Long-poll**: S2's `waitSecs` parameter on read is literally long-poll built into the storage layer.
- **Idempotent writes**: S2's `matchSeqNum` is simpler than the epoch/seq model but achieves the same goal. For more complex dedup, use the `@s2-dev/streamstore-patterns` library's `SerializingAppendSession` which adds `_dedupe_seq` and `_writer_id` headers.

There's no need to implement the Durable Streams protocol on top of S2. **Use S2's API as your client protocol** (possibly with a thin auth/CORS layer in Elixir).

If you want clients to use the TypeScript SDK directly:

```typescript
import { S2, AppendInput, AppendRecord } from "@s2-dev/streamstore";

const s2 = new S2({
  accountEndpoint: "https://your-elixir-api.example.com",  // Elixir proxies to S2
  accessToken: "your-jwt",
});

const stream = s2.basin("my-project").stream("my-stream");

// Write
await stream.append(AppendInput.create([
  AppendRecord.string({ body: JSON.stringify({ text: "hello" }) }),
]));

// Live tail
const session = await stream.readSession({
  start: { from: { seqNum: lastKnownSeqNum } },
});

for await (const record of session) {
  console.log(record.seqNum, record.body);
}
```

## Dependencies (mix.exs)

```elixir
defp deps do
  [
    {:phoenix, "~> 1.7"},
    {:plug_cowboy, "~> 2.7"},
    {:req, "~> 0.5"},           # HTTP client for S2
    {:finch, "~> 0.19"},        # Connection pooling
    {:jose, "~> 1.11"},         # JWT verification
    {:jason, "~> 1.4"},         # JSON
    {:telemetry, "~> 1.3"},     # Observability
    {:prom_ex, "~> 1.9"},       # Prometheus metrics
  ]
end
```

No distributed Erlang libraries (`libcluster`, `horde`). No GenStage/Broadway. No ETS tables for state. Just Phoenix, an HTTP client, and auth.

## Kubernetes Deployment

### Elixir App

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: durable-streams
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1     # Rolling deploys: clients reconnect to remaining instances
      maxSurge: 1
  selector:
    matchLabels:
      app: durable-streams
  template:
    metadata:
      labels:
        app: durable-streams
    spec:
      terminationGracePeriodSeconds: 60  # Allow SSE connections to drain on deploy
      containers:
        - name: app
          image: your-registry/durable-streams:latest
          ports:
            - containerPort: 4000
          env:
            - name: S2_ENDPOINT
              value: "https://your-basin.b.s2.dev"
            - name: S2_ACCESS_TOKEN
              valueFrom:
                secretKeyRef:
                  name: s2-credentials
                  key: token
            - name: SECRET_KEY_BASE
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: secret-key-base
          readinessProbe:
            httpGet:
              path: /health
              port: 4000
            initialDelaySeconds: 5
          resources:
            requests:
              memory: "128Mi"
              cpu: "100m"
---
apiVersion: v1
kind: Service
metadata:
  name: durable-streams
spec:
  selector:
    app: durable-streams
  ports:
    - port: 80
      targetPort: 4000
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: durable-streams
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"   # SSE needs long timeouts
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-buffering: "off"        # Disable for SSE
spec:
  rules:
    - host: streams.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: durable-streams
                port:
                  number: 80
```

### s2-lite (for self-hosted / dev)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: s2-lite
spec:
  replicas: 1          # s2-lite is single-node
  selector:
    matchLabels:
      app: s2-lite
  template:
    spec:
      containers:
        - name: s2-lite
          image: ghcr.io/s2-streamstore/s2:latest
          args: ["lite", "--bucket", "$(S3_BUCKET)", "--path", "durable-streams"]
          ports:
            - containerPort: 80
          env:
            - name: S3_BUCKET
              valueFrom:
                secretKeyRef:
                  name: s2-config
                  key: bucket
            - name: AWS_ACCESS_KEY_ID
              valueFrom:
                secretKeyRef:
                  name: s2-config
                  key: aws-access-key-id
            - name: AWS_SECRET_ACCESS_KEY
              valueFrom:
                secretKeyRef:
                  name: s2-config
                  key: aws-secret-access-key
          readinessProbe:
            httpGet:
              path: /health
              port: 80
          resources:
            requests:
              memory: "256Mi"
              cpu: "250m"
```

## Cost Comparison

| | Cloudflare (current) | Elixir + Managed S2 | Elixir + s2-lite |
|---|---|---|---|
| Compute | $8/mo (Workers @ 99% CDN HIT) | ~$30/mo (3 small K8s pods) | ~$30/mo (3 small K8s pods) |
| Stream storage | $5 (SQLite) + $0.50 (R2) | S2 usage-based pricing | ~$2/mo (S3) |
| Auth | $32 (KV reads) | $0 (env vars) | $0 (env vars) |
| S2 service | — | S2 pricing (usage-based) | $0 (self-hosted) |
| CDN proxy | $6 (VPS) | $0 (optional) | $0 (optional) |
| Ops burden | Low (serverless) | Medium (K8s) | Medium-High (K8s + s2-lite) |

The cost of managed S2 depends on volume — check [s2.dev](https://s2.dev) for current pricing. For self-hosted s2-lite, the main cost is the S3 storage and operations.

## What We Don't Need to Build

Because S2 handles the hard parts, the Elixir app is dramatically simpler than the Cloudflare implementation:

| Cloudflare Component | Elixir Equivalent | Why |
|---------------------|-------------------|-----|
| StreamDO (Durable Object) | ❌ Not needed | S2 serializes writes |
| SQLite hot log | ❌ Not needed | S2 is the hot log |
| R2 cold segments | ❌ Not needed | S2 tiers to object storage internally |
| Segment rotation | ❌ Not needed | S2 handles it |
| DO Hibernation + WS bridge | ❌ Not needed | No DO billing model to optimize |
| Edge cache + cursor rotation | ❌ Not needed | No CDN HIT optimization needed (no per-request billing) |
| Long-poll queue (`LongPollQueue`) | ❌ Not needed | S2's `waitSecs` handles it |
| Producer fencing (epoch/seq) | ❌ Not needed | S2's `matchSeqNum` or SDK patterns |
| `caches.default` store guards | ❌ Not needed | No Workers Cache API |
| Offset encoding (`readSeq_byteOffset`) | ❌ Not needed | S2 uses simple integer `seqNum` |

What we **do** build:
- Auth (JWT verification — ~50 lines)
- CORS (standard Plug — ~20 lines)
- SSE bridging (S2 read session → chunked response — ~40 lines)
- Long-poll endpoint (S2 read with `waitSecs` — ~30 lines)
- Fan-out (if using Option A — ~100 lines)
- Health check (~5 lines)

Total application code: **~250-500 lines of Elixir**, not counting tests.

## Open Questions

1. **Managed S2 vs s2-lite for production**: Managed S2 is the right answer for most teams (zero ops, scales horizontally). s2-lite is for teams that must self-host everything or want to minimize external dependencies.

2. **Fan-out model**: Option B (direct read from source stream) is simpler and recommended. Option A (session streams) is available if per-subscriber filtering or multi-stream aggregation is needed.

3. **Auth passthrough**: Should the Elixir app verify JWTs and proxy to S2 with a service token? Or should clients authenticate directly with S2? The proxy approach (Elixir verifies JWT, uses its own S2 token) gives you more control over access patterns.

4. **Caching**: Without Cloudflare's CDN, there's no free caching layer. For most use cases this is fine — S2 serves reads efficiently. If needed, add Nginx/Varnish in front of the Elixir app for catch-up reads (not SSE).