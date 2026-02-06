import { createStreamWorker } from "./create_worker";
import { bearerTokenAuth, jwtStreamAuth } from "./auth";
import { StreamDO } from "./durable_object";

export default createStreamWorker({
  authorizeMutation: bearerTokenAuth(),
  authorizeRead: jwtStreamAuth(),
});

export { StreamDO, createStreamWorker, bearerTokenAuth, jwtStreamAuth };
export type { StreamIntrospection } from "./durable_object";
export type {
  AuthResult,
  ReadAuthResult,
  AuthorizeMutation,
  AuthorizeRead,
} from "./auth";
export type { BaseEnv, StreamWorkerConfig } from "./create_worker";
