import { createStreamWorker } from "./create_worker";
import { projectKeyMutationAuth, projectKeyReadAuth } from "./auth";
import { StreamDO } from "./durable_object";

export default createStreamWorker({
  authorizeMutation: projectKeyMutationAuth(),
  authorizeRead: projectKeyReadAuth(),
});

export { StreamDO, createStreamWorker };
export {
  bearerTokenAuth,
  jwtStreamAuth,
  projectKeyMutationAuth,
  projectKeyReadAuth,
} from "./auth";
export type { StreamIntrospection } from "./durable_object";
export type {
  AuthResult,
  ReadAuthResult,
  AuthorizeMutation,
  AuthorizeRead,
  ProjectKeyEnv,
} from "./auth";
export type { BaseEnv, StreamWorkerConfig } from "./create_worker";
