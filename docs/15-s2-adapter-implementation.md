# Chapter 15: S2 Adapter — Implementation Reference

Option 4 from Chapter 14: a Phoenix app that serves both SSE and long-poll at scale via CDN collapsing + in-process SSE fan-out.

## Architecture

```
                    ┌─── CDN ──────────────────────────────────┐
                    │                                          │
LP clients ────────>│  GET /v1/stream/proj/s?offset=42&cursor= │──┐
                    │  HIT → cached DS response                │  │ MISS only
                    └──────────────────────────────────────────┘  │
                                                                  │
                    ┌─────────────────────────────────────────────┘
                    │
                    ▼
              ┌──────────────────────────────────────────────┐
              │         Phoenix Adapter (K8s pods)            │
              │                                              │
              │  ┌────────────────────────────────────────┐  │
              │  │         StreamHub (GenServer)           │  │
              │  │                                        │  │
              │  │  stream "proj/s":                      │  │
              │  │    ├─ 1 S2 ReadSession (Task)          │  │
SSE clients ──┼──┼──> ├─ N SSE client pids               │  │
              │  │    └─ ring buffer (last 100 records)   │  │
              │  │                                        │  │
              │  │  stream "proj/t":                      │  │
              │  │    ├─ 1 S2 ReadSession (Task)          │  │
              │  │    ├─ M SSE client pids                │  │
              │  │    └─ ring buffer                      │  │
              │  └────────────────────────────────────────┘  │
              │                                              │
              │  POST /v1/stream/proj/s ──> S2 Append        │
              │  GET  (long-poll, MISS) ──> S2 Read(wait=30) │
              │  GET  (catch-up)        ──> S2 Read          │
              │  HEAD                   ──> S2 CheckTail     │
              └──────────────┬───────────────────────────────┘
                             │
                             ▼
                            S2
```

## File Tree

```
durable_streams_s2/
├── mix.exs
├── config/
│   ├── config.exs
│   ├── dev.exs
│   ├── prod.exs
│   └── runtime.exs
├── lib/
│   ├── durable_streams_s2/
│   │   ├── application.ex          # Supervision tree
│   │   ├── s2_client.ex            # S2 HTTP client (Req)
│   │   ├── stream_hub.ex           # Per-stream SSE fan-out registry
│   │   ├── stream_session.ex       # Single S2 ReadSession consumer per stream
│   │   ├── protocol.ex             # DS ↔ S2 offset/header translation
│   │   └── auth.ex                 # JWT verification
│   └── durable_streams_s2_web/
│       ├── endpoint.ex             # Phoenix endpoint (Cowboy config)
│       ├── router.ex               # Route definitions
│       └── controllers/
│           ├── stream_controller.ex  # PUT/POST/DELETE/HEAD + GET catch-up + long-poll
│           └── sse_controller.ex     # GET ?live=sse (chunked streaming)
├── test/
│   ├── s2_client_test.exs
│   ├── stream_hub_test.exs
│   ├── protocol_test.exs
│   └── controllers/
│       ├── stream_controller_test.exs
│       └── sse_controller_test.exs
├── Dockerfile
└── k8s/
    ├── deployment.yaml
    └── service.yaml
```

## Supervision Tree

```
Application
├── Phoenix.Endpoint (Cowboy HTTP)
├── Registry (StreamHub.Registry — named process lookup by stream key)
├── DynamicSupervisor (StreamHub.Supervisor — per-stream GenServers)
└── Finch (HTTP connection pool for S2 API)
```

```elixir
# lib/durable_streams_s2/application.ex

defmodule DurableStreamsS2.Application do
  use Application

  def start(_type, _args) do
    children = [
      {Finch, name: DurableStreamsS2.Finch, pools: %{
        Application.get_env(:durable_streams_s2, :s2_endpoint) => [size: 50, count: 4]
      }},
      {Registry, keys: :unique, name: DurableStreamsS2.StreamHub.Registry},
      {DynamicSupervisor, name: DurableStreamsS2.StreamHub.Supervisor, strategy: :one_for_one},
      DurableStreamsS2Web.Endpoint
    ]

    Supervisor.start_link(children, strategy: :one_for_one)
  end
end
```

## S2 HTTP Client

