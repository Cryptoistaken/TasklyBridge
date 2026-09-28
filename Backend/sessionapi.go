package main

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

// Adding a Telegram session from the website, and surviving without one.
//
// The service used to crash-loop when no session was stored. That was the worst
// possible behaviour: the dashboard went down at exactly the moment an operator
// needed it to add the missing session. Now a missing session is a logged
// state, the process stays up, and the session can be uploaded over HTTP.

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

// handleUploadSession accepts a session blob and stores it.
//
// The blob may arrive as base64 (the shape a browser file input produces) or
// as raw bytes. It is written straight through without being logged, printed,
// or echoed back: whoever holds it can connect as the account.
func (s *adminServer) handleUploadSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST only"})
		return
	}
	if s.db == nil {
		writeJSON(w, http.StatusServiceUnavailable,
			map[string]any{"error": "no critical store, so a session cannot be stored"})
		return
	}

	body, err := readLimited(r, 4<<20)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "could not read the upload"})
		return
	}
	blob := decodeMaybeBase64(body)
	if len(blob) < 64 {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": "that does not look like a Telegram session file",
		})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	if err := storeSessionBytes(ctx, s.db, sessionAccountID(), blob); err != nil {
		s.audit.log(legInternal, "session-upload", 0, "rejected: "+err.Error(),
			map[string]string{"bytes": fmt.Sprint(len(blob))})
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "could not store the session"})
		return
	}

	s.audit.log(legInternal, "session-upload", 0,
		"session stored from the dashboard", map[string]string{
			"bytes": fmt.Sprint(len(blob)),
		})
	requestReconnect()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "bytes": len(blob),
		"note": "stored; the service is reconnecting",
	})
}

// decodeMaybeBase64 accepts either raw bytes or a base64 string, because the
// difference is invisible in a JSON body and a wrong guess should not lose an
// operator's session.
func decodeMaybeBase64(body []byte) []byte {
	trimmed := strings.TrimSpace(string(body))
	if len(trimmed) < 64 {
		return body
	}
	// Only try base64 when the payload looks like it: base64 is alphanumeric
	// with a few symbols, and never has a NUL or a raw byte above 127.
	candidate := trimmed
	if i := strings.IndexAny(candidate, "{ \""); i > 0 {
		candidate = candidate[:i] // a JSON wrapper
	}
	if strings.ContainsAny(candidate, "{}\"\n\r\t") {
		return body
	}
	if raw, err := base64.StdEncoding.DecodeString(candidate); err == nil {
		return raw
	}
	return body
}

func readLimited(r *http.Request, max int64) ([]byte, error) {
	defer r.Body.Close()
	buf := make([]byte, 0, 8192)
	tmp := make([]byte, 32*1024)
	var total int64
	for {
		n, err := r.Body.Read(tmp)
		if n > 0 {
			total += int64(n)
			if total > max {
				return nil, fmt.Errorf("upload too large")
			}
			buf = append(buf, tmp[:n]...)
		}
		if err != nil {
			if err.Error() == "EOF" {
				return buf, nil
			}
			if n == 0 {
				return buf, nil
			}
		}
		if n == 0 {
			return buf, nil
		}
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

// osFileExists keeps the status output honest about the file fallback.
func osFileExists(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.Size() > 0
}
