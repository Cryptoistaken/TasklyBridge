package main

// API contract tests.
//
// Every endpoint in docs/api.md is called against a real Postgres and checked
// for three things:
//
//  1. it answers with the documented status code
//  2. it answers with valid JSON
//  3. it never emits a JSON null
//
// The third rule is the important one and it exists because of a real bug. The
// dashboard formats money with `value.toFixed(2)` and has no null handling
// anywhere, so a null or an absent number is a white screen. GET /api/overview
// omitted provider_cost, margin_bdt and selling_at_loss entirely, the Overview
// page called toFixed on undefined, and the dashboard died with "Cannot read
// properties of undefined". A green build said nothing: tsc, bun build, go vet
// and the other unit tests were all clean while the page was broken.
//
// So the rule is: an absent or null number is a contract violation, not a
// formatting problem to be smoothed over in the page.
//
// Set TEST_DATABASE_URL to run these. They are skipped without it, because the
// alternative is a test that silently passes against no database at all.

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testAdminUID = "8447133985"

func testDSN(t *testing.T) string {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set; start a throwaway postgres and point it at one")
	}
	return dsn
}

// newTestServer builds a real adminServer against a real database. The MTProto
// target is deliberately nil: these tests are about the HTTP surface, and
// standing up a Telegram client here would put a second bridge on the account.
func newTestServer(t *testing.T) *adminServer {
	t.Helper()
	dsn := testDSN(t)

	// The handlers read these as package globals, exactly as loadConfig would
	// leave them in a running service.
	adminIDs = []int64{8447133985, 1772093705}
	withdrawDryRun = true
	telegramLoginClientID = "8730058124"
	boundUserID = 1772093705
	watchEvery = 15 * time.Minute
	watchForJob = "2FA:Create FB"
	currentTarget = nil
	t.Setenv("DATABASE_URL", dsn)
	t.Setenv("LOGS_DATABASE_URL", "")

	if err := runMigrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	db, err := openDB(dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	dir := t.TempDir()
	// readJobState looks in outDir, the same global the watcher writes to, so
	// the test has to point it at a directory it controls.
	outDir = dir
	writeAvailability(t, dir, true, 0.0480)

	st, err := newStore(dir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}

	// The catalogue is copied into the temp dir before it is loaded. The
	// enabled-toggle test writes to it, and setEnabled rewrites the file it was
	// loaded from, so loading the repository's own task.json left a test run
	// reformatting a tracked file. A test must not be able to change the repo.
	raw, err := os.ReadFile("task.json")
	if err != nil {
		t.Fatalf("read task.json: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "task.json"), raw, 0o600); err != nil {
		t.Fatalf("copy task.json: %v", err)
	}
	cat, err := loadCatalog(filepath.Join(dir, "task.json"))
	if err != nil {
		t.Fatalf("catalogue: %v", err)
	}

	s := &adminServer{
		audit:   newAudit(dir),
		store:   st,
		cat:     cat,
		secret:  []byte("test-secret-not-a-real-one"),
		db:      db,
		clients: map[chan []byte]struct{}{},
	}
	s.sessions = newSessionManager(db, s.audit)
	// Without this the audit file handle is still open when t.TempDir cleans
	// up, and on Windows the removal fails, which fails the test for a reason
	// that has nothing to do with the code under test.
	t.Cleanup(func() { _ = s.audit.Close() })
	seedRows(t, s)
	return s
}

// writeAvailability produces the file the price watcher writes.
func writeAvailability(t *testing.T, dir string, available bool, cost float64) {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"available": available,
		"cost":      cost,
		"at":        time.Now().UTC().Format(time.RFC3339),
	})
	if err != nil {
		t.Fatalf("marshal availability: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "availability.json"), body, 0o600); err != nil {
		t.Fatalf("write availability: %v", err)
	}
}

// seedRows puts one row in each table a page reads, so the shape checks have
// something to inspect. An empty list proves nothing: every field check would
// pass on zero items.
func seedRows(t *testing.T, s *adminServer) {
	t.Helper()
	ctx := context.Background()
	stmts := []string{
		`INSERT INTO accounts (id, phone, state, balance, updated_at)
		 VALUES ('primary','+15550100','free',12.5,now())
		 ON CONFLICT (id) DO UPDATE SET balance = EXCLUDED.balance`,
		`INSERT INTO withdrawals (id, account_id, wallet, amount, fee, net, dry_run, status, confirmation, at)
		 VALUES ('w-test','primary','0xtest',5.0,0.025,4.975,true,'created','awaiting',now())
		 ON CONFLICT (id) DO NOTHING`,
		`INSERT INTO alerts (id, level, kind, message, at) VALUES ('a-test','info','price','test',now())
		 ON CONFLICT (id) DO NOTHING`,
	}
	for _, q := range stmts {
		if _, err := s.db.ExecContext(ctx, q); err != nil {
			t.Logf("seed: %v (this table may not exist yet)", err)
		}
	}
	s.storemust(t)
}

// storemust puts one end user in the file-backed store so /api/users is not
// empty either.
func (s *adminServer) storemust(t *testing.T) {
	t.Helper()
	s.store.mu.Lock()
	defer s.store.mu.Unlock()
	s.store.data[1772093705] = Join{TaskName: "Facebook 2fa", JoinedAt: time.Now().UTC()}
}

// call runs one request through the real router with a valid admin cookie.
func (s *adminServer) call(t *testing.T, method, path string, body string) (*http.Response, map[string]any) {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: s.sign(testAdminUID)})

	mux := http.NewServeMux()
	s.routes(mux)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)

	res := w.Result()
	var parsed map[string]any
	if strings.Contains(res.Header.Get("Content-Type"), "application/json") {
		if err := json.Unmarshal(w.Body.Bytes(), &parsed); err != nil {
			t.Fatalf("%s %s: body is not a JSON object: %v\n%s", method, path, err, w.Body.String())
		}
	}
	return res, parsed
}