```elixir
# lib/durable_streams_s2/s2_client.ex

defmodule DurableStreamsS2.S2Client do
  @moduledoc "Thin wrapper around S2's HTTP API."

  def append(basin, stream, body, opts \\ []) do
    match_seq_num = Keyword.get(opts, :match_seq_num)
    fencing_token = Keyword.get(opts, :fencing_token)

    headers = [
      {"authorization", "Bearer #{token()}"},
      {"content-type", "application/octet-stream"}
    ]
    |> maybe_add("s2-match-seq-num", match_seq_num)
    |> maybe_add("s2-fencing-token", fencing_token)

    Finch.build(:post, "#{endpoint()}/v1/streams/#{basin}/#{stream}/records", headers, body)
    |> Finch.request(DurableStreamsS2.Finch)
    |> handle_response()
  end

  def read(basin, stream, opts \\ []) do
    params = %{}
    |> maybe_put("start_seq_num", Keyword.get(opts, :start_seq_num))
    |> maybe_put("limit", Keyword.get(opts, :limit, 100))
    |> maybe_put("wait", Keyword.get(opts, :wait))
    |> URI.encode_query()

    Finch.build(:get, "#{endpoint()}/v1/streams/#{basin}/#{stream}/records?#{params}",
      [{"authorization", "Bearer #{token()}"}])
    |> Finch.request(DurableStreamsS2.Finch)
    |> handle_response()
  end

  def read_session_stream(basin, stream, start_seq_num) do
    url = "#{endpoint()}/v1/streams/#{basin}/#{stream}/records?start_seq_num=#{start_seq_num}"
    headers = [
      {"authorization", "Bearer #{token()}"},
      {"accept", "text/event-stream"}
    ]

    # Returns a stream of SSE events
    Finch.build(:get, url, headers)
    |> Finch.stream(DurableStreamsS2.Finch, nil, fn
      {:status, status}, acc -> {status, acc}
      {:headers, _headers}, acc -> acc
      {:data, data}, acc -> {data, acc}
    end)
  end

  def check_tail(basin, stream) do
    Finch.build(:get, "#{endpoint()}/v1/streams/#{basin}/#{stream}/records/tail",
      [{"authorization", "Bearer #{token()}"}])
    |> Finch.request(DurableStreamsS2.Finch)
    |> handle_response()
  end

  def create_stream(basin, stream, opts \\ []) do
    body = Jason.encode!(%{stream: stream} |> Map.merge(Map.new(opts)))

    Finch.build(:post, "#{endpoint()}/v1/basins/#{basin}/streams", [
      {"authorization", "Bearer #{token()}"},
      {"content-type", "application/json"}
    ], body)
    |> Finch.request(DurableStreamsS2.Finch)
    |> handle_response()
  end

  def delete_stream(basin, stream) do
    Finch.build(:delete, "#{endpoint()}/v1/streams/#{basin}/#{stream}", [
      {"authorization", "Bearer #{token()}"}
    ])
    |> Finch.request(DurableStreamsS2.Finch)
    |> handle_response()
  end

  defp handle_response({:ok, %Finch.Response{status: status, body: body}})
       when status in 200..299 do
    {:ok, Jason.decode!(body)}
  end

  defp handle_response({:ok, %Finch.Response{status: status, body: body}}) do
    {:error, status, body}
  end

  defp handle_response({:error, reason}), do: {:error, 502, inspect(reason)}

  defp endpoint, do: Application.get_env(:durable_streams_s2, :s2_endpoint)
  defp token, do: Application.get_env(:durable_streams_s2, :s2_token)

  defp maybe_add(headers, _key, nil), do: headers
  defp maybe_add(headers, key, val), do: [{key, to_string(val)} | headers]

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, val), do: Map.put(map, key, val)
end
```

## Protocol Translation (DS ↔ S2)

