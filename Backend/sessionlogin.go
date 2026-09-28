package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/tg"
)

// Creating a Telegram session from the dashboard: phone, then the code Telegram
// sends, then the 2FA password when the account has one.
//
// This replaces the raw upload, which was a poor fit: it required the operator
// to already have a session file on their machine, which is exactly what a new
// account does not have. Here the whole thing happens over the dashboard.
//
// Three rules hold throughout, and they are the reason this is written the way
// it is:
//
//  1. The login code and the 2FA password are never logged, never stored, and
//     never returned. They exist in memory for the length of one request and
//     are discarded.
//  2. A session blob is a live credential. It goes straight into the critical
//     store and is only ever reported by presence and size.
//  3. Every step is audited with the step name and the outcome, never the
//     secret.

// loginAttempt is one in-flight sign-in, held between HTTP requests.
type loginAttempt struct {
	id        string
	phone     string
	codeHash  string
	started   time.Time
	client    *telegram.Client
	storage   *captureStorage
	needsPass bool
	cancel    context.CancelFunc
	// account is which stored session this login will become. Carried on the
	// attempt rather than on the manager, because several logins can be in
	// flight for different accounts at once and they must not share a
	// destination.
	account string
}

// captureStorage holds the session blob in memory until the login completes,
// then hands it to the caller. Nothing is written anywhere until the account is
// genuinely authorised, so a half-finished attempt leaves no trace.
type captureStorage struct {
	mu   sync.Mutex
	blob []byte
}

func (c *captureStorage) LoadSession(context.Context) ([]byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	// A nil blob with a nil error is how gotd is told "new session".
	return c.blob, nil
}

func (c *captureStorage) StoreSession(_ context.Context, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.blob = data
	return nil
}

func (c *captureStorage) get() []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.blob
}

// sessionManager owns the in-flight logins.
type sessionManager struct {
	db    *sql.DB
	audit *audit

	// account is which stored session a login is for. It is set per request by
	// the create call, because the Sessions page chooses the account: creating a
	// session for an account that already has one would overwrite it, which is
	// what happened while there was only ever the default.
	mu       sync.Mutex
	attempts map[string]*loginAttempt
}

func newSessionManager(db *sql.DB, a *audit) *sessionManager {
	return &sessionManager{db: db, audit: a, attempts: map[string]*loginAttempt{}}
}

// attemptTTL is how long a half-finished login is kept. Telegram codes expire,
// so holding one open indefinitely is pointless and a store of phone numbers
// is not something to keep around.
const attemptTTL = 15 * time.Minute

// ---------------------------------------------------------------- the API --

func (s *adminServer) handleSessions(w http.ResponseWriter, r *http.Request) {
	if s.sessions == nil {
		writeJSON(w, http.StatusServiceUnavailable,
			map[string]any{"error": "no database, so sessions cannot be managed"})
		return
	}
	switch r.Method {
	case http.MethodGet:
		s.sessions.list(w, r)
	case http.MethodPost:
		s.sessions.create(w, r)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "GET or POST"})
	}
}

// list shows every stored session: the account, its size, when it changed, and
// its balance.
//
// The blob is never included, only its size. The balance is the last one read
// from the provider, so it is a fact with an expiry rather than a stored truth,
// and `balance_known` says which it is.
func (m *sessionManager) list(w http.ResponseWriter, r *http.Request) {
	// A nil handle must be a 503, never a panic. The HTTP server recovers a
	// panic per connection, so the process survives and the operator sees a
	// 502 with nothing in the log but a stack trace - which is exactly how the
	// wiring bug in withTarget presented itself: a page that had never worked
	// and no error anyone could act on.
	if m == nil || m.db == nil {
		writeJSON(w, http.StatusServiceUnavailable,
			map[string]any{"error": "no database, so sessions cannot be listed"})
		return
	}
	// Every account, not every stored session. An account whose sign-in was
	// started and abandoned has no session row, and it must still be listed -
	// that is how the operator sees a half-finished login. A JOIN would hide it,
	// which is the same class of bug as the Messages page: asking a table that
	// cannot hold the answer.
	list, err := listAccounts(r.Context(), m.db)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "could not read sessions"})
		return
	}

	items := []map[string]any{}
	var totalBalance float64
	known := len(list) > 0
	for _, a := range list {
		// A balance of exactly zero is ambiguous: it could be an account that
		// really is empty, or one nothing has ever read. Only a non-zero figure
		// is trustworthy, so the flag says so rather than guessing.
		balanceKnown := a.BalanceKnown
		if balanceKnown {
			totalBalance += a.Balance
		} else {
			known = false
		}
		inUse := a.HasSession && m.isConnected()
		if inUse {
			inUse = m.inUseAccount() == a.ID
		}
		items = append(items, map[string]any{
			"id": a.ID, "phone": a.Phone, "state": a.State, "bytes": a.Bytes,
			"updated_at":  a.UpdatedAt,
			"has_session": a.HasSession,
			"owner":       a.Owner,
			"in_use":      inUse,
			"balance":     a.Balance, "balance_known": balanceKnown,
		})
	}

	// The count and the total belong with the rows, so the page does not have
	// to recompute them and get the arithmetic subtly different.
	out := map[string]any{
		"items": items, "total": len(items),
		"total_balance": totalBalance, "balance_known": known,
	}
	writeJSON(w, http.StatusOK, out)
}