// findNulls walks a decoded payload and reports every JSON null with its path.
// The dashboard has no null handling, so each one is a latent white screen.
func findNulls(v any, path string, out *[]string) {
	switch t := v.(type) {
	case map[string]any:
		for k, child := range t {
			p := k
			if path != "" {
				p = path + "." + k
			}
			if child == nil {
				*out = append(*out, p)
				continue
			}
			findNulls(child, p, out)
		}
	case []any:
		for i, child := range t {
			findNulls(child, fmt.Sprintf("%s[%d]", path, i), out)
		}
	}
}

func requireNoNulls(t *testing.T, endpoint string, body map[string]any) {
	t.Helper()
	var nulls []string
	findNulls(body, "", &nulls)
	for _, p := range nulls {
		t.Errorf("%s: %q is null; the dashboard has no null handling and will crash on it", endpoint, p)
	}
}

func requireKeys(t *testing.T, endpoint string, obj map[string]any, keys ...string) {
	t.Helper()
	for _, k := range keys {
		if _, ok := obj[k]; !ok {
			t.Errorf("%s: missing key %q", endpoint, k)
		}
	}
}

func requireNumber(t *testing.T, endpoint string, obj map[string]any, keys ...string) {
	t.Helper()
	for _, k := range keys {
		v, ok := obj[k]
		if !ok {
			t.Errorf("%s: missing key %q", endpoint, k)
			continue
		}
		if _, isNum := v.(float64); !isNum {
			t.Errorf("%s: %q is %T (%v), want a number", endpoint, k, v, v)
		}
	}
}

// --- the endpoints docs/api.md promises -------------------------------------

// TestDocumentedEndpointsAreRouted checks the list in docs/api.md against the
// router. Three of them are documented but were never implemented, so the page
// that calls them gets a 404 and the contract quietly stops being true.
func TestDocumentedEndpointsAreRouted(t *testing.T) {
	s := newTestServer(t)

	// method, path, body, wantStatus.
	//
	// /api/withdrawals/terms legitimately answers 503 when no Telegram account
	// is connected, which is the case here: these tests deliberately do not
	// stand up an MTProto client, because that would put a second bridge on the
	// real account.
	cases := []struct {
		method, path, body string
		want               int
	}{
		{http.MethodGet, "/api/overview", "", http.StatusOK},
		{http.MethodGet, "/api/accounts", "", http.StatusOK},
		{http.MethodGet, "/api/users", "", http.StatusOK},
		{http.MethodGet, "/api/tasks", "", http.StatusOK},
		{http.MethodPost, "/api/tasks/Facebook%202fa/enabled", `{"enabled":true}`, http.StatusOK},
		{http.MethodGet, "/api/messages", "", http.StatusOK},
		{http.MethodGet, "/api/alerts", "", http.StatusOK},
		{http.MethodGet, "/api/withdrawals", "", http.StatusOK},
		{http.MethodGet, "/api/withdrawals/terms", "", http.StatusServiceUnavailable},
		{http.MethodGet, "/api/settings", "", http.StatusOK},
		{http.MethodGet, "/api/sessions", "", http.StatusOK},
		{http.MethodGet, "/api/session", "", http.StatusOK},
	}

	for _, c := range cases {
		res, body := s.call(t, c.method, c.path, c.body)
		if res.StatusCode != c.want {
			t.Errorf("%s %s: status %d, want %d (body %v)", c.method, c.path, res.StatusCode, c.want, body)
		}
	}
}

