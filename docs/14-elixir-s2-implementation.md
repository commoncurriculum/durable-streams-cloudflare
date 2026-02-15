# Chapter 14: Elixir Implementation with S2 Storage

An alternative implementation of Durable Streams using Elixir/OTP deployed on Kubernetes, with [S2](https://github.com/s2-streamstore/s2) (specifically `s2-lite`) as the durable stream storage backend. This design replaces Cloudflare Durable Objects + SQLite + R2 with Elixir GenServers + S2, while preserving the same protocol semantics and pub/sub fan-out model.

## Motivation

Cloudflare Durable Objects provide excellent single-writer semantics and built-in durability, but introduce platform lock-in and operational concerns:

- **Reliability**: DO availability depends entirely on Cloudflare's infrastructure — no self-hosted fallback.
- **Debugging**: Limited observability into DO internals; no SSH, no local replica, no custom profiling.
- **Vendor lock-in**: SQLite-in-DO, R2, Hibernation API, and service bindings are all Cloudflare-specific.
- **Cost at scale**: Fan-out write amplification (Chapter 2) means SQLite row writes dominate at high subscriber counts.

S2 provides a purpose-built durable streams API that maps cleanly to the Durable Streams protocol. Running on Kubernetes gives full operational control.

## S2 Overview

[S2](https://s2.dev) is a serverless datastore for real-time streaming data. `s2-lite` is the open-source, self-hostable implementation.

**Key properties:**
- **Durable append-only streams**: Data is durable on object storage (S3, Tigris, R2) before being acknowledged.
- **SlateDB storage engine**: Built on [SlateDB](https://slatedb.io), which uses object storage as its primary durable layer.
- **Single binary**: No external dependencies besides an object storage bucket.
- **REST + streaming sessions**: HTTP API for CRUD, plus the S2S protocol for high-throughput streaming.
- **Per-stream serialization**: Each stream has a `streamer` Tokio task that serializes appends and broadcasts to followers — the same conceptual model as our DO-per-stream.
- **Docker-ready**: `ghcr.io/s2-streamstore/s2` with Prometheus metrics and health endpoints.

**S2 concepts mapping:**

| S2 Concept | Durable Streams Equivalent |
|------------|--------------------------|
| Basin | Project namespace |
| Stream | Individual stream (1:1) |
| Record | Message/op in the append log |
| Sequence number | Byte offset within a stream |
| Append session | Producer with fencing (epoch/seq) |
| Read session | Long-poll / SSE reader |

## Architecture

```
                    ┌─────────────────────────────────────────────────┐
                    │              Kubernetes Cluster                  │
                    │                                                  │
   Client ────────>│  ┌──────────────────────────────────────────┐   │
                    │  │          Elixir App (Phoenix)            │   │
                    │  │                                          │   │
                    │  │  Plug Router · Auth · CORS · SSE/LP     │   │
                    │  │       │                                  │   │
                    │  │       v                                  │   │
                    │  │  StreamServer (GenServer per stream)     │   │
                    │  │  - Append serialization                  │   │
                    │  │  - Producer fencing                      │   │
                    │  │  - Broadcast to subscribers              │   │
                    │  │       │                                  │   │
                    │  │       v                                  │   │
                    │  │  S2 Client (HTTP)                        │   │
                    │  └──────┬───────────────────────────────────┘   │
                    │         │                                       │
                    │         v                                       │
                    │  ┌──────────────────┐                           │
                    │  │    s2-lite Pod    │──────> Object Storage     │
                    │  │  (Rust binary)   │        (S3 / Tigris)      │
                    │  │  Port 80         │                           │
                    │  └──────────────────┘                           │
                    └─────────────────────────────────────────────────┘
```

### Component Mapping

| Cloudflare Component | Elixir + S2 Equivalent | Notes |
|---------------------|----------------------|-------|
| Edge Worker | Phoenix/Plug router | Auth, CORS, caching, routing |
| StreamDO (per stream) | `StreamServer` GenServer | One process per active stream, managed by `DynamicSupervisor` |
| DO SQLite (hot log) | S2 stream | Append-only log with sequence numbers |
| R2 (cold segments) | S2 (backed by S3/Tigris) | S2 handles hot/cold tiering internally via SlateDB |
| DO Hibernation | GenServer timeout / `:hibernate` | OTP processes can hibernate to free heap memory |
| `caches.default` | HTTP cache (Varnish, Nginx, CDN) | External caching layer in front of Phoenix |
| DO `blockConcurrencyWhile` | GenServer mailbox serialization | Erlang's single-mailbox-per-process is the equivalent |
| Service bindings (RPC) | Direct function calls | Everything runs in one BEAM node (or distributed Erlang) |
| KV (REGISTRY) | ETS / PostgreSQL / Redis | Project registry for auth secrets |
| Analytics Engine | Prometheus + Grafana | S2-lite exposes `/metrics`; Elixir app uses `:telemetry` |
| Queue (fanout) | `Broadway` / `GenStage` | OTP-native backpressure and batching |
| Cron (cleanup) | `Quantum` scheduler | Or Kubernetes CronJob |

## Elixir Application Structure

```
durable_streams/
├── lib/
│   ├── durable_streams/
│   │   ├── application.ex          # OTP application, supervision tree
│   │   ├── s2_client.ex            # HTTP client for s2-lite (Req/Finch)
│   │   │
│   │   ├── streams/
│   │   │   ├── stream_server.ex    # GenServer per stream (write serialization)
│   │   │   ├── stream_registry.ex  # Registry + DynamicSupervisor for stream processes
│   │   │   ├── producer.ex         # Producer fencing logic (epoch/seq)
│   │   │   ├── offsets.ex          # Offset encoding/parsing
│   │   │   └── broadcast.ex        # Fan-out to SSE/long-poll subscribers
│   │   │
│   │   ├── subscriptions/
│   │   │   ├── subscription_server.ex  # GenServer per source stream (subscriber registry)
│   │   │   ├── session_server.ex       # GenServer per session
│   │   │   ├── fanout.ex              # Batched fan-out with circuit breaker
│   │   │   └── cleanup.ex            # Periodic session expiry
│   │   │
│   │   ├── auth/
│   │   │   ├── jwt.ex              # JWT verification (JOSE library)
│   │   │   └── registry.ex         # Project signing secrets (ETS-backed)
│   │   │
│   │   └── telemetry.ex            # :telemetry events + Prometheus reporter
│   │
│   └── durable_streams_web/
│       ├── router.ex               # Phoenix router
│       ├── plugs/
│       │   ├── auth.ex             # Auth plug
│       │   └── cors.ex             # CORS plug
│       ├── controllers/
│       │   ├── stream_controller.ex    # PUT/POST/GET/HEAD/DELETE /v1/stream/:project/:stream
│       │   ├── publish_controller.ex   # POST /v1/:project/publish/:stream
│       │   ├── subscribe_controller.ex # POST /subscribe, DELETE /unsubscribe
│       │   └── session_controller.ex   # GET/POST/DELETE /v1/:project/session/:session
│       └── channels/
│           └── stream_channel.ex   # Phoenix Channel for SSE/WebSocket live reads
│
├── config/
│   ├── config.exs
│   ├── dev.exs
│   ├── prod.exs
│   └── runtime.exs                 # S2 endpoint, auth secrets, etc.
│
├── test/
│   ├── streams/
│   │   ├── stream_server_test.exs
│   │   ├── producer_test.exs
│   │   └── offsets_test.exs
│   ├── subscriptions/
│   │   ├── fanout_test.exs
│   │   └── cleanup_test.exs
│   └── integration/
│       ├── stream_crud_test.exs
│       └── publish_subscribe_test.exs
│
├── mix.exs
├── Dockerfile
└── k8s/
    ├── deployment.yaml
    ├── service.yaml
    ├── s2-lite.yaml
    └── ingress.yaml
```

## Core Modules

### StreamServer (GenServer)

The `StreamServer` is the direct equivalent of `StreamDO`. One GenServer per active stream, managed by a `Registry` + `DynamicSupervisor`. The GenServer mailbox provides the same single-writer serialization that `blockConcurrencyWhile` provides in Durable Objects.

```elixir
defmodule DurableStreams.Streams.StreamServer do
  use GenServer

  # State held in memory while stream is "active"
  defstruct [
    :stream_id,
    :project_id,
    :content_type,
    :tail_offset,
    :closed,
    :created_at,
    producers: %{},           # producer_id => %{epoch, last_seq, last_offset}
    subscribers: MapSet.new(), # PIDs of SSE/long-poll/WS subscribers
    long_poll_queue: []        # Parked long-poll requests
  ]

  # --- Client API ---

  def start_link({project_id, stream_id}) do
    name = via(project_id, stream_id)
    GenServer.start_link(__MODULE__, {project_id, stream_id}, name: name)
  end

  def append(project_id, stream_id, payload, content_type, producer_headers \\ nil) do
    GenServer.call(via(project_id, stream_id), {:append, payload, content_type, producer_headers})
  end

  def read(project_id, stream_id, offset, opts \\ []) do
    # Reads go directly to S2 — no need to route through the GenServer
    # unless we need to park a long-poll request
    case opts[:live] do
      :long_poll ->
        GenServer.call(via(project_id, stream_id), {:read_long_poll, offset}, :timer.seconds(30))
      _ ->
        DurableStreams.S2Client.read(project_id, stream_id, offset)
    end
  end

  # --- Callbacks ---

  @impl true
  def init({project_id, stream_id}) do
    # Load stream metadata from S2 on first access
    case DurableStreams.S2Client.head_stream(project_id, stream_id) do
      {:ok, meta} ->
        state = %__MODULE__{
          stream_id: stream_id,
          project_id: project_id,
          content_type: meta.content_type,
          tail_offset: meta.tail_offset,
          closed: meta.closed,
          created_at: meta.created_at
        }
        {:ok, state, hibernate_timeout()}

      {:error, :not_found} ->
        {:ok, %__MODULE__{stream_id: stream_id, project_id: project_id},
         hibernate_timeout()}
    end
  end

  @impl true
  def handle_call({:append, payload, content_type, producer_headers}, _from, state) do
    with :ok <- validate_content_type(state, content_type),
         :ok <- validate_not_closed(state),
         {:ok, state} <- validate_producer(state, producer_headers),
         {:ok, next_offset} <- do_append(state, payload, content_type, producer_headers) do

      new_state = %{state | tail_offset: next_offset}
      broadcast_to_subscribers(new_state, payload, next_offset)
      flush_long_poll_queue(new_state)

      {:reply, {:ok, next_offset}, new_state, hibernate_timeout()}
    else
      {:error, reason} -> {:reply, {:error, reason}, state, hibernate_timeout()}
    end
  end

  @impl true
  def handle_info(:timeout, state) do
    # Hibernate after inactivity — equivalent to DO hibernation.
    # Frees heap memory but keeps the process alive.
    {:noreply, state, :hibernate}
  end

  # --- Private ---

  defp via(project_id, stream_id) do
    {:via, Registry, {DurableStreams.StreamRegistry, {project_id, stream_id}}}
  end

  defp hibernate_timeout, do: :timer.seconds(30)

  defp do_append(state, payload, content_type, producer_headers) do
    DurableStreams.S2Client.append(
      state.project_id,
      state.stream_id,
      payload,
      content_type,
      producer_headers
    )
  end

  defp broadcast_to_subscribers(state, payload, next_offset) do
    msg = {:stream_data, state.stream_id, payload, next_offset}
    for pid <- state.subscribers, Process.alive?(pid), do: send(pid, msg)
  end

  defp flush_long_poll_queue(state) do
    for {from, _offset} <- state.long_poll_queue do
      GenServer.reply(from, {:ok, :data_available})
    end
  end

  defp validate_content_type(%{content_type: nil}, _ct), do: :ok
  defp validate_content_type(%{content_type: expected}, actual) when expected == actual, do: :ok
  defp validate_content_type(_, _), do: {:error, :content_type_mismatch}

  defp validate_not_closed(%{closed: true}), do: {:error, :stream_closed}
  defp validate_not_closed(_), do: :ok

  defp validate_producer(state, nil), do: {:ok, state}
  defp validate_producer(state, headers) do
    DurableStreams.Streams.Producer.validate(state, headers)
  end
end
```

### S2 Client

A thin HTTP client wrapping the S2 REST API. S2-lite's API is the same as the managed S2 service.

```elixir
defmodule DurableStreams.S2Client do
  @moduledoc """
  HTTP client for s2-lite. Each project maps to an S2 basin.
  Each stream maps to an S2 stream within that basin.
  """

  def append(project_id, stream_id, payload, _content_type, _producer_headers) do
    basin = basin_name(project_id)
    stream = stream_name(stream_id)

    # S2 append: POST /streams/{stream}/records with S2-Basin header
    case Req.post(base_url() <> "/streams/#{stream}/records",
      body: encode_records([payload]),
      headers: [{"s2-basin", basin}]
    ) do
      {:ok, %{status: 200, body: body}} ->
        {:ok, body["end"]["seqNum"]}
      {:ok, %{status: status, body: body}} ->
        {:error, {status, body}}
      {:error, reason} ->
        {:error, reason}
    end
  end

  def read(project_id, stream_id, offset) do
    basin = basin_name(project_id)
    stream = stream_name(stream_id)

    Req.post(base_url() <> "/streams/#{stream}/records",
      json: %{start: %{from: %{seqNum: offset}}, stop: %{limits: %{count: 100}}},
      headers: [{"s2-basin", basin}],
      method: :get
    )
  end

  def head_stream(project_id, stream_id) do
    basin = basin_name(project_id)
    stream = stream_name(stream_id)

    case Req.get(base_url() <> "/streams/#{stream}",
      headers: [{"s2-basin", basin}]
    ) do
      {:ok, %{status: 200, body: body}} -> {:ok, body}
      {:ok, %{status: 404}} -> {:error, :not_found}
      {:error, reason} -> {:error, reason}
    end
  end

  def create_stream(project_id, stream_id, opts \\ []) do
    basin = basin_name(project_id)

    Req.post(base_url() <> "/streams",
      json: %{stream: stream_name(stream_id)},
      headers: [{"s2-basin", basin}]
    )
  end

  def delete_stream(project_id, stream_id) do
    basin = basin_name(project_id)
    stream = stream_name(stream_id)

    Req.delete(base_url() <> "/streams/#{stream}",
      headers: [{"s2-basin", basin}]
    )
  end

  # --- Helpers ---

  defp base_url, do: Application.get_env(:durable_streams, :s2_endpoint, "http://s2-lite:80")
  defp basin_name(project_id), do: "ds-#{project_id}"
  defp stream_name(stream_id), do: stream_id

  defp encode_records(payloads) do
    # Encode as S2 AppendInput format
    # S2 uses a binary record format (S2S spec) for streaming,
    # or JSON for the REST API
    Jason.encode!(%{records: Enum.map(payloads, &%{body: Base.encode64(&1)})})
  end
end
```

### Subscription Fan-Out

Elixir's built-in concurrency makes fan-out natural. `Task.async_stream` replaces `Promise.allSettled` batching.

```elixir
defmodule DurableStreams.Subscriptions.Fanout do
  @batch_size 50
  @timeout_ms 10_000

  def fanout(project_id, stream_id, payload, content_type, subscriber_ids) do
    subscriber_ids
    |> Stream.chunk_every(@batch_size)
    |> Enum.reduce(%{successes: 0, failures: 0, stale: []}, fn batch, acc ->
      results =
        batch
        |> Task.async_stream(
          fn session_id ->
            DurableStreams.S2Client.append(
              project_id,
              session_stream_id(session_id),
              payload,
              content_type,
              nil
            )
          end,
          max_concurrency: @batch_size,
          timeout: @timeout_ms,
          on_timeout: :kill_task
        )
        |> Enum.zip(batch)
        |> Enum.reduce(acc, fn
          {{:ok, {:ok, _offset}}, _sid}, acc ->
            %{acc | successes: acc.successes + 1}

          {{:ok, {:error, {404, _}}}, sid}, acc ->
            %{acc | stale: [sid | acc.stale]}

          {_, _sid}, acc ->
            %{acc | failures: acc.failures + 1}
        end)

      results
    end)
  end

  defp session_stream_id(session_id), do: "session:#{session_id}"
end
```

### Real-Time Delivery

Phoenix Channels and SSE provide the equivalent of the internal WebSocket bridge + SSE delivery.

```elixir
defmodule DurableStreamsWeb.StreamChannel do
  use Phoenix.Channel

  def join("stream:" <> stream_key, _params, socket) do
    [project_id, stream_id] = String.split(stream_key, "/", parts: 2)

    # Subscribe this channel process to stream broadcasts
    DurableStreams.Streams.StreamServer.subscribe(project_id, stream_id, self())

    {:ok, assign(socket, project_id: project_id, stream_id: stream_id)}
  end

  # Receives broadcast from StreamServer when new data is appended
  def handle_info({:stream_data, _stream_id, payload, next_offset}, socket) do
    push(socket, "data", %{
      payload: Base.encode64(payload),
      next_offset: next_offset
    })
    {:noreply, socket}
  end
end
```

For SSE (Server-Sent Events) without WebSocket:

```elixir
defmodule DurableStreamsWeb.StreamController do
  use DurableStreamsWeb, :controller

  def show(conn, %{"project_id" => project, "stream_id" => stream} = params) do
    case params["live"] do
      "sse" -> stream_sse(conn, project, stream, params["offset"] || "0")
      "long-poll" -> long_poll(conn, project, stream, params["offset"] || "0")
      _ -> catch_up_read(conn, project, stream, params["offset"] || "0")
    end
  end

  defp stream_sse(conn, project, stream, offset) do
    conn =
      conn
      |> put_resp_header("content-type", "text/event-stream")
      |> put_resp_header("cache-control", "no-cache")
      |> put_resp_header("connection", "keep-alive")
      |> send_chunked(200)

    # Subscribe to real-time updates
    DurableStreams.Streams.StreamServer.subscribe(project, stream, self())

    # Send catch-up data first, then listen for broadcasts
    stream_loop(conn, project, stream, offset)
  end

  defp stream_loop(conn, project, stream, offset) do
    receive do
      {:stream_data, ^stream, payload, next_offset} ->
        {:ok, conn} = chunk(conn, "data: #{Base.encode64(payload)}\n\n")
        stream_loop(conn, project, stream, next_offset)
    after
      30_000 ->
        {:ok, conn} = chunk(conn, ": keepalive\n\n")
        stream_loop(conn, project, stream, offset)
    end
  end
end
```

## Supervision Tree

```
DurableStreams.Application
├── DurableStreams.StreamRegistry          # Registry for stream GenServers
├── DurableStreams.StreamSupervisor        # DynamicSupervisor for StreamServer processes
├── DurableStreams.SubscriptionRegistry    # Registry for subscription GenServers
├── DurableStreams.SubscriptionSupervisor  # DynamicSupervisor for SubscriptionServer processes
├── DurableStreams.SessionRegistry         # Registry for session GenServers
├── DurableStreams.SessionSupervisor       # DynamicSupervisor for SessionServer processes
├── DurableStreams.Auth.Registry           # ETS table for project signing secrets
├── DurableStreams.Cleanup                 # Periodic session cleanup (GenServer + :timer)
├── DurableStreamsWeb.Endpoint             # Phoenix HTTP endpoint
└── DurableStreamsWeb.Telemetry            # Telemetry supervisor
```

Each `*Registry` is an Elixir `Registry` (built on ETS) that provides named process lookup. Each `*Supervisor` is a `DynamicSupervisor` that starts GenServer processes on demand.

Key OTP property: if a `StreamServer` crashes, the supervisor restarts it. On restart, `init/1` reloads metadata from S2. In-memory state (subscriber PIDs, long-poll queue) is rebuilt naturally as clients reconnect.

## Offset Encoding

The Cloudflare implementation uses `readSeq_byteOffset` encoding because segments rotate from SQLite to R2. With S2, there's no segment rotation — S2 handles tiering internally. Offsets map directly to S2 sequence numbers.

| Cloudflare | Elixir + S2 |
|-----------|-------------|
| `readSeq_byteOffset` (e.g., `0000000000000001_0000000000001234`) | S2 `seqNum` (e.g., `1234`) |

For backward-compatible clients, the Elixir implementation can emit offsets in the same fixed-width format with `readSeq` always set to `0`:

```elixir
def encode_offset(seq_num) do
  "#{String.pad_leading("0", 16, "0")}_#{String.pad_leading(Integer.to_string(seq_num), 16, "0")}"
end

def decode_offset(offset_str) do
  [_read_seq, byte_offset] = String.split(offset_str, "_")
  String.to_integer(byte_offset)
end
```

Or, since S2 is a different backend, use raw integer sequence numbers for a cleaner API.

## Producer Fencing

S2 has native support for ordered, stateful appends via `AppendSession`. However, the Durable Streams protocol defines its own producer fencing semantics (epoch/seq). Two approaches:

### Option A: Application-Level Fencing (Recommended)

Keep the producer fencing logic in the Elixir `StreamServer`, exactly as the Cloudflare implementation does. The GenServer validates `Producer-Id`, `Producer-Epoch`, `Producer-Seq` before forwarding the append to S2. Producer state is held in the GenServer's in-memory state and periodically checkpointed to a metadata stream in S2.

This preserves full protocol compatibility with existing clients.

### Option B: S2-Native Sessions

Map Durable Streams producers to S2 `AppendSession`s. S2 sessions provide ordering guarantees and pipelining. However, the S2 session model doesn't directly map to the epoch/seq fencing protocol, so a translation layer would still be needed.

**Recommendation**: Option A. It's simpler, fully compatible, and the GenServer already provides the serialization point.

## Kubernetes Deployment

### Pod Topology

```yaml
# s2-lite: single-node stream store backed by S3
apiVersion: apps/v1
kind: Deployment
metadata:
  name: s2-lite
spec:
  replicas: 1  # s2-lite is single-node
  selector:
    matchLabels:
      app: s2-lite
  template:
    metadata:
      labels:
        app: s2-lite
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
            - name: AWS_ENDPOINT_URL_S3
              valueFrom:
                secretKeyRef:
                  name: s2-config
                  key: aws-endpoint-url
          readinessProbe:
            httpGet:
              path: /health
              port: 80
            initialDelaySeconds: 5
          livenessProbe:
            httpGet:
              path: /health
              port: 80
            initialDelaySeconds: 10
          resources:
            requests:
              memory: "256Mi"
              cpu: "250m"
            limits:
              memory: "1Gi"
              cpu: "1000m"
---
apiVersion: v1
kind: Service
metadata:
  name: s2-lite
spec:
  selector:
    app: s2-lite
  ports:
    - port: 80
      targetPort: 80
```

```yaml
# Elixir app: Durable Streams API server
apiVersion: apps/v1
kind: Deployment
metadata:
  name: durable-streams
spec:
  replicas: 2  # Horizontally scalable
  selector:
    matchLabels:
      app: durable-streams
  template:
    metadata:
      labels:
        app: durable-streams
    spec:
      containers:
        - name: app
          image: your-registry/durable-streams:latest
          ports:
            - containerPort: 4000
          env:
            - name: S2_ENDPOINT
              value: "http://s2-lite:80"
            - name: SECRET_KEY_BASE
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: secret-key-base
            - name: PHX_HOST
              value: "streams.example.com"
          readinessProbe:
            httpGet:
              path: /health
              port: 4000
          resources:
            requests:
              memory: "256Mi"
              cpu: "250m"
            limits:
              memory: "512Mi"
              cpu: "500m"
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
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"  # SSE connections
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
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

### Scaling Considerations

**s2-lite is single-node.** This is the main constraint. For production workloads needing horizontal scaling of the storage layer, options include:

1. **Managed S2** ([s2.dev](https://s2.dev)): The hosted service provides unlimited streams with no single-node bottleneck. Point the Elixir app at the managed endpoint instead of s2-lite.

2. **Multiple s2-lite instances**: Shard basins across multiple s2-lite pods. The Elixir app routes based on project ID hash. Each instance backs to the same or different S3 buckets.

3. **Distributed Erlang**: Run multiple Elixir nodes with `libcluster` for node discovery. Use consistent hashing (`:pg` or `Horde`) to assign stream GenServers to specific nodes, avoiding duplicate processes.

```
                   ┌─────────────┐
    Client ──────>│  Ingress /   │
                   │  Load Balancer│
                   └──────┬──────┘
                          │
              ┌───────────┼───────────┐
              v           v           v
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ Elixir-1 │ │ Elixir-2 │ │ Elixir-3 │   (distributed Erlang cluster)
        │ Streams  │ │ Streams  │ │ Streams  │
        │ A-F      │ │ G-M      │ │ N-Z      │   (consistent hash ring)
        └────┬─────┘ └────┬─────┘ └────┬─────┘
             │            │            │
             └────────────┼────────────┘
                          v
                   ┌──────────────┐
                   │   s2-lite    │──────> S3
                   └──────────────┘
```

## API Route Mapping

All routes preserve the same URL structure and semantics as the Cloudflare implementation.

### Core Streaming

| Method | Path | Handler |
|--------|------|---------|
| `PUT` | `/v1/stream/:project/:stream` | `StreamController.create/2` |
| `POST` | `/v1/stream/:project/:stream` | `StreamController.append/2` |
| `GET` | `/v1/stream/:project/:stream` | `StreamController.show/2` |
| `HEAD` | `/v1/stream/:project/:stream` | `StreamController.head/2` |
| `DELETE` | `/v1/stream/:project/:stream` | `StreamController.delete/2` |

### Subscriptions

| Method | Path | Handler |
|--------|------|---------|
| `POST` | `/v1/:project/subscribe` | `SubscribeController.subscribe/2` |
| `DELETE` | `/v1/:project/unsubscribe` | `SubscribeController.unsubscribe/2` |
| `POST` | `/v1/:project/publish/:stream` | `PublishController.publish/2` |
| `GET` | `/v1/:project/session/:session` | `SessionController.show/2` |
| `POST` | `/v1/:project/session/:session/touch` | `SessionController.touch/2` |
| `DELETE` | `/v1/:project/session/:session` | `SessionController.delete/2` |

### Response Headers

All protocol headers are preserved:

| Header | Behavior |
|--------|----------|
| `Stream-Next-Offset` | S2 sequence number (or formatted offset) |
| `Stream-Up-To-Date` | `true` when reader has caught up to tail |
| `Stream-Closed` | `true` when stream is closed |
| `Stream-Cursor` | Rotated cursor value for cache-busting |
| `Cache-Control` | Set by Elixir app; honored by upstream cache |

## Caching Strategy

Without Cloudflare's CDN, caching must be handled by an external layer. Options:

### Option A: Nginx/Varnish Reverse Proxy (Simplest)

```
Client → Nginx (cache) → Elixir App → S2
```

Nginx respects `Cache-Control` headers from the Elixir app. The cursor rotation mechanism (Chapter 6) works identically — each long-poll response includes a different `Stream-Cursor` that becomes part of the next request URL, naturally producing a new cache key.

### Option B: Cloudflare (or other CDN) in Front of K8s

```
Client → Cloudflare CDN → K8s Ingress → Elixir App → S2
```

Same CDN HIT = $0 benefit as the Cloudflare-native implementation. The Elixir app sets the same `Cache-Control` headers.

### Option C: No Cache (Simplest Start)

For low-traffic deployments, skip caching entirely. The Elixir app handles all requests directly. Add caching later when load requires it.

**Recommendation**: Start with Option C, add Option A (Nginx) when needed, graduate to Option B for high-scale.

## Cost Comparison

Assuming 10K concurrent readers, 1 write/second, 30 days:

| Component | Cloudflare | Elixir + S2 (self-hosted) |
|-----------|-----------|--------------------------|
| Compute | $8 (Worker requests at 99% CDN HIT) | ~$50-150/mo (2-3 K8s nodes) |
| Storage (hot) | $5.20 (SQLite rows) | Included in S3 costs |
| Storage (cold) | ~$0.50 (R2) | ~$0.50-2 (S3) |
| Auth registry | $32.50 (KV reads) | $0 (in-memory ETS) |
| CDN | $6 (VPS proxy) | $0-6 (optional) |
| Monitoring | $0 (Analytics Engine) | $0 (Prometheus/Grafana on K8s) |
| **Total** | **~$52/mo** | **~$50-160/mo** |

**Key tradeoff**: Cloudflare is cheaper at the low end because you only pay per-request. Kubernetes has a fixed baseline cost for the nodes, but doesn't scale up with request volume (until you need more nodes). At high scale (100K+ readers), the Kubernetes approach can be more cost-effective because there's no per-request billing.

**Operational cost**: Kubernetes requires team expertise. Cloudflare Workers is operationally simpler but less flexible.

## Dependencies (mix.exs)

```elixir
defp deps do
  [
    # Web framework
    {:phoenix, "~> 1.7"},
    {:phoenix_live_view, "~> 1.0"},    # Optional, for admin dashboard
    {:plug_cowboy, "~> 2.7"},

    # HTTP client for S2
    {:req, "~> 0.5"},
    {:finch, "~> 0.19"},

    # Auth
    {:jose, "~> 1.11"},               # JWT signing/verification

    # Observability
    {:telemetry, "~> 1.3"},
    {:telemetry_metrics, "~> 1.0"},
    {:telemetry_poller, "~> 1.1"},
    {:prom_ex, "~> 1.9"},             # Prometheus metrics

    # Distributed Erlang (optional, for multi-node)
    {:libcluster, "~> 3.4"},
    {:horde, "~> 0.9"},               # Distributed registry/supervisor

    # JSON
    {:jason, "~> 1.4"},

    # Testing
    {:mox, "~> 1.1", only: :test},
    {:ex_machina, "~> 2.8", only: :test}
  ]
end
```

## Migration Path

For teams currently using the Cloudflare implementation:

1. **Phase 1: Deploy s2-lite + Elixir alongside Cloudflare**
   - Run the Elixir app as a read replica, consuming from the same source streams.
   - Verify protocol compatibility with existing clients.

2. **Phase 2: Dual-write**
   - Publishers write to both Cloudflare and Elixir backends.
   - Compare results for consistency.

3. **Phase 3: Cutover**
   - Point clients at the Elixir endpoint.
   - Keep Cloudflare as a fallback for one release cycle.

4. **Phase 4: Decommission**
   - Remove the Cloudflare Workers deployment.

## Key Advantages of Elixir + S2

1. **OTP supervision**: Automatic process restart with state recovery from S2. No equivalent in Workers runtime.
2. **BEAM concurrency**: Millions of lightweight processes — one per stream, one per subscriber, one per SSE connection. No isolate overhead.
3. **Built-in distribution**: Distributed Erlang / `pg` groups for multi-node scaling. No external coordination service needed.
4. **Backpressure**: `GenStage` / `Broadway` provide native backpressure for fan-out. More robust than `Promise.allSettled` batching.
5. **Observability**: `:telemetry` + Prometheus + Grafana. Full access to process state via `:observer` or LiveDashboard.
6. **No vendor lock-in**: S2-lite is open source. The Elixir app runs on any Kubernetes cluster. Object storage is pluggable (S3, Tigris, MinIO).
7. **Hot code upgrades**: BEAM supports hot code reloading — deploy without dropping connections.

## Key Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| s2-lite is single-node | Use managed S2 for production, or shard across multiple instances |
| No CDN-native integration | Use Cloudflare/Nginx in front of K8s; cursor rotation still works |
| GenServer bottleneck per stream | BEAM handles millions of processes; S2's streamer task is also per-stream |
| State loss on GenServer crash | State is reconstructed from S2 on restart; only in-flight requests are lost |
| Network hop to S2 (vs in-DO SQLite) | S2-lite runs in the same K8s cluster; latency is <1ms for in-cluster calls |
| No WebSocket Hibernation billing trick | Not needed — BEAM processes use ~2KB idle; no per-process duration billing |

## Open Questions

1. **S2 record format vs Durable Streams format**: S2 records have headers (key-value pairs) and a body. Should we map Durable Streams' content-type + body to S2's native record format, or store the raw bytes as the S2 body?

2. **Stream metadata storage**: The Cloudflare implementation stores metadata (content-type, closed state, TTL) in a `stream_meta` SQLite table inside each DO. With S2, options include: a dedicated "meta" stream per project, a sidecar PostgreSQL/Redis, or S2 stream-level configuration (if supported).

3. **Producer state durability**: The GenServer holds producer state in memory. On crash, this state is lost. Should producer state be checkpointed to a metadata stream in S2, or reconstructed by scanning the stream's recent records?

4. **Multi-node stream affinity**: With distributed Erlang, how should stream GenServers be assigned to nodes? Consistent hashing via `Horde` is the likely answer, but needs evaluation for rebalancing behavior during node joins/leaves.
