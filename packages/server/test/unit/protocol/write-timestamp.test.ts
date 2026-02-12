import { describe, it, expect } from "vitest";
import {
  buildSseControlEvent,
  buildWsControlMessage,
  buildLongPollHeaders,
} from "../../../src/http/v1/streams/realtime/handlers";

describe("buildSseControlEvent with writeTimestamp", () => {
  it("includes streamWriteTimestamp when writeTimestamp > 0", () => {
    const { payload } = buildSseControlEvent({
      nextOffset: "abc123",
      upToDate: true,
      streamClosed: false,
      cursor: "c1",
      writeTimestamp: 1707312000000,
    });

    const dataLine = payload.split("\n").find((l) => l.startsWith("data:"));
    const json = JSON.parse(dataLine!.slice(5));
    expect(json.streamWriteTimestamp).toBe(1707312000000);
  });

  it("omits streamWriteTimestamp when writeTimestamp is 0", () => {
    const { payload } = buildSseControlEvent({
      nextOffset: "abc123",
      upToDate: true,
      streamClosed: false,
      cursor: "c1",
      writeTimestamp: 0,
    });

    const dataLine = payload.split("\n").find((l) => l.startsWith("data:"));
    const json = JSON.parse(dataLine!.slice(5));
    expect(json.streamWriteTimestamp).toBeUndefined();
  });
});

describe("buildWsControlMessage with writeTimestamp", () => {
  it("includes streamWriteTimestamp when writeTimestamp > 0", () => {
    const { message } = buildWsControlMessage({
      nextOffset: "abc123",
      upToDate: true,
      streamClosed: false,
      cursor: "c1",
      writeTimestamp: 1707312000000,
    });

    expect(message.streamWriteTimestamp).toBe(1707312000000);
  });

  it("omits streamWriteTimestamp when writeTimestamp is 0", () => {
    const { message } = buildWsControlMessage({
      nextOffset: "abc123",
      upToDate: true,
      streamClosed: false,
      cursor: "c1",
      writeTimestamp: 0,
    });

    expect(message.streamWriteTimestamp).toBeUndefined();
  });
});

describe("buildLongPollHeaders with writeTimestamp", () => {
  const meta = {
    stream_id: "test",
    content_type: "application/json",
    closed: 0,
    tail_offset: 100,
    read_seq: 0,
    segment_start: 0,
    segment_messages: 0,
    segment_bytes: 0,
    last_stream_seq: null,
    ttl_seconds: null,
    expires_at: null,
    created_at: Date.now(),
    closed_at: null,
    closed_by_producer_id: null,
    closed_by_epoch: null,
    closed_by_seq: null,
    public: 0,
  };

  it("sets Stream-Write-Timestamp header when writeTimestamp > 0", () => {
    const headers = buildLongPollHeaders({
      meta,
      nextOffsetHeader: "abc123",
      upToDate: true,
      closedAtTail: false,
      cursor: null,
      writeTimestamp: 1707312000000,
    });

    expect(headers.get("Stream-Write-Timestamp")).toBe("1707312000000");
  });

  it("omits Stream-Write-Timestamp header when writeTimestamp is 0", () => {
    const headers = buildLongPollHeaders({
      meta,
      nextOffsetHeader: "abc123",
      upToDate: true,
      closedAtTail: false,
      cursor: null,
      writeTimestamp: 0,
    });

    expect(headers.get("Stream-Write-Timestamp")).toBeNull();
  });
});
