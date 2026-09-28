package main

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	// Pure-Go Postgres driver, registered against database/sql. It talks to
	// both stores, so the split is configuration rather than code.
	_ "github.com/lib/pq"
)

// Two stores, split by write volume rather than by table.
//
//	Neon   - critical, infrequent. Accounts, users, sessions (the MTProto auth
//	         keys), withdrawals, alerts, price baselines. Deleting the whole
//	         Railway project must be recoverable from here.
//	Railway Postgres - high volume. The message and audit logs, written on every
//	         single interaction.
//
// The reason is not tidiness. Neon scales to zero when idle, so a hot write
// path would keep waking it and paying compute for the privilege, and the
// round trip is over the internet. The message log is the bulk of writes and
// is the cheapest thing to lose: it is a transcript, and the accounts it
// describes are safe in Neon.
//
// If LOGS_DATABASE_URL is unset the log tables are created in the critical
// store instead, so a single-database setup still works.

// criticalSchema is the durable store. Everything here is hard to recreate.
const criticalSchema = `
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
-- signed in again by hand, so it belongs in the durable store.
CREATE TABLE IF NOT EXISTS sessions (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  blob       BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
  account_id   TEXT NOT NULL,
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
`

// Two tables that used to be here have been removed: price_baseline and
// job_availability.
//
// Neither was ever written. The price watcher persists to prices.json and
// availability.json on the data volume, so both tables sat empty while their
// names said otherwise. job_availability was worse than dead: the dashboard
// read it, always got nothing, and reported every job as UNAVAILABLE from a
// table that had never held a row.
//
// The watcher writes to the volume rather than the database on purpose. The
// price poll is every fifteen minutes and the availability state is one small
// file; putting them in Postgres would mean waking a store that scales to zero,
// several times an hour, to record two numbers. The file also survives a
// restart without a query, which is what "did we already announce this" needs.
//
// Existing databases keep the empty tables - the schema is CREATE IF NOT
// EXISTS, so removing the statement changes nothing for a deployment that
// already has them. They are simply never written and never read again.
const _ = 0

// hotSchema is the transcript. It grows on every interaction, so it is the
// thing worth keeping out of the store that suspends.
const hotSchema = `
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  user_id    BIGINT,
  leg        TEXT NOT NULL,
  text       TEXT NOT NULL DEFAULT '',
  buttons    JSONB NOT NULL DEFAULT '[]'::jsonb,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_at_idx ON messages (at DESC);
CREATE INDEX IF NOT EXISTS messages_account_idx ON messages (account_id, at DESC);

CREATE TABLE IF NOT EXISTS audit (
  id        BIGSERIAL PRIMARY KEY,
  leg       TEXT NOT NULL,
  kind      TEXT NOT NULL,
  user_id   BIGINT,
  text      TEXT NOT NULL DEFAULT '',
  meta      JSONB NOT NULL DEFAULT '{}'::jsonb,
  at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_at_idx ON audit (at DESC);
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

// storeNames are the labels used in status output.
const (
	// Labels name the role, never the vendor. This one used to say
	// "critical (Neon)" and reported Neon in production while the service was
	// pointed at Railway Postgres the whole time, so the command whose job is
	// to state what is configured was confidently wrong. The host is printed
	// from the DSN on the next line anyway.
	storeCritical = "critical"
	storeLogs     = "logs (high volume)"
)

// runMigrate applies both schemas. Every statement is CREATE ... IF NOT
// EXISTS, so repeating it is a no-op and safe to run on every deploy.
func runMigrate() error {
	criticalDSN := strings.TrimSpace(getenv("DATABASE_URL"))
	if criticalDSN == "" {
		return fmt.Errorf("DATABASE_URL is not set")
	}

	db, err := openDB(criticalDSN)
	if err != nil {
		return err
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	if _, err := db.ExecContext(ctx, criticalSchema); err != nil {
		return fmt.Errorf("apply critical schema: %w", err)
	}
	// CREATE TABLE IF NOT EXISTS never adds a column to a table that already
	// exists, so the owner column is applied separately. Both statements are
	// idempotent, so this runs on every boot without effect after the first.
	if err := ensureOwnerColumn(ctx, db); err != nil {
		fmt.Printf("note: %v; falling back to a single account bound by BOUND_USER_ID\n", err)
	}
	if err := ensureOwnerIndex(ctx, db); err != nil {
		fmt.Printf("note: accounts owner index: %v\n", err)
	}
	tables, err := verifySchema(ctx, db)
	if err != nil {
		return err
	}
	fmt.Printf("%s: %d table(s) - %s\n", storeCritical, len(tables), strings.Join(tables, ", "))

	// The log store is optional. Without it the log tables live alongside the
	// critical ones, which is fine at low volume.
	logsDSN := strings.TrimSpace(getenv("LOGS_DATABASE_URL"))
	if logsDSN == "" {
		fmt.Println("logs: LOGS_DATABASE_URL not set, writing logs to the critical store")
		if _, err := db.ExecContext(ctx, hotSchema); err != nil {
			return fmt.Errorf("apply log schema: %w", err)
		}
		return nil
	}

	logs, err := openDB(logsDSN)
	if err != nil {
		return fmt.Errorf("logs store: %w", err)
	}
	defer logs.Close()
	if _, err := logs.ExecContext(ctx, hotSchema); err != nil {
		return fmt.Errorf("apply log schema: %w", err)
	}
	lt, err := verifySchema(ctx, logs)
	if err != nil {
		return err
	}
	fmt.Printf("%s: %d table(s) - %s\n", storeLogs, len(lt), strings.Join(lt, ", "))
	return nil
}

// verifySchema lists the tables, so the status output proves what exists rather
// than assuming a migration ran.
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

// redactDSN strips the password so a connection string can be printed.
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

// reportStore opens a store and describes it, for the status output. It never
// returns an error: a store being unreachable is information, not a failure of
// the status command itself.
func reportStore(label, dsn string) {
	if dsn == "" {
		fmt.Printf("  %-22s : NOT SET\n", label)
		return
	}
	fmt.Printf("  %-22s : %s\n", label, redactDSN(dsn))
	db, err := openDB(dsn)
	if err != nil {
		fmt.Printf("  %-22s   unreachable: %v\n", "", err)
		return
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	tables, err := verifySchema(ctx, db)
	if err != nil {
		fmt.Printf("  %-22s   schema: %v\n", "", err)
		return
	}
	if len(tables) == 0 {
		fmt.Printf("  %-22s   EMPTY - run: go run ./Backend -migrate\n", "")
		return
	}
	fmt.Printf("  %-22s   %d table(s): %s\n", "", len(tables), strings.Join(tables, ", "))
}
