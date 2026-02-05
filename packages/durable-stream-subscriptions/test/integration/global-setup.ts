import { startTestStack } from "./worker-harness";

export default async function () {
  // Allow using existing running workers for debugging
  if (process.env.INTEGRATION_TEST_CORE_URL && process.env.INTEGRATION_TEST_SUBSCRIPTIONS_URL) {
    return undefined;
  }

  console.log("Starting test stack...");
  const stack = await startTestStack();

  process.env.INTEGRATION_TEST_CORE_URL = stack.core.baseUrl;
  process.env.INTEGRATION_TEST_SUBSCRIPTIONS_URL = stack.subscriptions.baseUrl;

  console.log(`Core worker running at: ${stack.core.baseUrl}`);
  console.log(`Subscriptions worker running at: ${stack.subscriptions.baseUrl}`);

  return async () => {
    console.log("Stopping test stack...");
    await stack.stop();
  };
}