```elixir
# lib/durable_streams_s2/protocol.ex

defmodule DurableStreamsS2.Protocol do
  @moduledoc "Translates between Durable Streams HTTP protocol and S2 API."

  # DS offset format: "readSeq_byteOffset" (16 hex digits each)
  # S2 offset: plain integer seq_num
  # We use readSeq=0, byteOffset=seq_num for compatibility.

  def seq_num_to_offset(seq_num) when is_integer(seq_num) do
    hex = seq_num |> Integer.to_string(16) |> String.pad_leading(16, "0")
    "0000000000000000_#{hex}"
  end

  def offset_to_seq_num(offset) when is_binary(offset) do
    case String.split(offset, "_") do
      [_read_seq, byte_offset] -> String.to_integer(byte_offset, 16)
      _ -> String.to_integer(offset)  # plain integer fallback
    end
  end

  def build_cursor(seq_num, tail_seq_num) do
    # Deterministic, rotates when data changes. Same concept as Chapter 6.
    :crypto.hash(:sha256, "#{seq_num}:#{tail_seq_num}")
    |> Base.url_encode64(padding: false)
    |> binary_part(0, 16)
  end

  def ds_read_response(s2_records, tail_seq_num, opts \\ []) do
    last_seq = List.last(s2_records)["seq_num"] || Keyword.get(opts, :start_seq_num, 0)
    at_tail = last_seq >= tail_seq_num
    next_offset = if s2_records == [], do: Keyword.get(opts, :start_seq_num, 0), else: last_seq + 1

    %{
      body: Enum.map(s2_records, &decode_s2_record/1),
      headers: %{
        "stream-next-offset" => seq_num_to_offset(next_offset),
        "stream-up-to-date" => to_string(at_tail),
        "stream-cursor" => build_cursor(next_offset, tail_seq_num)
      }
    }
  end

  def cache_control_for(:catchup), do: "public, max-age=60, immutable"
  def cache_control_for(:long_poll), do: "public, max-age=20"
  def cache_control_for(:at_tail_empty), do: "no-store"
  def cache_control_for(:mutation), do: "no-store"

  def decode_s2_record(%{"seq_num" => seq, "body" => body_b64}) do
    %{
      "offset" => seq_num_to_offset(seq),
      "data" => Base.decode64!(body_b64)
    }
  end

  def decode_s2_record(%{"seq_num" => seq, "body" => body_b64, "headers" => hdrs}) do
    content_type = find_header(hdrs, "content-type") || "application/octet-stream"
    %{
      "offset" => seq_num_to_offset(seq),
      "data" => Base.decode64!(body_b64),
      "content_type" => content_type
    }
  end

  defp find_header(headers, key) do
    Enum.find_value(headers, fn
      [^key, val] -> val
      _ -> nil
    end)
  end
end
```

## SSE Fan-Out Hub (Per-Stream GenServer)

```elixir
# lib/durable_streams_s2/stream_hub.ex

defmodule DurableStreamsS2.StreamHub do
  @moduledoc """
  One GenServer per active stream. Manages:
  - 1 S2 ReadSession (via StreamSession Task)
  - N connected SSE client pids
  - Ring buffer of recent records for catch-up
  """
  use GenServer

  @buffer_size 100
  @idle_timeout_ms 60_000

  # --- Public API ---

  def subscribe(basin, stream, from_seq_num) do
    key = "#{basin}/#{stream}"
    pid = ensure_started(key, basin, stream, from_seq_num)
    GenServer.call(pid, {:subscribe, self(), from_seq_num})
  end

  def unsubscribe(basin, stream) do
    key = "#{basin}/#{stream}"
    case Registry.lookup(DurableStreamsS2.StreamHub.Registry, key) do
      [{pid, _}] -> GenServer.cast(pid, {:unsubscribe, self()})
      [] -> :ok
    end
  end

  # --- Callbacks ---

  defstruct [:basin, :stream, :session_pid, clients: MapSet.new(),
             buffer: :queue.new(), buffer_size: 0, tail_seq: 0]

  def start_link({key, basin, stream, from_seq_num}) do
    GenServer.start_link(__MODULE__, {basin, stream, from_seq_num},
      name: {:via, Registry, {DurableStreamsS2.StreamHub.Registry, key}})
  end

  @impl true
  def init({basin, stream, from_seq_num}) do
    session_pid = DurableStreamsS2.StreamSession.start(basin, stream, from_seq_num, self())
    {:ok, %__MODULE__{basin: basin, stream: stream, session_pid: session_pid},
     @idle_timeout_ms}
  end

  @impl true
  def handle_call({:subscribe, client_pid, from_seq_num}, _from, state) do
    Process.monitor(client_pid)
    catchup = buffer_from(state.buffer, from_seq_num)
    {:reply, {:ok, catchup}, %{state | clients: MapSet.put(state.clients, client_pid)},
     @idle_timeout_ms}
  end

  @impl true
  def handle_cast({:unsubscribe, client_pid}, state) do
    state = remove_client(state, client_pid)
    maybe_shutdown(state)
  end

  @impl true
  def handle_info({:s2_records, records, tail_seq}, state) do
    state = %{state | tail_seq: tail_seq}
    state = Enum.reduce(records, state, fn record, acc ->
      buffer_push(acc, record)
    end)

    # Broadcast to all SSE clients
    for client <- state.clients do
      send(client, {:sse_records, records})
    end

    {:noreply, state, @idle_timeout_ms}
  end

  def handle_info({:DOWN, _ref, :process, pid, _reason}, state) do
    state = remove_client(state, pid)
    maybe_shutdown(state)
  end

  def handle_info(:timeout, state) do
    if MapSet.size(state.clients) == 0 do
      {:stop, :normal, state}
    else
      {:noreply, state, @idle_timeout_ms}
    end
  end

  # --- Private ---

  defp ensure_started(key, basin, stream, from_seq_num) do
    case Registry.lookup(DurableStreamsS2.StreamHub.Registry, key) do
      [{pid, _}] -> pid
      [] ->
        case DynamicSupervisor.start_child(
          DurableStreamsS2.StreamHub.Supervisor,
          {__MODULE__, {key, basin, stream, from_seq_num}}
        ) do
          {:ok, pid} -> pid
          {:error, {:already_started, pid}} -> pid
        end
    end
  end

  defp remove_client(state, pid) do
    %{state | clients: MapSet.delete(state.clients, pid)}
  end

  defp maybe_shutdown(%{clients: clients} = state) do
    if MapSet.size(clients) == 0 do
      {:noreply, state, @idle_timeout_ms}  # Grace period before stopping
    else
      {:noreply, state, @idle_timeout_ms}
    end
  end

  defp buffer_push(state, record) do
    buffer = :queue.in(record, state.buffer)
    {buffer, size} = if state.buffer_size >= @buffer_size do
      {_, b} = :queue.out(buffer)
      {b, state.buffer_size}
    else
      {buffer, state.buffer_size + 1}
    end
    %{state | buffer: buffer, buffer_size: size}
  end

  defp buffer_from(buffer, from_seq_num) do
    :queue.to_list(buffer)
    |> Enum.filter(fn %{"seq_num" => seq} -> seq >= from_seq_num end)
  end
end
```

