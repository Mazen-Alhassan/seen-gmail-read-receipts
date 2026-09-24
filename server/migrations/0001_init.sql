-- Seen: initial schema. All timestamps are milliseconds since the Unix epoch.

CREATE TABLE users (
  id          TEXT PRIMARY KEY,        -- 8 random bytes, base64url; embedded in every pixel token
  key_hash    TEXT NOT NULL UNIQUE,    -- hex SHA-256 of the API key (the key itself is never stored)
  mint_key    TEXT NOT NULL,           -- base64url HMAC key used to sign/verify pixel tokens
  created_at  INTEGER NOT NULL
);

-- One row per tracked email. Created by the extension right after the user hits Send.
CREATE TABLE messages (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender      TEXT NOT NULL DEFAULT '',
  subject     TEXT NOT NULL DEFAULT '',
  recipients  TEXT NOT NULL DEFAULT '[]',   -- JSON: [{ "name": "...", "email": "..." }]
  sent_at     INTEGER NOT NULL,
  thread_id   TEXT,                          -- Gmail thread id, once known
  message_id  TEXT,                          -- Gmail message id, once known
  sender_ip   TEXT,                          -- IP/UA of the extension that registered it, used to
  sender_ua   TEXT,                          -- recognise the sender's own browser loading the pixel
  gateway     TEXT,                          -- security gateway in front of the recipients (from MX)
  gateway_checked INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX messages_user_sent ON messages (user_id, sent_at DESC);
CREATE INDEX messages_user_thread ON messages (user_id, thread_id);
CREATE INDEX messages_user_message ON messages (user_id, message_id);

-- Raw pixel requests. Deliberately not interpreted on write: classification happens on read,
-- so late-arriving signals (e.g. "the sender was looking at this message") are always applied.
CREATE TABLE hits (
  id       INTEGER PRIMARY KEY,
  token    TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  ip       TEXT,
  ua       TEXT,
  asn      INTEGER,
  as_org   TEXT,
  country  TEXT,
  region   TEXT,
  city     TEXT
);
CREATE INDEX hits_token_ts ON hits (token, ts);
CREATE INDEX hits_user_ts ON hits (user_id, ts);

-- "The sender's own Gmail just rendered this pixel" beacons from the extension.
CREATE TABLE self_views (
  token  TEXT NOT NULL,
  ts     INTEGER NOT NULL
);
CREATE INDEX self_views_token_ts ON self_views (token, ts);
