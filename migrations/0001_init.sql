CREATE TABLE instances (
  instance_id TEXT PRIMARY KEY,
  github_user_id INTEGER NOT NULL,
  public_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE INDEX instances_by_user ON instances (github_user_id);

CREATE TABLE instance_installations (
  instance_id TEXT NOT NULL REFERENCES instances (instance_id) ON DELETE CASCADE,
  installation_id INTEGER NOT NULL,
  PRIMARY KEY (instance_id, installation_id)
);

CREATE INDEX instance_installations_by_installation ON instance_installations (installation_id);

CREATE TABLE nonces (
  scope TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (scope, nonce)
);

CREATE INDEX nonces_by_expiry ON nonces (expires_at);

CREATE TABLE rate_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);

CREATE INDEX rate_limits_by_expiry ON rate_limits (expires_at);
