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
	mu      sync.Mutex
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
	// Public: the healthcheck and the login handshake itself.
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/api/auth/telegram/config", s.handleLoginConfig)
	mux.HandleFunc("/api/auth/telegram/login", s.handleLogin)

	// Private: everything under /api. The dashboard shell is NOT gated,
	// because it is the page that performs the login. Gating it would mean
	// the sign-in screen could not be reached to obtain a session, which is a
	// lockout rather than a security measure. It contains no data: the API
	// behind it is what actually holds anything.
	mux.Handle("/api/", s.requireAuth(http.HandlerFunc(s.handleAPI)))
	mux.Handle("/", s.dashboardHandler())
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
	case path == "/messages":
		s.messages(w, r)
	case path == "/alerts":
		s.alerts(w, r)
	case path == "/withdrawals":
		s.withdrawals(w, r)
	case path == "/withdrawals/terms":
		s.withdrawalTerms(w, r)
	case path == "/settings":
		s.settings(w, r)
	case path == "/session":
		if r.Method == http.MethodPost {
			s.handleUploadSession(w, r)
			return
		}
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

	task := map[string]any{"available": false, "sell_bdt": 0.0}
	if s.cat != nil && len(s.cat.jobs) > 0 {
		job := s.cat.jobs[0]
		task["name"] = job.Name
		task["sell_bdt"] = job.SellBDT
	}
	out["task"] = task
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
	writeJSON(w, http.StatusOK, map[string]any{
		"items": []map[string]any{{
			"id": sessionAccountID(), "phone": accountPhone(), "state": state,
			"balance": 0.0, "assigned_user_id": boundUserID,
			"messages_sent": 0, "flood_wait_seconds": 0,
			"last_seen": time.Now().UTC().Format(time.RFC3339),
			"note":      sessionNote(has, size),
		}},
		"total": 1,
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
	if s.cat != nil {
		for _, j := range s.cat.jobs {
			items = append(items, map[string]any{
				"id": j.Name, "require_all": j.RequireAll, "name": j.Name,
				"sell_bdt": j.SellBDT, "enabled": j.Enabled,
				"available": s.jobAvailable(), "provider_name": "",
				"provider_price": 0.0, "margin_bdt": j.SellBDT, "hidden": []string{},
			})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": items, "total": len(items), "bdt_rate": catBdtRate(s.cat),
	})
}

func catBdtRate(c *catalog) float64 {
	if c == nil {
		return 0
	}
	return c.bdtRate
}

func (s *adminServer) jobAvailable() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if s.db == nil {
		return false
	}
	var v bool
	err := s.db.QueryRowContext(ctx,
		`SELECT available FROM job_availability ORDER BY at DESC LIMIT 1`).Scan(&v)
	return err == nil && v
}

func (s *adminServer) messages(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}
	items := []map[string]any{}
	if s.db != nil {
		rows, err := s.db.Query(
			`SELECT id, leg, text, to_char(at,'YYYY-MM-DD"T"HH24:MI:SS"Z"')
			 FROM messages ORDER BY at DESC LIMIT $1`, limit)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var id, leg, text, at string
				if rows.Scan(&id, &leg, &text, &at) == nil {
					items = append(items, map[string]any{
						"id": id, "account_id": sessionAccountID(), "user_id": 0,
						"leg": leg, "direction": directionOf(leg), "text": text,
						"buttons": []string{}, "at": at,
					})
				}
			}
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

func (s *adminServer) withdrawals(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"items": []map[string]any{}, "total": 0})
}

func (s *adminServer) withdrawalTerms(w http.ResponseWriter, r *http.Request) {
	// The fee and minimum are read from the provider on every withdrawal, never
	// from configuration. This endpoint reports only what is known locally, and
	// says so rather than inventing a number.
	writeJSON(w, http.StatusOK, map[string]any{
		"source": "provider-message", "note": "read live from the provider during a withdrawal",
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
