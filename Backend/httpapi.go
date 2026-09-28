package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The admin HTTP surface: the JSON API in docs/api.md, the SSE stream, and the
// dashboard's static files. All from the same process that runs the Telegram
// bot, so there is one thing to deploy and one thing that can break.
//
// Authentication is the Telegram Login Widget, verified against Telegram's
// JWKS. There is deliberately no password fallback: this panel can move money,
// and a shared password is the weakest link in that.

// sessionCookie is signed with ADMIN_SESSION_SECRET, so forging one needs the
// secret rather than a guess at the format.
const sessionCookie = "tb_admin"

type adminServer struct {
	bot     *botClient
	audit   *audit
	store   *store
	tgt     *target
	cat     *catalog
	secret  []byte
	db      *sql.DB
	clients map[chan []byte]struct{}
	// withdrawing is a mutex for the whole money path. Two concurrent
	// withdrawals would interleave two conversations with the provider and
	// could pay the wrong amount, so only one may run at a time.
	withdrawing bool
	// webhookSecret guards POST /webhook, and dispatch hands an incoming
	// update to the same handler the long poller uses.
	webhookSecret string
	dispatch      func(inboundUpdate)
	// sessions drives creating a Telegram session from the dashboard.
	sessions *sessionManager
	mu       sync.Mutex
}

// startAdmin serves the API, the event stream and the dashboard.
//
// The listen address comes from PORT, which is what Railway injects, and falls
// back to 8080 locally. A dashboard that only works on one port is not worth
// having, so the default is deliberate.
func startAdmin(ctx context.Context, s *adminServer) error {
	addr := getenv("PORT")
	if addr == "" {
		addr = "8080"
	}
	if !strings.Contains(addr, ":") {
		addr = ":" + addr
	}

	mux := http.NewServeMux()
	s.routes(mux)

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		// No write timeout: the SSE stream is a long-lived response and a
		// write deadline would kill it after a few seconds.
		IdleTimeout: 120 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()

	s.audit.log(legInternal, "admin-listen", 0, "dashboard and API on "+addr, nil)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func (s *adminServer) routes(mux *http.ServeMux) {
	// Public: the healthcheck, the login handshake, and the webhook.
	//
	// The webhook is public because Telegram is the caller and cannot hold a
	// session. It is guarded by a shared secret header instead, which is
	// checked before the body is even parsed.
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/api/auth/telegram/config", s.handleLoginConfig)
	mux.HandleFunc("/api/auth/telegram/login", s.handleLogin)
	mux.HandleFunc("/webhook", s.handleWebhook)

	// Private: everything under /api. The dashboard shell is NOT gated,
	// because it is the page that performs the login. Gating it would mean
	// the sign-in screen could not be reached to obtain a session, which is a
	// lockout rather than a security measure. It contains no data: the API
	// behind it is what actually holds anything.
	mux.Handle("/api/", s.requireAuth(http.HandlerFunc(s.handleAPI)))
	mux.Handle("/", s.dashboardHandler())
}

// handleWebhook receives updates from Telegram and hands them to the same
// handler the long poller uses, so there is one code path for a message
// regardless of how it arrived.
func (s *adminServer) handleWebhook(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST only"})
		return
	}
	if !verifyWebhookSecret(r, s.webhookSecret) {
		// Answer 403 without parsing, so a stranger cannot make us do work.
		s.audit.log(legInternal, "webhook-denied", 0,
			"rejected a delivery with a bad secret token",
			map[string]string{"from": remoteIP(r)})
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden"})
		return
	}

	// Bounded: Telegram sends small updates, and an unbounded body here would
	// be a free way to make the service allocate.
	var u inboundUpdate
	if err := decodeJSON(r, &u); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid update"})
		return
	}

	// Telegram retries anything that is not 2xx, so answer 200 immediately and
	// do the work after. Otherwise a slow provider navigation would make
	// Telegram redeliver the same update repeatedly.
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})

	if s.dispatch == nil {
		s.audit.log(legInternal, "webhook-early", 0,
			"arrived before the provider was connected; dropped", nil)
		return
	}
	go s.dispatch(u)
}