// TestOverviewShape is the test for the bug that broke the dashboard.
func TestOverviewShape(t *testing.T) {
	s := newTestServer(t)
	res, body := s.call(t, http.MethodGet, "/api/overview", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	requireNoNulls(t, "GET /api/overview", body)

	// The Overview page formats every one of these with toFixed or arithmetic.
	task, ok := body["task"].(map[string]any)
	if !ok {
		t.Fatalf("no task object in %v", body)
	}
	requireNumber(t, "GET /api/overview task", task,
		"sell_bdt", "provider_cost", "margin_bdt")
	if _, ok := task["selling_at_loss"].(bool); !ok {
		t.Errorf("GET /api/overview task: selling_at_loss is %T, want bool", task["selling_at_loss"])
	}
	if _, ok := task["available"].(bool); !ok {
		t.Errorf("GET /api/overview task: available is %T, want bool", task["available"])
	}
	if _, ok := task["name"].(string); !ok {
		t.Errorf("GET /api/overview task: name is %T, want string", task["name"])
	}

	accts, ok := body["accounts"].(map[string]any)
	if !ok {
		t.Fatalf("no accounts object")
	}
	requireNumber(t, "GET /api/overview accounts", accts,
		"total", "connected", "degraded", "banned", "dead")

	users, ok := body["users"].(map[string]any)
	if !ok {
		t.Fatalf("no users object")
	}
	requireNumber(t, "GET /api/overview users", users, "total", "joined", "waiting")
	requireNumber(t, "GET /api/overview", body, "balance_total", "alerts_unread")
}

// TestNoFabricatedNumbers catches the other half of the same bug: a number that
// is present but invented. /api/tasks reported provider_price 0.0000 and set
// margin_bdt to the sell price, which would show a healthy margin forever and
// make the loss banner impossible to trigger.
func TestNoFabricatedNumbers(t *testing.T) {
	s := newTestServer(t)
	res, body := s.call(t, http.MethodGet, "/api/tasks", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	items, _ := body["items"].([]any)
	for _, raw := range items {
		it, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		name, _ := it["name"].(string)
		available, _ := it["available"].(bool)
		cost, _ := it["provider_price"].(float64)
		sell, _ := it["sell_bdt"].(float64)
		margin, _ := it["margin_bdt"].(float64)

		if available && cost == 0 {
			t.Errorf("GET /api/tasks %q: available but provider_price is 0.0000, which reads as free", name)
		}
		// margin equal to the sell price means the cost was assumed to be zero.
		if available && sell > 0 && margin == sell {
			t.Errorf("GET /api/tasks %q: margin_bdt equals sell_bdt (%v), so a zero cost was assumed", name, sell)
		}
	}
}

// TestUnauthenticatedIsRefused proves the middleware is actually on.
func TestUnauthenticatedIsRefused(t *testing.T) {
	s := newTestServer(t)
	mux := http.NewServeMux()
	s.routes(mux)
	for _, p := range []string{"/api/overview", "/api/accounts", "/api/sessions", "/api/settings"} {
		r := httptest.NewRequest(http.MethodGet, p, nil)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Result().StatusCode != http.StatusUnauthorized {
			t.Errorf("GET %s with no cookie: status %d, want 401", p, w.Result().StatusCode)
		}
	}
}

// TestPublicRoutes covers the four routes that must work without a session.
func TestPublicRoutes(t *testing.T) {
	s := newTestServer(t)
	mux := http.NewServeMux()
	s.routes(mux)

	t.Run("healthz", func(t *testing.T) {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/healthz", nil))
		// 503 is correct here: no account is connected in a test.
		if got := w.Result().StatusCode; got != http.StatusOK && got != http.StatusServiceUnavailable {
			t.Errorf("status %d, want 200 or 503", got)
		}
	})

	t.Run("login config", func(t *testing.T) {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/auth/telegram/config", nil))
		if w.Result().StatusCode != http.StatusOK {
			t.Errorf("status %d, want 200", w.Result().StatusCode)
		}
		var body map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("not json: %v", err)
		}
		// The page does Number() on this, so it has to be a non-empty string.
		id, ok := body["clientId"].(string)
		if !ok || id == "" {
			t.Errorf("clientId is %v, want a non-empty string", body["clientId"])
		}
	})

	t.Run("login rejects a bad token", func(t *testing.T) {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodPost, "/api/auth/telegram/login",
			strings.NewReader(`{"id_token":"not.a.token"}`))
		r.Header.Set("Content-Type", "application/json")
		mux.ServeHTTP(w, r)
		if w.Result().StatusCode == http.StatusOK {
			t.Error("a forged token was accepted")
		}
	})

	t.Run("webhook refuses a wrong secret", func(t *testing.T) {
		s.webhookSecret = "the-real-secret"
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(`{}`))
		r.Header.Set("X-Telegram-Bot-Api-Secret-Token", "wrong")
		mux.ServeHTTP(w, r)
		if w.Result().StatusCode != http.StatusForbidden {
			t.Errorf("status %d, want 403", w.Result().StatusCode)
		}
	})
}