// isConnected reports whether the service is using a session right now, so the
// dashboard can warn before one is replaced.
func (m *sessionManager) isConnected() bool {
	// The running target is the authority; a stored row is not.
	return currentTarget != nil && currentTarget.api != nil
}

// inUseAccount is which account the running client belongs to. With several
// accounts live, "connected" is no longer one yes/no for the whole service, and
// a page that said a single account was in use when three were would be wrong
// about the other two.
func (m *sessionManager) inUseAccount() string {
	if currentTarget == nil || currentTarget.api == nil {
		return ""
	}
	return currentTarget.accountID
}

func (m *sessionManager) create(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Phone    string `json:"phone"`
		Code     string `json:"code"`
		Password string `json:"password"`
		Attempt  string `json:"attempt"`
		// Account names which stored session this sign-in is for. Optional and
		// defaulted, so a dashboard that has not been updated keeps working
		// against a new backend.
		Account string `json:"account"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid body"})
		return
	}
	accountID := normaliseAccountID(body.Account)
	if accountID == "" {
		accountID = defaultAccountID
	}

	// Each step is a separate call, and which step this is depends on what is
	// present. An attempt id comes back from the first call and is required
	// afterwards, so two admins cannot interleave into one login.
	switch {
	case body.Attempt == "":
		m.startLogin(w, body.Phone, accountID)
	case body.Code != "":
		m.submitCode(w, body.Attempt, body.Code)
	case body.Password != "":
		m.submitPassword(w, body.Attempt, body.Password)
	default:
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": "send a code or a password with the attempt id",
		})
	}
}

// normaliseAccountID makes an account id safe to use as a filename and a URL
// segment, because it arrives from a request body.
//
// The operator may send a phone number or a name, and the Sessions page offers
// both, so both are accepted. Only a leading + or an all-digit value counts as
// a phone number: treating "any string containing a dash" as one turned
// "backup-1" into a different account, and a name that reduced to nothing fell
// back to the default account and overwrote the session already stored there.
func normaliseAccountID(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	// A phone number derives its id; it is never used verbatim.
	if strings.HasPrefix(s, "+") || allDigits(s) {
		return accountIDForPhone(s)
	}
	// A name is lowercased and stripped to characters that are safe in a path.
	// The acct- prefix puts it in a different space from a derived phone id, so
	// a name can never collide with a number.
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		}
		if b.Len() >= 56 {
			break
		}
	}
	if b.Len() == 0 {
		return ""
	}
	return "acct-" + b.String()
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// startLogin sends Telegram's login code to a phone number.
// startLogin sends Telegram's login code to a phone number, for a named account.
//
// accountID travels with the attempt rather than being looked up at the end, so
// a login in flight cannot be redirected onto a different account by a second
// request while it waits for the code.
func (m *sessionManager) startLogin(w http.ResponseWriter, phone, accountID string) {
	phone = strings.TrimSpace(phone)
	if !strings.HasPrefix(phone, "+") || len(phone) < 8 {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"field": "phone", "error": "give the number in international form, e.g. +8801...",
		})
		return
	}
	if !rateLimit("session-create", m.auditKey(), 5, time.Hour) {
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"error": "too many sign-in attempts, wait before trying again",
		})
		return
	}
	if accountID == "" {
		accountID = defaultAccountID
	}
	// The account row is created up front, so a half-finished login leaves a
	// visible, obviously-empty account rather than nothing at all. That is what
	// the operator needs to see to know a sign-in was started and abandoned.
	if err := ensureAccountRow(context.Background(), m.db, accountID, phone); err != nil {
		m.audit.log(legInternal, "session-create", 0, "could not create the account: "+err.Error(),
			map[string]string{"phone": phone, "account": accountID})
		writeJSON(w, http.StatusInternalServerError,
			map[string]any{"error": "could not create the account"})
		return
	}

	att := &loginAttempt{
		id:      newAttemptID(),
		phone:   phone,
		account: accountID,
		started: time.Now(),
		storage: &captureStorage{},
	}
	ctx, cancel := context.WithCancel(context.Background())
	att.cancel = cancel

	client := telegram.NewClient(apiID, apiHash, telegram.Options{
		SessionStorage: att.storage,
		Device:         telegram.DeviceTDesktopWindows(),
	})
	att.client = client

	// The client must be running for requests to be sent through it, and it
	// stays running across the whole attempt.
	go func() { _ = client.Run(ctx, func(context.Context) error { select {} }) }()

	if err := waitAuthorized(ctx, client); err != nil {
		cancel()
		m.audit.log(legInternal, "session-create", 0, "could not connect: "+err.Error(),
			map[string]string{"step": "phone"})
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "could not reach Telegram"})
		return
	}

	sent, err := client.Auth().SendCode(ctx, phone, auth.SendCodeOptions{AllowAppHash: true})
	if err != nil {
		cancel()
		// The phone number is not a secret and is what makes the log useful.
		m.audit.log(legInternal, "session-create", 0, "code request failed: "+err.Error(),
			map[string]string{"step": "phone", "phone": phone})
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error": "Telegram would not send a code: " + err.Error(),
		})
		return
	}
	sc, ok := sent.(*tg.AuthSentCode)
	if !ok {
		cancel()
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "unexpected response from Telegram"})
		return
	}
	att.codeHash = sc.PhoneCodeHash

	m.put(att)
	m.audit.log(legInternal, "session-create", 0, "login code sent",
		map[string]string{"step": "phone", "phone": phone, "attempt": att.id})

	writeJSON(w, http.StatusOK, map[string]any{
		"attempt": att.id, "phone": phone, "step": "code",
		"note": "Telegram has sent a login code. Enter it here, or in the Telegram app.",
	})
}

// submitCode exchanges the login code for a session.
func (m *sessionManager) submitCode(w http.ResponseWriter, attemptID, code string) {
	att := m.take(attemptID)
	if att == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "that attempt has expired"})
		return
	}
	defer m.finish(att)

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	// The code is deliberately not logged and not stored.
	_, err := att.client.Auth().SignIn(ctx, att.phone, strings.TrimSpace(code), att.codeHash)
	if err != nil {
		if errors.Is(err, auth.ErrPasswordAuthNeeded) {
			att.needsPass = true
			m.put(att)
			m.audit.log(legInternal, "session-create", 0, "2FA required",
				map[string]string{"step": "code", "phone": att.phone})
			writeJSON(w, http.StatusOK, map[string]any{
				"attempt": att.id, "step": "password", "needs_password": true,
				"note": "this account has 2FA. Enter its password.",
			})
			return
		}
		m.audit.log(legInternal, "session-create", 0, "code rejected: "+err.Error(),
			map[string]string{"step": "code", "phone": att.phone})
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "that code was not accepted"})
		return
	}
	m.finishLogin(w, att, ctx)
}

// submitPassword completes a login that needs 2FA.
func (m *sessionManager) submitPassword(w http.ResponseWriter, attemptID, password string) {
	att := m.take(attemptID)
	if att == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "that attempt has expired"})
		return
	}
	defer m.finish(att)

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	// The password is deliberately not logged and not stored.
	if _, err := att.client.Auth().Password(ctx, strings.TrimSpace(password)); err != nil {
		m.audit.log(legInternal, "session-create", 0, "2FA rejected: "+err.Error(),
			map[string]string{"step": "password", "phone": att.phone})
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "that password was not accepted"})
		return
	}
	m.finishLogin(w, att, ctx)
}

// finishLogin stores the captured session and asks for a reconnect.
func (m *sessionManager) finishLogin(w http.ResponseWriter, att *loginAttempt, ctx context.Context) {
	// The blob appears only once the account is authorised.
	blob := att.storage.get()
	if len(blob) == 0 {
		m.audit.log(legInternal, "session-create", 0, "authorised but no session produced",
			map[string]string{"phone": att.phone})
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error": "signed in but no session was produced; try again",
		})
		return
	}

	// Which account this sign-in belongs to. It comes from the attempt, which
	// got it from the create request, which got it from the operator choosing
	// an account on the Sessions page.
	//
	// It used to be the single hardcoded id, with a comment saying extra
	// accounts were a future feature. That is why creating a second session
	// silently overwrote the first: one slot, keyed on the account id.
	accountID := att.account
	if accountID == "" {
		accountID = defaultAccountID
	}
	// The row has to exist before the session can reference it.
	if err := ensureAccountRow(ctx, m.db, accountID, att.phone); err != nil {
		m.audit.log(legInternal, "session-create", 0, "could not create the account row: "+err.Error(),
			map[string]string{"phone": att.phone, "account": accountID})
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "could not create the account"})
		return
	}
	if err := storeSessionBytes(ctx, m.db, accountID, blob); err != nil {
		m.audit.log(legInternal, "session-create", 0, "could not store: "+err.Error(),
			map[string]string{"phone": att.phone})
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "could not store the session"})
		return
	}
	if _, err := m.db.ExecContext(ctx,
		`UPDATE accounts SET phone = $1, state = 'connected', updated_at = now() WHERE id = $2`,
		att.phone, accountID); err != nil {
		m.audit.log(legInternal, "session-create", 0, "could not update account: "+err.Error(), nil)
	}

	m.audit.log(legInternal, "session-create", 0, "session created",
		map[string]string{"phone": att.phone, "bytes": fmt.Sprint(len(blob)),
			"account": accountID})
	requestReconnect()

	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "bytes": len(blob), "phone": att.phone, "account": accountID,
		"note": "session created and stored. The service is reconnecting.",
	})
}

// deleteSession removes a stored session, which means logging that account out
// and having to sign in again.
func (m *sessionManager) deleteSession(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "no session id"})
		return
	}
	if _, err := m.db.Exec(`DELETE FROM sessions WHERE account_id = $1`, id); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "could not delete"})
		return
	}
	m.audit.log(legInternal, "session-delete", 0, "session removed", map[string]string{"id": id})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "note": "the service will need a new session"})
}

// ------------------------------------------------------------------ state --

func (m *sessionManager) put(att *loginAttempt) {
	m.mu.Lock()
	defer m.mu.Unlock()
	// Evict after inserting too, so an entry that is already past its TTL when
	// it is stored does not linger until the next unrelated operation.
	m.evictLocked()
	m.attempts[att.id] = att
	m.evictLocked()
}

func (m *sessionManager) take(id string) *loginAttempt {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.evictLocked()
	att, ok := m.attempts[id]
	if ok {
		delete(m.attempts, id)
	}
	if !ok {
		return nil
	}
	return att
}

// evictLocked drops expired attempts. Without this, a half-finished login
// would keep its phone number and its gotd client alive indefinitely.
func (m *sessionManager) evictLocked() {
	for id, att := range m.attempts {
		if time.Since(att.started) <= attemptTTL {
			continue
		}
		// Cancelling is what stops the goroutine running the gotd client. An
		// attempt without one would panic here, and eviction happens on every
		// operation, so the nil check is load-bearing rather than defensive.
		if att.cancel != nil {
			att.cancel()
		}
		delete(m.attempts, id)
	}
}

// finish tears an attempt's client down. The cancel is what stops the
// goroutine running the client.
func (m *sessionManager) finish(att *loginAttempt) {
	// A 2FA attempt is kept so the next step can continue, so only tear down
	// when there is genuinely nothing left to do.
	if att.needsPass {
		return
	}
	att.cancel()
	m.mu.Lock()
	delete(m.attempts, att.id)
	m.mu.Unlock()
}

// auditKey is a coarse identifier for rate limiting, since there is no IP worth
// trusting behind a proxy.
func (m *sessionManager) auditKey() string { return "admin" }

func newAttemptID() string {
	const alphabet = "abcdefghijkmnpqrstuvwxyz23456789"
	b := make([]byte, 12)
	for i := range b {
		b[i] = alphabet[rand.Intn(len(alphabet))]
	}
	return string(b)
}

// waitAuthorized blocks until the client is connected and authorised-ready.
// gotd only accepts requests on a running client, so the goroutine above must
// have come up first.
func waitAuthorized(ctx context.Context, c *telegram.Client) error {
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := c.Auth().Status(ctx); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
	return fmt.Errorf("the Telegram client did not become ready")
}

// currentTarget is the running provider connection, so the session manager can
// tell whether a stored session is in use.
var currentTarget *target

func decodeJSON(r *http.Request, v any) error {
	defer r.Body.Close()
	// Bounded, so a large body cannot be used to exhaust memory.
	return json.NewDecoder(http.MaxBytesReader(nil, r.Body, 8<<10)).Decode(v)
}
