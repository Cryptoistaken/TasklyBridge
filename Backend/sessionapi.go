package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
)

// Surviving without a Telegram session.
//
// The service used to crash-loop when none was stored. That was the worst
// possible behaviour: the dashboard went down at exactly the moment an operator
// needed it to add the missing session. Now a missing session is a logged
// state, the process stays up, and a session is created from the dashboard.

// errReconnect tells the connection wrapper to tear down and reconnect, which
// is how a session uploaded while the service was idle gets picked up.
var errReconnect = errors.New("reconnect requested")

// reconnectSignal wakes the idle-without-session path.
var reconnectSignal = make(chan struct{}, 1)

// errSessionMissing is returned by the authorization check when the account has
// never been signed in.
var errSessionMissing = errors.New("no telegram session stored")

// requestReconnect asks the connection loop to try again. Non-blocking, so a
// burst of uploads cannot wedge it.
func requestReconnect() {
	select {
	case reconnectSignal <- struct{}{}:
	default:
	}
}

// storeSessionBytes writes a session blob, creating the parent account row
// first because the foreign key is what stops an orphan session.
func storeSessionBytes(ctx context.Context, db *sql.DB, accountID string, blob []byte) error {
	if _, err := db.ExecContext(ctx,
		`INSERT INTO accounts (id, phone, state) VALUES ($1, $2, 'connected')
		 ON CONFLICT (id) DO NOTHING`, accountID, accountPhone()); err != nil {
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

// sessionStatus reports whether a session is stored, without revealing it.
func (s *adminServer) sessionStatus(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{"stored": false}
	if s.db != nil {
		if has, size, err := HasSession(r.Context(), s.db, sessionAccountID()); err == nil {
			out["stored"] = has
			out["bytes"] = size
		}
	}
	out["connected"] = s.tgt != nil && s.tgt.api != nil
	writeJSON(w, http.StatusOK, out)
}