## S2 ReadSession Consumer (Task)

```elixir
# lib/durable_streams_s2/stream_session.ex

defmodule DurableStreamsS2.StreamSession do
  @moduledoc """
  Consumes a single S2 ReadSession (SSE) for a stream.
  Sends parsed records back to the StreamHub GenServer.
  """

  def start(basin, stream, from_seq_num, hub_pid) do
    Task.start_link(fn -> run(basin, stream, from_seq_num, hub_pid) end)
    |> elem(1)
  end

  defp run(basin, stream, from_seq_num, hub_pid) do
    url = "#{s2_endpoint()}/v1/streams/#{basin}/#{stream}/records?start_seq_num=#{from_seq_num}"
    headers = [
      {"authorization", "Bearer #{s2_token()}"},
      {"accept", "text/event-stream"}
    ]

    # Open streaming connection to S2
    Finch.build(:get, url, headers)
    |> Finch.stream(DurableStreamsS2.Finch, "", fn
      {:status, _status}, acc -> acc
      {:headers, _headers}, acc -> acc
      {:data, chunk}, acc ->
        # Accumulate SSE data, parse events
        {events, remainder} = parse_sse_events(acc <> chunk)
        for event <- events do
          handle_event(event, hub_pid)
        end
        remainder
    end)

    # S2 connection closed — restart after backoff
    Process.sleep(1_000)
    run(basin, stream, from_seq_num, hub_pid)
  end

  defp handle_event(%{type: "batch", data: data}, hub_pid) do
    case Jason.decode(data) do
      {:ok, %{"records" => records, "tail" => %{"seq_num" => tail}}} ->
        send(hub_pid, {:s2_records, records, tail})
      _ -> :ignore
    end
  end

  defp handle_event(%{type: "ping"}, _hub_pid), do: :ok
  defp handle_event(%{type: "error", data: data}, _hub_pid) do
    require Logger
    Logger.error("S2 ReadSession error: #{data}")
  end
  defp handle_event(_, _), do: :ok

  defp parse_sse_events(buffer) do
    # Split on double newline (SSE event boundary)
    parts = String.split(buffer, "\n\n")
    {complete, [remainder]} = Enum.split(parts, -1)

    events = Enum.map(complete, fn raw ->
      lines = String.split(raw, "\n")
      Enum.reduce(lines, %{type: nil, data: "", id: nil}, fn line, acc ->
        case line do
          "event: " <> type -> %{acc | type: type}
          "data: " <> data -> %{acc | data: acc.data <> data}
          "id: " <> id -> %{acc | id: id}
          _ -> acc
        end
      end)
    end)
    |> Enum.reject(fn e -> e.type == nil and e.data == "" end)

    {events, remainder}
  end

  defp s2_endpoint, do: Application.get_env(:durable_streams_s2, :s2_endpoint)
  defp s2_token, do: Application.get_env(:durable_streams_s2, :s2_token)
end
```

