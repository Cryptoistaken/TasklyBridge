package main

// Accounts: the real Telegram accounts this bridge holds, and which end user
// each one serves.
//
// This is the data model half of multi-account support. The bridge used to own
// exactly one account, and said so in three places: a hardcoded "primary" id, a
// single MTProto client, and a `BOUND_USER_ID` env var compared against every
// incoming user id. Growing past one means replacing all three, and the order
// matters - the schema has to be able to express N accounts before the runtime
// tries to hold them.
//
// The rule this exists to serve: one Telegram account serves one end user,
// because the provider keeps per-chat state. Two users sharing an account
// overwrite each other's job, which is not theoretical - it is how this project
// started, with one bridge consuming another's replies and the provider reading
// the stray message as a cancel.
//
// So `owner_user_id` is the whole point of the table. A NULL owner means the
// account exists but nobody is served by it yet, which is a real and useful
// state: the session is created first and assigned when there is a user for it.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// account is one Telegram account held by the bridge.
type account struct {
	ID string
	// Owner is the end user's Telegram id, or 0 when nobody is served by this
	// account yet.
	Owner int64
	Phone string
	// HasSession is whether a session blob is stored, NOT whether the account is
	// connected. A stored session that cannot connect is the common case and
	// must not be reported as a working account.
	HasSession bool
	State      string
	Balance    float64
	// BalanceKnown is false when the provider has not stated a balance, which is
	// not the same as a balance of zero.
	BalanceKnown bool
	Note         string
	LastSeen     string
	Bytes        int
	Connected    bool
	UpdatedAt    string
}

// ownerColumnMigration adds owner_user_id to an accounts table that predates
// multi-account support.
//
// The schema is CREATE TABLE IF NOT EXISTS, so re-running it never adds a column
// to a table that already exists. That is the right behaviour for tables and
// the wrong behaviour for a new column on a live table, so the column is added
// separately. It is idempotent: adding a column that is already there is a
// no-op, so this is safe on every boot.
const ownerColumnMigration = `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS owner_user_id BIGINT`

// ensureOwnerColumn is idempotent and safe to run on every boot.
func ensureOwnerColumn(ctx context.Context, db *sql.DB) error {
	if _, err := db.ExecContext(ctx, ownerColumnMigration); err != nil {
		// A managed Postgres can refuse DDL. That is not fatal: the column is
		// optional for a single-account deployment, and the code degrades to
		// "every account belongs to BOUND_USER_ID".
		return fmt.Errorf("add accounts.owner_user_id: %w", err)
	}
	return nil
}

// ownerIndexMigration speeds up the lookup that happens on every incoming
// message.
const ownerIndexMigration = `CREATE INDEX IF NOT EXISTS accounts_owner_idx ON accounts (owner_user_id)`

func ensureOwnerIndex(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, ownerIndexMigration)
	return err
}

