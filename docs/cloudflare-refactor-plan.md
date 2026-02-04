# Cloudflare Durable Streams POC Refactor Plan (Per-Stream DO + R2)

## Goals
- Preserve protocol compliance (conformance suite stays green).
- Use **per-stream Durable Objects** with SQLite for hot log + metadata.
- Use **R2 segments** for cold history and CDN-friendly catch-up reads.
- Support **CDN caching for long-poll (short TTL)** and cold reads (long TTL).
- Keep **D1 optional** for a global admin segment index only.

## Decisions (locked)
- Offsets are **`readSeq_byteOffset` only**. The server accepts `-1` and `now`
  as **sentinel inputs** but never emits them.
- No cross-segment stitching within a single GET.
- Segment rotation triggers on **message count or byte size**.

## Current State
- Storage interface is decoupled from D1.
- Per-stream DO SQLite schema added (stream_meta, ops, producers, segments).
- Segment rotation uses `read_seq` and writes immutable R2 segments.
- Admin D1 index (`segments_admin`) exists but is optional and async.

## Status (2026-02-04)
- Docs updated for per-stream DO + R2 architecture.
- Read path and segment rotation extracted into `src/do/*` modules.
- Conformance suite and implementation tests pass locally.
  - See `docs/cloudflare-poc-status.md` for the latest baseline.

## Remaining Work
- None planned. Keep docs/tests in sync as the protocol evolves.

## Acceptance Criteria
- Conformance suite passes.
- Implementation tests pass.
- No D1 dependency in the operational hot path.
- R2 segments are immutable and indexed by `read_seq`.
