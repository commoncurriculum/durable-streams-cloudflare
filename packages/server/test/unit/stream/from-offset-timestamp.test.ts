import { describe, it, expect } from "vitest";
import { readFromOffset } from "../../../src/storage/stream/read";
import {
  baseMeta,
  withStorage,
  seedStreamOffsets as seedStream,
  insertOp,
} from "../helpers";

describe("readFromOffset writeTimestamp tracking", () => {
  it("single chunk read returns its created_at as writeTimestamp", async () => {
    await withStorage("ts-test", async (storage) => {
      const meta = baseMeta({ tail_offset: 5 });
      await seedStream(storage, meta);
      await insertOp(storage, 0, "hello", 1707312000000);

      const result = await readFromOffset(
        storage,
        "test-stream",
        meta,
        0,
        1024
      );

      expect(result.hasData).toBe(true);
      expect(result.writeTimestamp).toBe(1707312000000);
    });
  });

  it("multi-chunk read returns the max created_at", async () => {
    await withStorage("ts-test", async (storage) => {
      const meta = baseMeta({ tail_offset: 11 });
      await seedStream(storage, meta);
      await insertOp(storage, 0, "hello", 1707312000000);
      await insertOp(storage, 5, " world", 1707312001000);

      const result = await readFromOffset(
        storage,
        "test-stream",
        meta,
        0,
        1024
      );

      expect(result.hasData).toBe(true);
      expect(result.writeTimestamp).toBe(1707312001000);
    });
  });

  it("empty read returns writeTimestamp 0", async () => {
    await withStorage("ts-test", async (storage) => {
      const meta = baseMeta({ tail_offset: 100 });
      await seedStream(storage, meta);

      const result = await readFromOffset(
        storage,
        "test-stream",
        meta,
        100,
        1024
      );

      expect(result.hasData).toBe(false);
      expect(result.writeTimestamp).toBe(0);
    });
  });

  it("overlap chunk contributes its created_at", async () => {
    await withStorage("ts-test", async (storage) => {
      const meta = baseMeta({ tail_offset: 11 });
      await seedStream(storage, meta);
      await insertOp(storage, 0, "hello world", 1707312005000);

      // Read from offset 5 (mid-chunk overlap)
      const result = await readFromOffset(
        storage,
        "test-stream",
        meta,
        5,
        1024
      );

      expect(result.hasData).toBe(true);
      expect(result.writeTimestamp).toBe(1707312005000);
    });
  });

  it("overlap chunk plus later chunks takes the max", async () => {
    await withStorage("ts-test", async (storage) => {
      const meta = baseMeta({ tail_offset: 11 });
      await seedStream(storage, meta);
      await insertOp(storage, 0, "hello", 1707312000000);
      await insertOp(storage, 5, " world", 1707312009000);

      // Overlap read starting at offset 3 (mid first chunk)
      const result = await readFromOffset(
        storage,
        "test-stream",
        meta,
        3,
        1024
      );

      expect(result.hasData).toBe(true);
      expect(result.writeTimestamp).toBe(1707312009000);
    });
  });
});
