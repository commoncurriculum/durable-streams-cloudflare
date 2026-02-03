# Cloudflare Durable Streams POC Refactor Plan (Per-Stream DO + R2)

## Goals
- Preserve protocol compliance (conformance suite stays green).
- Use **per-stream Durable Objects** with SQLite for hot log + metadata.
- Use **R2 segments** for cold history and CDN-friendly catch-up reads.
- Support **CDN caching for long-poll (short TTL)** and cold reads (long TTL).
- Keep **D1 optional** for a global admin segment index only.

## Decisions (locked)
- Offsets are **`readSeq_byteOffset` only** (no legacy `-1`/`now`).
- No cross-segment stitching within a single GET.
- Segment rotation triggers on **message count or byte size**.

## Current State
- Storage interface is decoupled from D1.
- Per-stream DO SQLite schema added (stream_meta, ops, producers, segments).
- Segment rotation uses `read_seq` and writes immutable R2 segments.
- Admin D1 index (`segments_admin`) exists but is optional and async.

## Remaining Work
- Ensure all docs reflect the new per-stream DO + R2 architecture.
- Confirm tests cover segment boundary reads (multi-request).
- Validate cache headers for long-poll shared-cache mode.
- Run conformance + implementation tests.

## Acceptance Criteria
- Conformance suite passes.
- Implementation tests pass.
- No D1 dependency in the operational hot path.
- R2 segments are immutable and indexed by `read_seq`.
