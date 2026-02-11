import { startWorker } from "./worker_harness";

export default async function () {
  if (process.env.IMPLEMENTATION_TEST_URL) {
    return undefined;
  }

  const worker = await startWorker();
  process.env.IMPLEMENTATION_TEST_URL = worker.baseUrl;

  return async () => {
    await worker.stop();
  };
}