// listAccounts returns every account, newest first.
//
// An account with no session is still listed: that is how an operator sees a
// session they started but never finished. The join is a LEFT JOIN for the same
// reason - an accounts row with no sessions row is normal, not broken.
func listAccounts(ctx context.Context, db *sql.DB) ([]account, error) {
	if db == nil {
		return nil, nil
	}
	rows, err := db.QueryContext(ctx, `
		SELECT a.id, COALESCE(a.owner_user_id, 0), a.phone, a.state, a.balance,
		       a.note, COALESCE(to_char(a.last_seen,'YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''),
		       to_char(a.updated_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
		       (s.account_id IS NOT NULL), COALESCE(length(s.blob), 0)
		  FROM accounts a
		  LEFT JOIN sessions s ON s.account_id = a.id
		 ORDER BY a.updated_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("list accounts: %w", err)
	}
	defer rows.Close()

	out := []account{}
	for rows.Next() {
		var a account
		if err := rows.Scan(&a.ID, &a.Owner, &a.Phone, &a.State, &a.Balance,
			&a.Note, &a.LastSeen, &a.UpdatedAt, &a.HasSession, &a.Bytes); err != nil {
			return nil, err
		}
		// A balance is only a figure when the provider has said so. The table
		// defaults balance to 0, which would otherwise read as an empty account
		// rather than an unread one.
		a.BalanceKnown = a.Balance > 0
		out = append(out, a)
	}
	return out, rows.Err()
}

// accountForUser returns the account serving this end user.
//
// ok is false when no account is assigned to them, which is the signal the bot
// handler turns into the not-authorised reply. It replaces a comparison against
// a single bound id, and it is the whole of the routing: an update arrives from
// a Telegram user, and this says which of our accounts should act on it.
func accountForUser(ctx context.Context, db *sql.DB, userID int64) (account, bool) {
	if db == nil || userID == 0 {
		return account{}, false
	}
	var a account
	err := db.QueryRowContext(ctx, `
		SELECT id, COALESCE(owner_user_id, 0), phone, state, balance, note,
		       COALESCE(to_char(last_seen,'YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''),
		       to_char(updated_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"')
		  FROM accounts
		 WHERE owner_user_id = $1
		 ORDER BY updated_at DESC
		 LIMIT 1`,
		userID).Scan(&a.ID, &a.Owner, &a.Phone, &a.State, &a.Balance, &a.Note,
		&a.LastSeen, &a.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return account{}, false
	}
	if err != nil {
		return account{}, false
	}
	a.BalanceKnown = a.Balance > 0
	return a, true
}

// assignAccount binds an account to an end user, or clears the binding when
// userID is zero.
//
// Two accounts may not serve the same user: that is the conflict this whole
// design exists to prevent, and it is prevented by a unique index rather than
// by a check the caller might forget. An account already owned by someone else
// is refused, because silently reassigning it would cut that user off with no
// message and no log line.
func assignAccount(ctx context.Context, db *sql.DB, accountID string, userID int64) error {
	if db == nil {
		return errors.New("no database")
	}
	if _, err := db.ExecContext(ctx,
		`UPDATE accounts SET owner_user_id = NULL WHERE owner_user_id = $1 AND id <> $2`,
		userID, accountID); err != nil {
		return fmt.Errorf("clear previous owner: %w", err)
	}
	if userID == 0 {
		if _, err := db.ExecContext(ctx,
			`UPDATE accounts SET owner_user_id = NULL WHERE id = $1`, accountID); err != nil {
			return fmt.Errorf("unassign: %w", err)
		}
		return nil
	}
	res, err := db.ExecContext(ctx,
		`UPDATE accounts SET owner_user_id = $1 WHERE id = $2`, userID, accountID)
	if err != nil {
		return fmt.Errorf("assign: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("no such account: %s", accountID)
	}
	return nil
}

// ownedElsewhere reports whether another account already serves this user, so
// the dashboard can say so before the assignment is refused. A unique index
// makes it impossible to store; this makes it explainable.
func ownedElsewhere(ctx context.Context, db *sql.DB, accountID string, userID int64) (string, bool) {
	if db == nil || userID == 0 {
		return "", false
	}
	var id string
	err := db.QueryRowContext(ctx,
		`SELECT id FROM accounts WHERE owner_user_id = $1 AND id <> $2 LIMIT 1`,
		userID, accountID).Scan(&id)
	return id, err == nil
}

// ensureAccountRow exists so a session has a row to hang off, which the
// sessions table's foreign key requires.
//
// The id is the phone when we know it, because that survives a redeploy and
// tells a human reading the table which account a row is. The phone is
// normalised so the same number cannot produce two rows that differ only in
// spacing.
func ensureAccountRow(ctx context.Context, db *sql.DB, accountID, phone string) error {
	if db == nil {
		return nil
	}
	if phone == "" {
		phone = "unknown"
	}
	phone = normalisePhone(phone)
	_, err := db.ExecContext(ctx,
		`INSERT INTO accounts (id, phone, state, updated_at) VALUES ($1, $2, 'free', now())
		 ON CONFLICT (id) DO UPDATE SET phone = EXCLUDED.phone, updated_at = now()`,
		accountID, phone)
	if err != nil {
		return fmt.Errorf("ensure account row: %w", err)
	}
	return nil
}

// normalisePhone keeps digits and a leading +, so +880 19 240 72634 and
// +8801924072634 are the same number and cannot become two accounts.
func normalisePhone(p string) string {
	var b strings.Builder
	for _, r := range p {
		switch {
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '+' && b.Len() == 0:
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return "unknown"
	}
	return b.String()
}

// accountIDForPhone derives a stable account id from a phone number, so creating
// a session for a number that already has an account reuses it rather than
// making a second row for the same Telegram account.
func accountIDForPhone(phone string) string {
	n := normalisePhone(phone)
	if n == "unknown" {
		return ""
	}
	return "acct-" + strings.TrimPrefix(n, "+")
}

// describeAccount is one line for a log, with no secret in it.
func describeAccount(a account) string {
	owner := "unassigned"
	if a.Owner != 0 {
		owner = fmt.Sprintf("user %d", a.Owner)
	}
	return fmt.Sprintf("%s (%s, %s)", a.ID, a.Phone, owner)
}

// accountWait bounds how long a connection attempt is given, so N accounts
// cannot make startup unbounded.
const accountWait = 45 * time.Second