## Auth (JWT Verification)

```elixir
# lib/durable_streams_s2/auth.ex

defmodule DurableStreamsS2.Auth do
  @moduledoc "JWT verification for Durable Streams protocol."

  def verify_token(conn) do
    with ["Bearer " <> token] <- Plug.Conn.get_req_header(conn, "authorization"),
         {:ok, claims} <- decode_and_verify(token),
         :ok <- check_expiry(claims),
         :ok <- check_scope(claims, conn) do
      {:ok, claims}
    else
      _ -> {:error, :unauthorized}
    end
  end

  def require_auth(conn, _opts) do
    case verify_token(conn) do
      {:ok, claims} ->
        Plug.Conn.assign(conn, :claims, claims)
      {:error, :unauthorized} ->
        conn
        |> Plug.Conn.put_status(401)
        |> Phoenix.Controller.json(%{code: "UNAUTHORIZED", error: "Invalid or missing token"})
        |> Plug.Conn.halt()
    end
  end

  defp decode_and_verify(token) do
    secret = Application.get_env(:durable_streams_s2, :jwt_secret)
    case JOSE.JWT.verify_strict(%JOSE.JWK{kty: {:oct, secret}}, ["HS256"], token) do
      {true, %JOSE.JWT{fields: claims}, _} -> {:ok, claims}
      _ -> {:error, :invalid}
    end
  end

  defp check_expiry(%{"exp" => exp}) do
    if exp > System.system_time(:second), do: :ok, else: {:error, :expired}
  end
  defp check_expiry(_), do: {:error, :no_expiry}

  defp check_scope(%{"scope" => scope}, conn) do
    method = conn.method
    cond do
      method in ["GET", "HEAD"] and scope in ["read", "write", "manage"] -> :ok
      method == "POST" and scope in ["write", "manage"] -> :ok
      method in ["PUT", "DELETE"] and scope == "manage" -> :ok
      true -> {:error, :insufficient_scope}
    end
  end
  defp check_scope(_, _), do: {:error, :no_scope}
end
```

## Router

```elixir
# lib/durable_streams_s2_web/router.ex

defmodule DurableStreamsS2Web.Router do
  use Phoenix.Router

  pipeline :api do
    plug :accepts, ["json", "event-stream"]
    plug CORSPlug, origin: &DurableStreamsS2Web.cors_origins/0
    plug DurableStreamsS2.Auth, :require_auth
  end

  scope "/v1/stream/:basin/*stream_path", DurableStreamsS2Web do
    pipe_through :api

    put "/", StreamController, :create
    post "/", StreamController, :append
    get "/", StreamController, :read      # dispatches to catch-up, long-poll, or SSE
    head "/", StreamController, :head
    delete "/", StreamController, :destroy
  end
end
```

## Stream Controller (Create, Append, Read, Long-Poll, HEAD, Delete)

