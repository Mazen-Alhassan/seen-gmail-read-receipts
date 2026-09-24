export interface Env {
  DB: D1Database;
  /** Code an extension must present to register. Unset = open registration. */
  INVITE_CODE?: string;
  /** Days to keep emails and their open history. "0" or unset = forever. */
  RETENTION_DAYS?: string;
}