// dashboardHandler serves the built frontend, falling back to index.html so
// hash routing survives a reload.
func (s *adminServer) dashboardHandler() http.Handler {
	dir := getenv("WEB_DIR")
	if dir == "" {
		dir = "/app/web"
	}
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clean := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
		if clean == "." || clean == "" {
			clean = "index.html"
		}
		if _, err := os.Stat(filepath.Join(dir, clean)); err != nil {
			// Unknown path: hand back the shell and let hash routing take over.
			r = r.Clone(r.Context())
			r.URL.Path = "/"
		}
		fs.ServeHTTP(w, r)
	})
}

// ------------------------------------------------------------------ auth ---

func (s *adminServer) handleHealth(w http.ResponseWriter, r *http.Request) {
	ready := s.tgt != nil
	w.Header().Set("Content-Type", "application/json")
	if !ready {
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "reason": "no provider connection yet"})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

func (s *adminServer) handleLoginConfig(w http.ResponseWriter, r *http.Request) {
	if telegramLoginClientID == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "login is not configured"})
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=3600")
	writeJSON(w, http.StatusOK, map[string]any{"clientId": telegramLoginClientID})
}

func (s *adminServer) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST only"})
		return
	}
	if !rateLimit("login", remoteIP(r), 30, time.Minute) {
		writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "too many attempts"})
		return
	}

	var body struct {
		IDToken string `json:"id_token"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid body"})
		return
	}

	// Verify the signature and the claims before reading anything from the
	// token, then decide on the allowlist. Doing it in this order means an
	// invalid token returns 401 without revealing who is an admin.
	claims, err := verifyTelegramLogin(body.IDToken, telegramLoginClientID)
	if err != nil {
		s.audit.log(legInternal, "login-denied", 0, "invalid token: "+err.Error(), nil)
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid or expired token"})
		return
	}
	if !isAdmin(claims.UID, adminIDs) {
		s.audit.log(legInternal, "login-denied", 0,
			"verified user is not an admin", map[string]string{"uid": claims.UID})
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "not authorised"})
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    s.sign(claims.UID),
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   r.Header.Get("X-Forwarded-Proto") != "http",
		MaxAge:   30 * 24 * 3600,
	})
	s.audit.log(legInternal, "login-ok", 0, claims.Name, map[string]string{"uid": claims.UID})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "uid": claims.UID, "name": claims.Name})
}

// sign produces "uid.expiry.hmac". The expiry is inside the signature, so a
// cookie cannot be extended without the secret.
func (s *adminServer) sign(uid string) string {
	expiry := strconv.FormatInt(time.Now().Add(30*24*time.Hour).Unix(), 10)
	body := uid + "." + expiry
	return body + "." + s.hmac(body)
}

func (s *adminServer) hmac(body string) string {
	m := hmac.New(sha256.New, s.secret)
	m.Write([]byte(body))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// verify checks the cookie signature and expiry in constant time.
func (s *adminServer) verify(value string) (string, bool) {
	parts := strings.Split(value, ".")
	if len(parts) != 3 {
		return "", false
	}
	want := s.hmac(parts[0] + "." + parts[1])
	if !hmac.Equal([]byte(want), []byte(parts[2])) {
		return "", false
	}
	expiry, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || time.Now().Unix() > expiry {
		return "", false
	}
	return parts[0], true
}

func (s *adminServer) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(sessionCookie)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
			return
		}
		if _, ok := s.verify(c.Value); !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ------------------------------------------------------------------ api ----

func (s *adminServer) handleAPI(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api")

	switch {
	case path == "/overview":
		s.overview(w, r)
	case path == "/accounts":
		s.accounts(w, r)
	case path == "/users":
		s.users(w, r)
	case path == "/tasks":
		s.tasks(w, r)
	case strings.HasPrefix(path, "/tasks/") && strings.HasSuffix(path, "/enabled"):
		s.setTaskEnabled(w, r, strings.TrimSuffix(strings.TrimPrefix(path, "/tasks/"), "/enabled"))
	case path == "/messages":
		s.messages(w, r)
	case path == "/alerts":
		s.alerts(w, r)
	case path == "/withdrawals":
		s.handleWithdrawals(w, r)
	case path == "/withdrawals/terms":
		s.withdrawalTerms(w, r)
	case path == "/settings":
		s.settings(w, r)
	case path == "/sessions":
		s.handleSessions(w, r)
	case strings.HasPrefix(path, "/sessions/") && r.Method == http.MethodDelete:
		s.sessions.deleteSession(w, r)
	case path == "/session":
		// Kept for the one thing the create flow cannot do: a plain status
		// check. The raw upload is gone; sessions are created, not uploaded.
		s.sessionStatus(w, r)
	case path == "/events":
		s.events(w, r)
	case path == "/logout":
		http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1})
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "no such endpoint"})
	}
}

func (s *adminServer) overview(w http.ResponseWriter, r *http.Request) {
	connected, degraded, banned, dead, total := 0, 0, 0, 0, 1
	if s.tgt != nil {
		connected = 1
	}

	usersTotal, joined, waiting := 0, 0, 0
	for _, id := range s.store.all() {
		usersTotal++
		if j, ok := s.store.get(id); ok && j.TaskName != "" {
			joined++
		} else {
			waiting++
		}
	}

	// The job's availability is the headline. It comes from the persisted
	// baseline rather than a live poll, because this endpoint must be fast and
	// must not navigate the provider on every dashboard load.
	out := map[string]any{
		"items": []any{},
		"accounts": map[string]any{
			"total": total, "connected": connected, "degraded": degraded,
			"banned": banned, "dead": dead,
		},
		"users":            map[string]any{"total": usersTotal, "joined": joined, "waiting": waiting},
		"withdraw_dry_run": withdrawDryRun,
		"balance_total":    0.0,
		"alerts_unread":    s.unreadAlerts(),
		"last_checked":     time.Now().UTC().Format(time.RFC3339),
	}

	task := s.jobBlock()
	out["task"] = task

	// The balance total carries the same honesty flag: a zero the provider has
	// never confirmed must not be shown as a real figure. Named distinctly from
	// the account count above, which is an int.
	balanceSum, balanceKnown := 0.0, false
	if s.db != nil {
		var v float64
		if err := s.db.QueryRowContext(r.Context(),
			`SELECT COALESCE(SUM(balance),0) FROM accounts`).Scan(&v); err == nil && v > 0 {
			balanceSum, balanceKnown = v, true
		}
	}
	out["balance_total"] = balanceSum
	out["balance_known"] = balanceKnown

	writeJSON(w, http.StatusOK, out)
}

func (s *adminServer) accounts(w http.ResponseWriter, r *http.Request) {
	has, size := 0, 0
	if h, sz, err := HasSession(context.Background(), s.db, sessionAccountID()); err == nil && h {
		has, size = 1, sz
	}
	state := "connected"
	if s.tgt == nil {
		state = "degraded"
	}
	// The stored balance, with the same honesty flag the sessions endpoint
	// uses. A zero is ambiguous, so it is never presented as a real figure.
	var balance float64
	known := false
	if s.db != nil {
		var v float64
		err := s.db.QueryRowContext(r.Context(),
			`SELECT balance FROM accounts WHERE id = $1`, sessionAccountID()).Scan(&v)
		if err == nil && v > 0 {
			balance, known = v, true
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": []map[string]any{{
			"id": sessionAccountID(), "phone": accountPhone(), "state": state,
			"balance": balance, "balance_known": known,
			"assigned_user_id": boundUserID,
			"messages_sent":    0, "flood_wait_seconds": 0,
			"last_seen": time.Now().UTC().Format(time.RFC3339),
			"note":      sessionNote(has, size),
		}},
		"total":         1,
		"total_balance": balance,
		"balance_known": known,
	})
}

// sessionNote reports the presence of a session without revealing it. The blob
// is a live credential, so only its size is ever shown.
func sessionNote(has, size int) string {
	if has == 0 {
		return "NO SESSION STORED - the account is not recoverable from this database"
	}
	return fmt.Sprintf("session stored (%d bytes) in the critical store", size)
}

func (s *adminServer) users(w http.ResponseWriter, r *http.Request) {
	items := []map[string]any{}
	for _, id := range s.store.all() {
		j, ok := s.store.get(id)
		if !ok {
			continue
		}
		status := "waiting"
		if j.TaskName != "" {
			status = "joined"
		}
		items = append(items, map[string]any{
			"id": id, "name": "", "username": "", "status": status,
			"account_id": sessionAccountID(), "task_name": j.TaskName,
			"messages": 0, "joined_at": j.JoinedAt.UTC().Format(time.RFC3339),
			"last_seen": time.Now().UTC().Format(time.RFC3339),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "total": len(items)})
}

func (s *adminServer) tasks(w http.ResponseWriter, r *http.Request) {
	items := []map[string]any{}
	// One snapshot for the whole list: every row describes the same job we
	// sell, and re-reading the file per row could straddle a poll and show two
	// different costs on one page.
	st := readJobState()
	if s.cat != nil {
		for _, j := range s.cat.jobs {
			// provider_price and margin come from the watcher's snapshot, and
			// they are reported as unknown when there is none. This used to
			// send provider_price 0.0 and margin_bdt equal to the sell price,
			// which is a cost of zero invented from nothing: the page showed
			// the provider giving the job away free and a margin equal to the
			// whole sell price, and no loss banner could ever fire.
			price, priceKnown := st.Cost, st.Known
			margin, marginKnown := 0.0, false
			if st.Known && s.cat.bdtRate > 0 {
				costBDT := st.Cost * s.cat.bdtRate
				margin, marginKnown = j.SellBDT-costBDT, true
			}
			items = append(items, map[string]any{
				"id": j.Name, "require_all": j.RequireAll, "name": j.Name,
				"sell_bdt": j.SellBDT, "enabled": j.Enabled,
				"available": st.Available, "provider_name": "",
				"provider_price": price, "provider_price_known": priceKnown,
				"margin_bdt": margin, "margin_known": marginKnown,
				"hidden": []string{},
			})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": items, "total": len(items), "bdt_rate": catBdtRate(s.cat),
	})
}

// setTaskEnabled turns a job on or off from the dashboard.
//
// The Tasks page has always had a toggle wired to this and it 404'd, because
// the route was documented in docs/api.md and never built. Hiding a job is
// configuration, not code, so it edits task.json through the same path the
// operator CLI uses rather than growing a second mechanism.
func (s *adminServer) setTaskEnabled(w http.ResponseWriter, r *http.Request, rawName string) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST only"})
		return
	}
	if s.cat == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "no catalogue is loaded"})
		return
	}
	var req struct {
		Enabled *bool `json:"enabled"`
	}
	if err := decodeJSON(r, &req); err != nil || req.Enabled == nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": `send {"enabled":true} or {"enabled":false}`})
		return
	}
	name, err := url.PathUnescape(rawName)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad job name"})
		return
	}
	if err := s.cat.setEnabled(name, *req.Enabled); err != nil {
		// The name is the caller's, so saying which jobs exist is the only way
		// they can tell a typo from a missing job.
		names := make([]string, 0, len(s.cat.jobs))
		for _, j := range s.cat.jobs {
			names = append(names, j.Name)
		}
		writeJSON(w, http.StatusNotFound, map[string]any{
			"error": err.Error(), "jobs": names,
		})
		return
	}
	s.audit.log(legInternal, "task-toggle", 0, "job enabled="+strconv.FormatBool(*req.Enabled),
		map[string]string{"job": name})
	// Re-read rather than echoing: the file is the truth and the point of the
	// call is to know what was actually persisted.
	s.tasks(w, r)
}

func catBdtRate(c *catalog) float64 {
	if c == nil {
		return 0
	}
	return c.bdtRate
}

// jobState is the provider's last known price for the job we sell.
//
// It is read from availability.json, which is the file the price watcher
// actually writes. It used to be read from the job_availability table, and that
// was wrong in a way nobody could see: nothing has ever written that table, so
// the read always came back empty, jobAvailable always returned false, and the
// dashboard reported every job as UNAVAILABLE from a table that had never held
// a row. The state was real the whole time, one directory away.
type jobState struct {
	Available bool
	// Cost is the provider's price in dollars: our cost, never a sell price.
	Cost float64
	// Known is false when there is no snapshot yet, which is different from a
	// cost of zero. A zero would read as "the provider gives it away free" and
	// would make the margin look perfect.
	Known bool
}

// readJobState loads the watcher's snapshot.
//
// A missing or unreadable file is not an error: the watcher rewrites it within
// one poll of a fresh deploy, so "not known yet" is a normal state to be in.
func readJobState() jobState {
	raw, err := os.ReadFile(filepath.Join(outDir, "availability.json"))
	if err != nil {
		return jobState{}
	}
	var st struct {
		Available bool    `json:"available"`
		Cost      float64 `json:"cost"`
		At        string  `json:"at"`
	}
	if json.Unmarshal(raw, &st) != nil {
		return jobState{}
	}
	// A snapshot that claims a cost but carries no timestamp cannot be trusted
	// as current, and a zero cost with no timestamp is indistinguishable from
	// the zero value.
	return jobState{Available: st.Available, Cost: st.Cost, Known: st.At != ""}
}

// jobBlock builds the catalogue's numbers for the API.
//
// The cost comes from the provider and the sell price is ours, so margin is
// sell minus cost. The conversion to Taka needs a configured rate; without one
// the margin is reported as unknown rather than guessed, which is the rule for
// every other derived figure here.
//
// Nothing is ever defaulted to a real-looking number. A cost that is not known
// is reported as not known, because a fabricated zero would show a healthy
// margin forever and the loss banner could never fire.
func (s *adminServer) jobBlock() map[string]any {
	st := readJobState()
	out := map[string]any{
		"available":       st.Available,
		"name":            "",
		"sell_bdt":        0.0,
		"provider_cost":   0.0,
		"cost_known":      false,
		"margin_bdt":      0.0,
		"margin_known":    false,
		"selling_at_loss": false,
	}
	if s.cat == nil || len(s.cat.jobs) == 0 {
		return out
	}
	job := s.cat.jobs[0]
	out["name"] = job.Name
	out["sell_bdt"] = job.SellBDT

	if !st.Known || !st.Available {
		// No offer means no price. A withdrawn job's cost of zero is the
		// ABSENCE of a quote, not a quote of zero: treating it as known would
		// report the provider as giving the job away free and show a perfect
		// margin on something nobody can buy. This is the exact fabrication
		// the *_known flags exist to prevent, and it is easy to write by
		// accident because the snapshot file does carry a timestamp.
		return out
	}
	out["provider_cost"] = st.Cost
	out["cost_known"] = true

	if s.cat.bdtRate <= 0 {
		// costInBDT's own rule: without a rate the comparison cannot be made.
		return out
	}
	costBDT := st.Cost * s.cat.bdtRate
	out["margin_bdt"] = job.SellBDT - costBDT
	out["margin_known"] = true
	out["selling_at_loss"] = costBDT > job.SellBDT
	return out
}

func (s *adminServer) messages(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}
	// The transcript is the audit file, not the messages table. Nothing has
	// ever inserted into that table, so this endpoint returned an empty list on
	// every call and the page has been blank since it was built - while the
	// four-leg log it should have been showing was being written to disk the
	// whole time.
	items := []map[string]any{}
	if s.audit != nil {
		if got := s.audit.recent(limit); got != nil {
			items = got
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "total": len(items)})
}

// directionOf maps a leg onto the two directions the dashboard groups by.
func directionOf(leg string) string {
	switch leg {
	case legUserToBot, legBotToTaskly:
		return "out"
	case legTasklyToBot, legBotToUser:
		return "in"
	default:
		return "internal"
	}
}

func (s *adminServer) alerts(w http.ResponseWriter, r *http.Request) {
	items := []map[string]any{}
	if s.db != nil {
		rows, err := s.db.Query(
			`SELECT id, level, kind, job, message, read,
			        to_char(at,'YYYY-MM-DD"T"HH24:MI:SS"Z"')
			 FROM alerts ORDER BY at DESC LIMIT 100`)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var id, level, kind, job, msg, at string
				var read bool
				if rows.Scan(&id, &level, &kind, &job, &msg, &read, &at) == nil {
					items = append(items, map[string]any{
						"id": id, "level": level, "kind": kind, "job": job,
						"message": msg, "read": read, "at": at,
					})
				}
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "total": len(items)})
}

func (s *adminServer) unreadAlerts() int {
	if s.db == nil {
		return 0
	}
	var n int
	if err := s.db.QueryRow(`SELECT count(*) FROM alerts WHERE NOT read`).Scan(&n); err != nil {
		return 0
	}
	return n
}

// withdrawalTerms reads the provider's live fee and minimum.
//
// This navigates the provider, so it costs messages and tells the operator the
// real numbers rather than a stored copy that may be stale. It moves nothing.
func (s *adminServer) withdrawalTerms(w http.ResponseWriter, r *http.Request) {
	if s.tgt == nil || s.tgt.api == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": "not connected, so the provider's terms cannot be read",
		})
		return
	}
	terms, err := s.readWithdrawTerms()
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error": "could not read the provider's terms: " + err.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"fee": terms.Fee, "minimum": terms.Minimum,
		"method": terms.Method, "network": "BSC",
		"source": "provider-message",
	})
}

func (s *adminServer) settings(w http.ResponseWriter, r *http.Request) {
	// Secrets are deliberately absent. The API must not be able to return
	// them, so the dashboard cannot render them even if it wanted to.
	writeJSON(w, http.StatusOK, map[string]any{
		"bound_user_id":            boundUserID,
		"admin_ids":                adminIDs,
		"withdraw_wallet":          withdrawWallet,
		"withdraw_dry_run":         withdrawDryRun,
		"watch_interval_seconds":   int(watchEvery.Seconds()),
		"watch_job":                watchForJob,
		"catalog_path":             s.catalogPath(),
		"telegram_login_client_id": telegramLoginClientID,
		"secrets_exposed":          []string{},
	})
}

func (s *adminServer) catalogPath() string {
	if s.cat == nil {
		return ""
	}
	return s.cat.path
}

// ------------------------------------------------------------------- sse ---

// events streams dashboard updates. It is the only long-lived response, which
// is why the server has no write timeout.
func (s *adminServer) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "streaming unsupported"})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	ch := make(chan []byte, 32)
	s.mu.Lock()
	s.clients[ch] = struct{}{}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.clients, ch)
		s.mu.Unlock()
	}()

	// An immediate hello makes the connection observable, and a periodic ping
	// keeps proxies from closing an idle stream.
	fmt.Fprintf(w, "event: ready\ndata: {}\n\n")
	flusher.Flush()

	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case msg := <-ch:
			fmt.Fprintf(w, "event: message\ndata: %s\n\n", msg)
			flusher.Flush()
		case <-ticker.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

// publish fans an event out to every connected dashboard.
func (s *adminServer) publish(payload []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for ch := range s.clients {
		select {
		case ch <- payload:
		default:
			// A dashboard that cannot keep up is dropped rather than allowed
			// to block the bot.
		}
	}
}

// ---------------------------------------------------------------- helpers --

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func remoteIP(r *http.Request) string {
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		return strings.TrimSpace(strings.Split(v, ",")[0])
	}
	return r.RemoteAddr
}

// rateLimit is a fixed-window counter. Enough for a login endpoint; a real
// deployment would put a shared limiter here so it works across replicas.
func rateLimit(bucket, ip string, limit int, window time.Duration) bool {
	rateMu.Lock()
	defer rateMu.Unlock()
	key := bucket + "|" + ip
	now := time.Now()
	if e, ok := rateBuckets[key]; !ok || now.Sub(e.start) > window {
		rateBuckets[key] = rateEntry{start: now, n: 1}
		return true
	} else {
		e.n++
		rateBuckets[key] = e
		return e.n <= limit
	}
}

type rateEntry struct {
	start time.Time
	n     int
}

var (
	rateMu      sync.Mutex
	rateBuckets = map[string]rateEntry{}
)