```elixir
# lib/durable_streams_s2_web/controllers/stream_controller.ex

defmodule DurableStreamsS2Web.StreamController do
  use Phoenix.Controller
  alias DurableStreamsS2.{S2Client, Protocol}

  # PUT /v1/stream/:basin/:stream — Create stream
  def create(conn, %{"basin" => basin, "stream_path" => path}) do
    stream = Enum.join(path, "/")
    case S2Client.create_stream(basin, stream) do
      {:ok, _} -> send_resp(conn, 201, "")
      {:error, 409, _} -> send_resp(conn, 409, "")
      {:error, status, body} -> send_resp(conn, status, body)
    end
  end

  # POST /v1/stream/:basin/:stream — Append
  def append(conn, %{"basin" => basin, "stream_path" => path}) do
    stream = Enum.join(path, "/")
    {:ok, body, conn} = Plug.Conn.read_body(conn)

    opts = []
    |> maybe_add_match_seq(conn)
    |> maybe_add_fencing(conn)

    case S2Client.append(basin, stream, body, opts) do
      {:ok, %{"end" => %{"seq_num" => next_seq}}} ->
        conn
        |> put_resp_header("stream-next-offset", Protocol.seq_num_to_offset(next_seq))
        |> put_resp_header("cache-control", Protocol.cache_control_for(:mutation))
        |> send_resp(204, "")

      {:error, status, body} ->
        send_resp(conn, status, body)
    end
  end

  # GET /v1/stream/:basin/:stream — Read (dispatches by ?live= param)
  def read(conn, %{"basin" => basin, "stream_path" => path} = params) do
    stream = Enum.join(path, "/")
    offset = params["offset"]
    start_seq = if offset, do: Protocol.offset_to_seq_num(offset), else: 0

    case params["live"] do
      "sse" ->
        DurableStreamsS2Web.SseController.stream_sse(conn, basin, stream, start_seq)

      "long-poll" ->
        long_poll(conn, basin, stream, start_seq)

      _ ->
        catchup_read(conn, basin, stream, start_seq)
    end
  end

  # HEAD /v1/stream/:basin/:stream
  def head(conn, %{"basin" => basin, "stream_path" => path}) do
    stream = Enum.join(path, "/")
    case S2Client.check_tail(basin, stream) do
      {:ok, %{"seq_num" => tail_seq}} ->
        conn
        |> put_resp_header("stream-next-offset", Protocol.seq_num_to_offset(tail_seq))
        |> send_resp(200, "")

      {:error, 404, _} -> send_resp(conn, 404, "")
      {:error, status, body} -> send_resp(conn, status, body)
    end
  end

  # DELETE /v1/stream/:basin/:stream
  def destroy(conn, %{"basin" => basin, "stream_path" => path}) do
    stream = Enum.join(path, "/")
    case S2Client.delete_stream(basin, stream) do
      {:ok, _} -> send_resp(conn, 204, "")
      {:error, 404, _} -> send_resp(conn, 404, "")
      {:error, status, body} -> send_resp(conn, status, body)
    end
  end

  # --- Private: Catch-up read ---

  defp catchup_read(conn, basin, stream, start_seq) do
    case S2Client.read(basin, stream, start_seq_num: start_seq, limit: 100) do
      {:ok, %{"records" => records, "tail" => %{"seq_num" => tail_seq}}} ->
        response = Protocol.ds_read_response(records, tail_seq, start_seq_num: start_seq)
        at_tail = records == [] or List.last(records)["seq_num"] >= tail_seq

        cache = if at_tail,
          do: Protocol.cache_control_for(:at_tail_empty),
          else: Protocol.cache_control_for(:catchup)

        conn
        |> put_resp_header("cache-control", cache)
        |> merge_ds_headers(response.headers)
        |> put_resp_content_type("application/json")
        |> send_resp(200, Jason.encode!(response.body))

      {:error, 404, _} -> send_resp(conn, 404, "")
      {:error, status, body} -> send_resp(conn, status, body)
    end
  end

  # --- Private: Long-poll ---

  defp long_poll(conn, basin, stream, start_seq) do
    wait = get_wait_seconds(conn)

    case S2Client.read(basin, stream, start_seq_num: start_seq, limit: 100, wait: wait) do
      {:ok, %{"records" => [], "tail" => %{"seq_num" => tail_seq}}} ->
        # Timeout — no new data
        conn
        |> put_resp_header("cache-control", Protocol.cache_control_for(:at_tail_empty))
        |> put_resp_header("stream-up-to-date", "true")
        |> put_resp_header("stream-next-offset", Protocol.seq_num_to_offset(start_seq))
        |> put_resp_header("stream-cursor", Protocol.build_cursor(start_seq, tail_seq))
        |> send_resp(204, "")

      {:ok, %{"records" => records, "tail" => %{"seq_num" => tail_seq}}} ->
        response = Protocol.ds_read_response(records, tail_seq, start_seq_num: start_seq)

        conn
        |> put_resp_header("cache-control", Protocol.cache_control_for(:long_poll))
        |> merge_ds_headers(response.headers)
        |> put_resp_content_type("application/json")
        |> send_resp(200, Jason.encode!(response.body))

      {:error, status, body} ->
        send_resp(conn, status, body)
    end
  end

  defp get_wait_seconds(conn) do
    case Plug.Conn.get_req_header(conn, "prefer") do
      ["wait=" <> seconds] -> min(String.to_integer(seconds), 60)
      _ -> 30
    end
  end

  defp merge_ds_headers(conn, headers) do
    Enum.reduce(headers, conn, fn {key, val}, c ->
      put_resp_header(c, key, val)
    end)
  end

  defp maybe_add_match_seq(opts, conn) do
    case Plug.Conn.get_req_header(conn, "producer-seq") do
      [seq] -> Keyword.put(opts, :match_seq_num, seq)
      _ -> opts
    end
  end

  defp maybe_add_fencing(opts, conn) do
    case Plug.Conn.get_req_header(conn, "producer-id") do
      [id] -> Keyword.put(opts, :fencing_token, id)
      _ -> opts
    end
  end
end
```

