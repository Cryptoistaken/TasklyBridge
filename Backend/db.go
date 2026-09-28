package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strings"
	"time"

	// Pure-Go Postgres driver, registered against database/sql.
	_ "github.com/lib/pq"
)

// The durable store: accounts, users, sessions, messages, alerts, withdrawals
// and the price baseline. Neon holds it, so deleting the whole Railway project
// must be recoverable from here.
//
// The MTProto session blob lives in `sessions` rather than on a container disk
// on purpose: the container filesystem is wiped on every deploy, and losing a
// session means logging that account in again by hand.

const schemaSQL = `
CREATE TABLE IF NOT EXISTS accounts (
  id              TEXT PRIMARY KEY,
  phone           TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'free',
  balance         NUMERIC(12,4) NOT NULL DEFAULT 0,
  flood_wait_secs INTEGER NOT NULL DEFAULT 0,
  messages_sent   INTEGER NOT NULL DEFAULT 0,
  last_seen       TIMESTAMPTZ,
  note            TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id         BIGINT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  username   TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'waiting',
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  task_name  TEXT NOT NULL DEFAULT '',
  messages   INTEGER NOT NULL DEFAULT 0,
  joined_at  TIMESTAMPTZ,
  last_seen  TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The MTProto auth keys. This IS the account: lose it and the account must be
-- signed in again, so it belongs in durable storage rather than a container.
CREATE TABLE IF NOT EXISTS sessions (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  blob       BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id    BIGINT,
  leg        TEXT NOT NULL,
  text       TEXT NOT NULL DEFAULT '',
  buttons    JSONB NOT NULL DEFAULT '[]'::jsonb,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_at_idx ON messages (at DESC);
CREATE INDEX IF NOT EXISTS messages_account_idx ON messages (account_id, at DESC);

CREATE TABLE IF NOT EXISTS alerts (
  id      TEXT PRIMARY KEY,
  level   TEXT NOT NULL,
  kind    TEXT NOT NULL,
  job     TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  read    BOOLEAN NOT NULL DEFAULT false,
  at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alerts_at_idx ON alerts (at DESC);

CREATE TABLE IF NOT EXISTS withdrawals (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  wallet       TEXT NOT NULL,
  amount       NUMERIC(12,4) NOT NULL,
  fee          NUMERIC(12,4) NOT NULL DEFAULT 0,
  net          NUMERIC(12,4) NOT NULL DEFAULT 0,
  dry_run      BOOLEAN NOT NULL DEFAULT true,
  status       TEXT NOT NULL DEFAULT 'created',
  confirmation TEXT NOT NULL DEFAULT '',
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS withdrawals_at_idx ON withdrawals (at DESC);

-- Last known price per provider job, so a restart does not treat every current
-- price as a change.
CREATE TABLE IF NOT EXISTS price_baseline (
  job        TEXT PRIMARY KEY,
  price      NUMERIC(12,4) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_availability (
  job        TEXT PRIMARY KEY,
  available  BOOLEAN NOT NULL DEFAULT false,
  cost       NUMERIC(12,4) NOT NULL DEFAULT 0,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
`

// openDB connects with a short timeout, so a bad URL fails fast at startup
// rather than hanging the first request that needs it.
func openDB(dsn string) (*sql.DB, error) {
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	// Neon is serverless: connections are cheap to open and expensive to keep,
	// so cap the pool rather than holding idle sessions.
	db.SetMaxOpenConns(5)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(5 * time.Minute)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("database unreachable: %w", err)
	}
	return db, nil
}

// migrate applies the schema. Every statement is CREATE ... IF NOT EXISTS, so
// running it against an existing database is a no-op and safe to repeat.
func migrate(ctx context.Context, db *sql.DB) error {
	if _, err := db.ExecContext(ctx, schemaSQL); err != nil {
		return fmt.Errorf("apply schema: %w", err)
	}
	return nil
}

// verifySchema lists the tables, so the CLI can prove what exists rather than
// assuming the migration ran.
func verifySchema(ctx context.Context, db *sql.DB) ([]string, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT table_name FROM information_schema.tables
		 WHERE table_schema = 'public' ORDER BY table_name`)
	if err != nil {
		return nil, fmt.Errorf("list tables: %w", err)
	}
	defer rows.Close()

	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

// runMigrate is the -migrate entry point.
func runMigrate() error {
	dsn := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if dsn == "" {
		return fmt.Errorf("DATABASE_URL is not set")
	}
	// Never let a password reach a log or a crash message.
	redactDSN(dsn)

	db, err := openDB(dsn)
	if err != nil {
		return err
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	if err := migrate(ctx, db); err != nil {
		return err
	}
	tables, err := verifySchema(ctx, db)
	if err != nil {
		return err
	}
	fmt.Printf("migrated. %d table(s):\n", len(tables))
	for _, t := range tables {
		fmt.Printf("  %s\n", t)
	}
	return nil
}

// redactDSN strips the password so a connection string can be logged.
func redactDSN(dsn string) string {
	if i := strings.Index(dsn, "@"); i > 0 {
		if j := strings.Index(dsn, "://"); j >= 0 && j+3 < i {
			creds := dsn[j+3 : i]
			if k := strings.Index(creds, ":"); k >= 0 {
				return dsn[:j+3] + creds[:k] + ":***@" + dsn[i+1:]
			}
		}
	}
	return dsn
}
