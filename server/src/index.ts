// Worker entry point. Only handlers may be exported from here: the Workers runtime treats every
// named export of the main module as an entrypoint. Everything else lives in ./app.
import { app, housekeeping } from "./app";
import type { Env } from "./env";

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(housekeeping(env));
  },
} satisfies ExportedHandler<Env>;
