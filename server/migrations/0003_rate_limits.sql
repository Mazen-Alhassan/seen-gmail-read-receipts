-- Throttling for the one guessable secret on the server: the invite code.
CREATE TABLE rate_limits (
  key         TEXT PRIMARY KEY,        -- e.g. "register:203.0.113.9", or "register:*" for the total
  strikes     INTEGER NOT NULL,        -- consecutive failures; reset on success and after a quiet day
  retry_after INTEGER NOT NULL,        -- ms timestamp before which further attempts are refused
  updated_at  INTEGER NOT NULL
);
CREATE INDEX rate_limits_updated ON rate_limits (updated_at);
