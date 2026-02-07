import { startWorker } from "../implementation/worker_harness";

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (process.env.CONFORMANCE_TEST_URL) {
    return async () => {};
  }

  const handle = await startWorker();
  process.env.CONFORMANCE_TEST_URL = handle.baseUrl;

  return async () => {
    await handle.stop();
  };
}
