declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("../src/index");
  }
  interface Env {
    DB: D1Database;
    INVITE_CODE?: string;
    RETENTION_DAYS: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