## SSE Controller (Chunked Streaming + Fan-Out)

```elixir
# lib/durable_streams_s2_web/controllers/sse_controller.ex

defmodule DurableStreamsS2Web.SseController do
  @moduledoc "Handles GET ?live=sse — joins the StreamHub fan-out and streams SSE to client."

  alias DurableStreamsS2.{StreamHub, Protocol}

  def stream_sse(conn, basin, stream, from_seq_num) do
    conn =
      conn
      |> Plug.Conn.put_resp_header("content-type", "text/event-stream")
      |> Plug.Conn.put_resp_header("cache-control", "no-store")
      |> Plug.Conn.put_resp_header("x-accel-buffering", "no")  # Disable nginx buffering
      |> Plug.Conn.send_chunked(200)

    # Subscribe to per-stream fan-out — returns catch-up records from buffer
    {:ok, catchup_records} = StreamHub.subscribe(basin, stream, from_seq_num)

    # Send catch-up records immediately
    conn = send_sse_records(conn, catchup_records)

    # Enter receive loop — blocks until client disconnects
    sse_loop(conn, basin, stream)
  end

  defp sse_loop(conn, basin, stream) do
    receive do
      {:sse_records, records} ->
        case send_sse_records(conn, records) do
          {:ok, conn} -> sse_loop(conn, basin, stream)
          {:error, _} ->
            StreamHub.unsubscribe(basin, stream)
            conn
        end
    after
      30_000 ->
        # Keepalive
        case Plug.Conn.chunk(conn, ": keepalive\n\n") do
          {:ok, conn} -> sse_loop(conn, basin, stream)
          {:error, _} ->
            StreamHub.unsubscribe(basin, stream)
            conn
        end
    end
  end

  defp send_sse_records(conn, records) do
    data =
      Enum.map_join(records, "", fn record ->
        seq = record["seq_num"]
        body = Base.decode64!(record["body"])
        "id: #{Protocol.seq_num_to_offset(seq)}\ndata: #{body}\n\n"
      end)

    case Plug.Conn.chunk(conn, data) do
      {:ok, conn} -> {:ok, conn}
      {:error, reason} -> {:error, reason}
    end
  end
end
```

## Configuration

```elixir
# config/runtime.exs

import Config

config :durable_streams_s2,
  s2_endpoint: System.get_env("S2_ENDPOINT", "http://localhost:4566"),
  s2_token: System.get_env("S2_TOKEN"),
  jwt_secret: System.get_env("JWT_SECRET")

config :durable_streams_s2, DurableStreamsS2Web.Endpoint,
  http: [port: String.to_integer(System.get_env("PORT", "4000"))],
  server: true

config :cors_plug,
  origin: System.get_env("CORS_ORIGINS", "*") |> String.split(",")
```

```elixir
# mix.exs

defmodule DurableStreamsS2.MixProject do
  use Mix.Project

  def project do
    [
      app: :durable_streams_s2,
      version: "0.1.0",
      elixir: "~> 1.17",
      start_permanent: Mix.env() == :prod,
      deps: deps()
    ]
  end

  def application do
    [
      extra_applications: [:logger],
      mod: {DurableStreamsS2.Application, []}
    ]
  end

  defp deps do
    [
      {:phoenix, "~> 1.7"},
      {:plug_cowboy, "~> 2.7"},
      {:finch, "~> 0.19"},
      {:jason, "~> 1.4"},
      {:jose, "~> 1.11"},
      {:cors_plug, "~> 3.0"}
    ]
  end
end
```

## Kubernetes Deployment

