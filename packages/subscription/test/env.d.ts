// oxlint-disable-next-line typescript-eslint/triple-slash-reference
/// <reference path="../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />

type _AppEnv = import("../src/env").AppEnv;

declare namespace Cloudflare {
  interface Env extends _AppEnv {}
}
