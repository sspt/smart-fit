PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS fit_account_schema(namespace TEXT PRIMARY KEY,version INTEGER NOT NULL);
INSERT OR IGNORE INTO fit_account_schema(namespace,version) VALUES('kwest.fit.accounts',1);
CREATE TABLE IF NOT EXISTS fit_users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS fit_credentials(email TEXT PRIMARY KEY,user_id TEXT NOT NULL UNIQUE REFERENCES fit_users(id) ON DELETE CASCADE,salt TEXT NOT NULL,password_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fit_identities(provider TEXT NOT NULL,subject TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES fit_users(id) ON DELETE CASCADE,PRIMARY KEY(provider,subject),UNIQUE(user_id,provider));
CREATE TABLE IF NOT EXISTS fit_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES fit_users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS fit_sessions_user ON fit_sessions(user_id);
CREATE TABLE IF NOT EXISTS fit_oauth_transactions(state_hash TEXT PRIMARY KEY,browser_hash TEXT NOT NULL,provider TEXT NOT NULL,verifier TEXT NOT NULL,link_user_id TEXT REFERENCES fit_users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS fit_auth_limits(bucket TEXT PRIMARY KEY,attempts INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS fit_records(user_id TEXT NOT NULL REFERENCES fit_users(id) ON DELETE CASCADE,record_key TEXT NOT NULL,revision INTEGER NOT NULL,payload BLOB,deleted INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,record_key));
CREATE INDEX IF NOT EXISTS fit_sessions_expiry ON fit_sessions(expires_at);
CREATE INDEX IF NOT EXISTS fit_oauth_expiry ON fit_oauth_transactions(expires_at);

CREATE INDEX IF NOT EXISTS fit_auth_limits_expiry ON fit_auth_limits(expires_at);