```yaml
# k8s/deployment.yaml

apiVersion: apps/v1
kind: Deployment
metadata:
  name: durable-streams-s2
spec:
  replicas: 3
  selector:
    matchLabels:
      app: durable-streams-s2
  template:
    metadata:
      labels:
        app: durable-streams-s2
    spec:
      containers:
        - name: adapter
          image: your-registry/durable-streams-s2:latest
          ports:
            - containerPort: 4000
          env:
            - name: S2_ENDPOINT
              value: "https://your-basin.b.s2.dev"  # or http://s2-lite:4566
            - name: S2_TOKEN
              valueFrom:
                secretKeyRef:
                  name: s2-credentials
                  key: token
            - name: JWT_SECRET
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: jwt-secret
            - name: PORT
              value: "4000"
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: "1"
              memory: 512Mi
          readinessProbe:
            httpGet:
              path: /health
              port: 4000
            initialDelaySeconds: 5
          livenessProbe:
            httpGet:
              path: /health
              port: 4000
            initialDelaySeconds: 10
```

```yaml
# k8s/service.yaml

apiVersion: v1
kind: Service
metadata:
  name: durable-streams-s2
spec:
  selector:
    app: durable-streams-s2
  ports:
    - port: 80
      targetPort: 4000
  type: ClusterIP
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: durable-streams-s2
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"    # SSE connections
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-buffering: "off"        # Don't buffer SSE
spec:
  rules:
    - host: streams.your-domain.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: durable-streams-s2
                port:
                  number: 80
```

## Dockerfile

```dockerfile
# Dockerfile

FROM hexpm/elixir:1.17.3-erlang-27.1.2-alpine-3.20.3 AS build
RUN apk add --no-cache build-base git
WORKDIR /app
ENV MIX_ENV=prod

COPY mix.exs mix.lock ./
RUN mix deps.get --only prod && mix deps.compile

COPY config config
COPY lib lib
RUN mix compile && mix release

FROM alpine:3.20.3 AS app
RUN apk add --no-cache libstdc++ openssl ncurses-libs
WORKDIR /app
COPY --from=build /app/_build/prod/rel/durable_streams_s2 ./
ENV PHX_SERVER=true
EXPOSE 4000
CMD ["bin/durable_streams_s2", "start"]
```

## Request Flow Summary

```
WRITE (POST /v1/stream/basin/stream):
  Client → CDN (pass-through) → Adapter → S2Client.append → S2
  ← 204 + Stream-Next-Offset

CATCH-UP READ (GET /v1/stream/basin/stream?offset=N):
  Client → CDN (MISS on first) → Adapter → S2Client.read → S2
  ← 200 + records + Cache-Control: public, max-age=60, immutable
  (subsequent: CDN HIT → cached response)

LONG-POLL (GET /v1/stream/basin/stream?offset=N&live=long-poll&cursor=X):
  Client → CDN (MISS, cache key includes cursor) → Adapter → S2Client.read(wait=30) → S2
  ← 200 + records + Cache-Control: public, max-age=20 + Stream-Cursor (rotated)
  (concurrent readers at same offset+cursor: CDN HIT → collapsed)

SSE (GET /v1/stream/basin/stream?live=sse&offset=N):
  Client → CDN (pass-through, streaming) → Adapter:
    1. StreamHub.subscribe(basin, stream, N)
       → If no GenServer for this stream: start one + open 1 S2 ReadSession
       → If already running: join existing, get catch-up from buffer
    2. Catch-up records sent immediately via chunked response
    3. sse_loop: receive {:sse_records, records} → chunk to client
    4. On disconnect: StreamHub.unsubscribe → remove from client set
    5. Last client leaves → GenServer idle timeout → close S2 session, stop

HEAD (HEAD /v1/stream/basin/stream):
  Client → CDN → Adapter → S2Client.check_tail → S2
  ← 200 + Stream-Next-Offset

DELETE (DELETE /v1/stream/basin/stream):
  Client → CDN (pass-through) → Adapter → S2Client.delete_stream → S2
  ← 204
```

## What's In Memory (Per Adapter Instance)

```
Per active stream (streams with ≥1 SSE client on THIS node):
  - 1 GenServer process (~1KB)
  - 1 Task process for S2 ReadSession (~1KB + HTTP connection)
  - MapSet of client PIDs (~40 bytes per client)
  - Ring buffer of last 100 records (~variable, depends on record size)

Per SSE client connection:
  - 1 Cowboy process (~2KB, managed by Phoenix)
  - Entry in GenServer's client MapSet

Example: 100 active streams, 10K SSE clients across 3 pods:
  Per pod: ~33 streams active, ~3,333 SSE connections
  Memory: ~33 GenServers + 33 S2 sessions + 3,333 Cowboy processes ≈ 20-50MB
```
