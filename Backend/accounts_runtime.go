package main

// withTargets is the multi-account entry point: it starts the admin surface once
// and then supervises one MTProto client per stored account.
//
// The admin surface is started here rather than inside a client's connect
// callback, because with N accounts the old placement would open the database
// and the HTTP server N times - once per account - and whichever account
// reconnected last would win. That is also what made the single-account version
// fragile in a different way: a reconnect re-ran the whole setup.

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/gotd/td/session"
	"github.com/gotd/td/telegram"
)

// defaultAccountID is the account this bridge has always had, and the one a
// single-account deployment keeps using. It is deliberately unchanged so an
// existing session is not orphaned by the move to generated ids.
const defaultAccountID = "primary"

func withTargets(ctx context.Context, a *audit, admin *adminServer, cat *catalog, st *store, hookSecret string, fn func(*fleet) error) error {
	fl := newFleet()

	// The store is opened BEFORE the session manager is built, because the
	// manager is handed the handle. Built in the other order it received a nil
	// *sql.DB and GET /api/sessions dereferenced it and panicked on the first
	// call.
	var err error
	if admin.db, err = openCriticalStore(); err != nil {
		a.log(legInternal, "admin-db", 0, "no critical store: "+err.Error(), nil)
	} else {
		defer admin.db.Close()
	}
	// Opened once, before any account connects, for the same reason as the
	// store above.
	admin.sessions = newSessionManager(admin.db, a)
	admin.fleet = fl
	admin.webhookSecret = hookSecret
	go func() {
		if err := startAdmin(ctx, admin); err != nil {
			a.log(legInternal, "admin-stopped", 0, err.Error(), nil)
		}
	}()

	accounts := liveAccounts(ctx, admin.db, a)
	a.log(legInternal, "accounts", 0,
		fmt.Sprintf("%d account(s) to start: %s", len(accounts), strings.Join(accounts, ", ")),
		nil)

	var wg sync.WaitGroup
	for _, acct := range accounts {
		acct := acct
		owner := ownerForAccount(ctx, admin.db, acct)
		wg.Add(1)
		go func() {
			defer wg.Done()
			// One account failing is that account's problem. The others, and the
			// dashboard, must carry on: one unreachable phone number is not a
			// reason to stop serving everybody else.
			err := runAccount(ctx, a, admin, cat, hookSecret, acct, func(t *target) error {
				fl.set(acct, t, owner)
				// The dashboard keeps a pointer to the newest live account for
				// the pages that are not per-user.
				currentTarget = t
				admin.tgt = t
				return nil
			})
			fl.clear(acct)
			if err != nil && ctx.Err() == nil {
				a.log(legInternal, "account-down", 0,
					fmt.Sprintf("account %s stopped: %v", acct, err), nil)
			}
		}()
	}

	// fn drives the bot for as long as the process lives, so the supervisor
	// goroutines are only waited on once the bot has stopped.
	runErr := fn(fl)
	wg.Wait()
	return runErr
}

// liveAccounts lists the accounts worth connecting: those with a stored session,
// or with an owner assigned even though the session has not arrived yet.
func liveAccounts(ctx context.Context, db *sql.DB, a *audit) []string {
	all, err := listAccounts(ctx, db)
	if err != nil {
		a.log(legInternal, "accounts", 0, "could not list accounts: "+err.Error(), nil)
		// A database we cannot read still has to serve the account this bridge
		// has always had, or a transient read error takes the bot down.
		return []string{defaultAccountID}
	}
	out := make([]string, 0, len(all))
	for _, acct := range all {
		if acct.HasSession || acct.Owner != 0 {
			out = append(out, acct.ID)
		}
	}
	if len(out) == 0 {
		// No account at all, which is a fresh install. The default id is tried
		// so the "add a session" path works with nothing configured.
		out = append(out, defaultAccountID)
	}
	return out
}

// ownerForAccount reads who an account serves. Read once at startup, not per
// message.
func ownerForAccount(ctx context.Context, db *sql.DB, accountID string) int64 {
	if db == nil {
		return 0
	}
	var owner int64
	if err := db.QueryRowContext(ctx,
		`SELECT COALESCE(owner_user_id, 0) FROM accounts WHERE id = $1`, accountID).Scan(&owner); err != nil {
		return 0
	}
	return owner
}

// sessionStorageFor is sessionStorage bound to a named account.
//
// The store keys its row on the account id, so this one line is the whole
// difference between one account's session and another's. The default account
// reuses the existing path so a single-account deployment is untouched.
func sessionStorageFor(ctx context.Context, a *audit, accountID string) telegram.SessionStorage {
	if accountID == "" || accountID == defaultAccountID {
		return sessionStorage(ctx, a)
	}
	db, err := openCriticalStore()
	if err != nil {
		a.log(legInternal, "session-store", 0,
			"no critical store for "+accountID+", falling back to the session file: "+err.Error(), nil)
		return &session.FileStorage{Path: sessionPath}
	}
	// A cold database must not crash-loop the service.
	if err := waitForDB(ctx, db, 5); err != nil {
		a.log(legInternal, "session-store", 0, err.Error(), map[string]string{
			"fallback": "session file", "account": accountID,
		})
		_ = db.Close()
		return &session.FileStorage{Path: sessionPath}
	}
	return &neonSessionStore{db: db, accountID: accountID}
}

// fleetWatchTarget picks the account the price watch and the provider terms are
// read through.
//
// Deliberately ONE account, not all of them. The provider is the same bot for
// every account and quotes the same fee and minimum, so one connected account
// answers for all of them. Polling N accounts every fifteen minutes would
// multiply the automated messages this bridge sends - three per poll per
// account - and a high message rate on a Telegram account is the documented way
// to get it banned. The account is the product.
//
// nil is a real answer, not a failure: the watcher's first poll happens
// immediately, so it may run before any account has connected.
func fleetWatchTarget(fl *fleet) *target {
	if fl == nil {
		return nil
	}
	if t, ok := fl.any(boundUserID); ok {
		return t
	}
	return nil
}

// reconnectAfter bounds how long one account's supervisor waits before trying
// again when it drops out, so a dead account cannot spin.
const reconnectAfter = 10 * time.Second
