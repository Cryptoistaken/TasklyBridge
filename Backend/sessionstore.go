package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"
)

// The Telegram session, held in the critical store.
//
// Why not a container file: the Railway filesystem is wiped on every deploy, so
// a session on disk means logging the account in again by hand each time. Worse,
// the app service has no volume at all, so the container has never had a session
// to lose. This is the reason the app was crash-looping.
//
// gotd's own note on the interface is the reason this is careful: whoever can
// read the blob can connect as the account, so the row is treated as a
// credential. It is never logged, never printed by -status, and is excluded
// from the CLI's plain output.

// neonSessionStore implements gotd's session.Storage against the `sessions`
// table. The account id is the primary key, so one account is one row.
//
// gotd calls LoadSession once at startup and StoreSession whenever the auth
// state changes. Both are on the connection's own goroutine, but a write and a
// read can still overlap across reconnects, so writes are serialised here.
type neonSessionStore struct {
	db        *sql.DB
	accountID string

	mu   sync.Mutex
	blob []byte
}

// LoadSession returns the stored session, or nil when the account has never
// been stored. A nil blob with a nil error is the correct "new session" signal
// to gotd, and must not be turned into an error.
func (s *neonSessionStore) LoadSession(ctx context.Context) ([]byte, error) {
	if s.db == nil {
		return nil, nil
	}
	var blob []byte
	err := s.db.QueryRowContext(ctx,
		`SELECT blob FROM sessions WHERE account_id = $1`, s.accountID).Scan(&blob)

	switch {
	case errors.Is(err, sql.ErrNoRows):
		return nil, nil
	case err != nil:
		return nil, fmt.Errorf("load session: %w", err)
	}
	s.mu.Lock()
	s.blob = blob
	s.mu.Unlock()
	return blob, nil
}

// StoreSession writes the session back. It must not fail the connection, so a
// database problem is reported to the log and the in-memory copy is still
// updated, because losing the write is recoverable and dropping the connection
// is not.
func (s *neonSessionStore) StoreSession(ctx context.Context, data []byte) error {
	s.mu.Lock()
	s.blob = data
	s.mu.Unlock()

	if s.db == nil || len(data) == 0 {
		return nil
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO sessions (account_id, blob, updated_at) VALUES ($1, $2, now())
		 ON CONFLICT (account_id) DO UPDATE SET blob = EXCLUDED.blob, updated_at = now()`,
		s.accountID, data)
	if err != nil {
		return fmt.Errorf("store session: %w", err)
	}
	return nil
}

// HasSession reports whether a session is stored, without loading the blob.
// This is what -status shows, so an operator can confirm the account is
// recoverable without the secret ever being read out.
func HasSession(ctx context.Context, db *sql.DB, accountID string) (bool, int, error) {
	if db == nil {
		return false, 0, errors.New("no database configured")
	}
	var n int
	var size sql.NullInt64
	err := db.QueryRowContext(ctx,
		`SELECT count(*), max(length(blob)) FROM sessions WHERE account_id = $1`,
		accountID).Scan(&n, &size)
	if err != nil {
		return false, 0, err
	}
	if n == 0 {
		return false, 0, nil
	}
	return true, int(size.Int64), nil
}

// storeSessionBlob writes a session from a file into the critical store, so a
// session authenticated locally can be moved to the service without a second
// login. The blob is read from disk and never printed.
func storeSessionBlob(ctx context.Context, db *sql.DB, accountID, path string) error {
	if db == nil {
		return errors.New("DATABASE_URL is not set")
	}
	blob, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	if len(blob) == 0 {
		return fmt.Errorf("%s is empty; sign in first with: go run ./Test -login", path)
	}

	// The session references an account, so the parent row has to exist. Doing
	// it here keeps the foreign key meaningful rather than dropping it.
	if _, err := db.ExecContext(ctx,
		`INSERT INTO accounts (id, phone, state) VALUES ($1, $2, 'connected')
		 ON CONFLICT (id) DO NOTHING`,
		accountID, accountPhone()); err != nil {
		return fmt.Errorf("ensure account row: %w", err)
	}

	if _, err := db.ExecContext(ctx,
		`INSERT INTO sessions (account_id, blob, updated_at) VALUES ($1, $2, now())
		 ON CONFLICT (account_id) DO UPDATE SET blob = EXCLUDED.blob, updated_at = now()`,
		accountID, blob); err != nil {
		return fmt.Errorf("store session: %w", err)
	}
	return nil
}

// accountPhone is recorded against the account row. It is optional, because
// the phone lives in the probe's env rather than the service's.
func accountPhone() string {
	if p := getenv("TG_PHONE"); p != "" {
		return p
	}
	return "unknown"
}

// openCriticalStore is the one place the critical database is opened, so the
// pool settings are consistent everywhere.
func openCriticalStore() (*sql.DB, error) {
	dsn := getenv("DATABASE_URL")
	if dsn == "" {
		return nil, errors.New("DATABASE_URL is not set")
	}
	db, err := openDB(dsn)
	if err != nil {
		return nil, err
	}
	// The session write happens on gotd's connection goroutine, so the pool
	// must never be exhausted by a slow dashboard request.
	db.SetMaxOpenConns(8)
	return db, nil
}

// sessionAccountID is the stable key for the one account this bridge owns.
// It is the phone number, because that survives a redeploy and identifies the
// account to a human reading the row.
func sessionAccountID() string {
	return "primary"
}

// waitForDB is used at startup so a cold Neon does not crash-loop the service.
func waitForDB(ctx context.Context, db *sql.DB, attempts int) error {
	var err error
	for i := 0; i < attempts; i++ {
		if err = db.PingContext(ctx); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	return fmt.Errorf("database unreachable after %d attempts: %w", attempts, err)
}
