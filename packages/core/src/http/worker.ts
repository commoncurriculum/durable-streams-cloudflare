import { createStreamWorker } from "./create_worker";
import { bearerTokenAuth, jwtSessionAuth } from "./auth";
import { StreamDO } from "./durable_object";

export default createStreamWorker({
  authorizeMutation: bearerTokenAuth(),
  authorizeRead: jwtSessionAuth(),
});

export { StreamDO, createStreamWorker, bearerTokenAuth, jwtSessionAuth };
export type {
  AuthResult,
  ReadAuthResult,
  AuthorizeMutation,
  AuthorizeRead,
} from "./auth";
export type { BaseEnv, StreamWorkerConfig } from "./create_worker";