// TestEveryListEndpointIsAnObject guards the shape every page depends on:
// {"items":[...], "total":N}. A bare array or a null items breaks all of them.
func TestEveryListEndpointIsAnObject(t *testing.T) {
	s := newTestServer(t)
	for _, p := range []string{
		"/api/accounts", "/api/users", "/api/tasks", "/api/messages",
		"/api/alerts", "/api/withdrawals", "/api/sessions",
	} {
		res, body := s.call(t, http.MethodGet, p, "")
		if res.StatusCode != http.StatusOK {
			t.Errorf("GET %s: status %d", p, res.StatusCode)
			continue
		}
		items, ok := body["items"]
		if !ok {
			t.Errorf("GET %s: no items key in %v", p, body)
			continue
		}
		if _, ok := items.([]any); !ok {
			t.Errorf("GET %s: items is %T, want an array", p, items)
		}
		if _, ok := body["total"].(float64); !ok {
			t.Errorf("GET %s: total is %T, want a number", p, body["total"])
		}
		requireNoNulls(t, "GET "+p, body)
	}
}

// TestEventStreamIsSSE opens the stream with a context that is cancelled, so a
// handler that blocks forever cannot hang the suite.
func TestEventStreamIsSSE(t *testing.T) {
	s := newTestServer(t)
	mux := http.NewServeMux()
	s.routes(mux)

	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	r := httptest.NewRequest(http.MethodGet, "/api/events", nil).WithContext(ctx)
	// The stream is behind the same auth as everything else.
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: s.sign(testAdminUID)})
	w := httptest.NewRecorder()

	done := make(chan struct{})
	go func() { mux.ServeHTTP(w, r); close(done) }()

	select {
	case <-done:
	case <-ctx.Done():
		// The stream staying open is the correct behaviour; the recorder is
		// just not usable after that, so assert on the headers instead.
	}
	if ct := w.Result().Header.Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Errorf("GET /api/events: Content-Type %q, want text/event-stream", ct)
	}
}

// TestDatabaseIsReachable keeps the harness honest: if the schema was never
// applied, the other tests would pass on empty results.
func TestDatabaseIsReachable(t *testing.T) {
	s := newTestServer(t)
	var n int
	if err := s.db.QueryRow(`SELECT count(*) FROM information_schema.tables WHERE table_schema='public'`).Scan(&n); err != nil {
		t.Fatalf("query: %v", err)
	}
	if n == 0 {
		t.Fatal("no tables in the test database; the schema was not applied")
	}
	t.Logf("test database has %d table(s)", n)
	var _ = sql.ErrNoRows
}
