import { createStreamWorker } from "../../src/http/create_worker";
import { StreamDO } from "../../src/http/durable_object";

// Auth-free worker for tests: no auth callbacks = no auth checks.
export default createStreamWorker();
export { StreamDO };
