package main

// Tests for the three endpoints added after the API sweep found them missing or
// broken. Each was a live defect, not a feature request:
//
//   - GET  /api/withdrawals        answered 405, so the history the page asks
//     for twice never loaded
//   - POST /api/tasks/{id}/enabled was documented and wired to the Tasks page
//     toggle and was never routed at all
//   - GET  /api/messages           read a table nothing inserts into, so the
//     page was blank from the day it was built
//
// The audit reader behind the last one is covered in auditrecent_test.go; what
// is pinned here is the wiring, which is what was actually broken.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// --- GET /api/withdrawals --------------------------------------------------

func TestWithdrawalHistoryReadsTheTable(t *testing.T) {
	s := newTestServer(t)
	res, body := s.call(t, http.MethodGet, "/api/withdrawals", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d, want 200", res.StatusCode)
	}
	items, _ := body["items"].([]any)
	if len(items) == 0 {
		t.Fatal("no rows: seedRows inserted one, so the query is not reading the table")
	}
	first, _ := items[0].(map[string]any)
	if first == nil {
		t.Fatalf("item is not an object: %v", items[0])
	}

	// The page formats every one of these.
	requireNumber(t, "GET /api/withdrawals", first, "amount", "fee", "net")
	requireKeys(t, "GET /api/withdrawals", first,
		"id", "account_id", "wallet", "dry_run", "status", "confirmation", "at")

	// "created" is not "paid". The provider confirms a request was created and
	// never confirms the money arrived, so the word must pass through untouched.
	if st, _ := first["status"].(string); st != "created" {
		t.Errorf("status = %q, want the stored \"created\" verbatim", st)
	}
	if dry, _ := first["dry_run"].(bool); !dry {
		t.Error("dry_run = false, but the seeded row is a dry run")
	}
	// at has to be the shape the page's Date parser accepts.
	if at, _ := first["at"].(string); !strings.HasSuffix(at, "Z") || !strings.Contains(at, "T") {
		t.Errorf("at = %q, want an ISO timestamp ending in Z", at)
	}
	requireNoNulls(t, "GET /api/withdrawals", body)
}

func TestWithdrawalHistoryIsEmptyNotBroken(t *testing.T) {
	s := newTestServer(t)
	if _, err := s.db.Exec(`DELETE FROM withdrawals`); err != nil {
		t.Fatalf("clear: %v", err)
	}
	res, body := s.call(t, http.MethodGet, "/api/withdrawals", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d, want 200", res.StatusCode)
	}
	items, ok := body["items"].([]any)
	if !ok {
		t.Fatalf("items is %T, want an array - the page iterates it", body["items"])
	}
	if len(items) != 0 {
		t.Errorf("got %d items after deleting every row", len(items))
	}
	if n, _ := body["total"].(float64); n != 0 {
		t.Errorf("total = %v, want 0", body["total"])
	}
}

// TestWithdrawalsPathStillRefusesAnUnsafePost guards the split. GET is now the
// history, but POST is the only thing that can spend money, so a body with no
// accounts must still be refused rather than treated as a read.
func TestWithdrawalsPathStillRefusesAnUnsafePost(t *testing.T) {
	s := newTestServer(t)
	res, body := s.call(t, http.MethodPost, "/api/withdrawals", `{"account_ids":[]}`)
	if res.StatusCode == http.StatusOK {
		t.Fatalf("an empty withdrawal request was accepted: %v", body)
	}
	if res.StatusCode != http.StatusBadRequest {
		t.Errorf("status %d, want 400 for a request naming no account", res.StatusCode)
	}
}

// --- POST /api/tasks/{id}/enabled -----------------------------------------

func TestSetTaskEnabledTogglesAndPersists(t *testing.T) {
	s := newTestServer(t)

	before := enabledInFile(t, s.cat.path)
	res, body := s.call(t, http.MethodPost, "/api/tasks/Facebook%202fa/enabled", `{"enabled":false}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d, want 200 (body %v)", res.StatusCode, body)
	}
	after := enabledInFile(t, s.cat.path)
	if before == after {
		t.Errorf("enabled stayed %v; the toggle has to reach the file, not just answer 200", after)
	}
	if after != false {
		t.Errorf("enabled = %v, want false", after)
	}

	// The response is a re-read of the catalogue, so it must agree.
	items, _ := body["items"].([]any)
	if len(items) == 0 {
		t.Fatal("no items in the response")
	}
	first, _ := items[0].(map[string]any)
	if en, _ := first["enabled"].(bool); en {
		t.Error("the response says enabled=true after disabling it")
	}

	// And back on again.
	if res, _ := s.call(t, http.MethodPost, "/api/tasks/Facebook%202fa/enabled", `{"enabled":true}`); res.StatusCode != http.StatusOK {
		t.Errorf("re-enable: status %d", res.StatusCode)
	}
	if enabledInFile(t, s.cat.path) != true {
		t.Error("the job was not re-enabled in the file")
	}
}

func TestSetTaskEnabledRejectsBadInput(t *testing.T) {
	s := newTestServer(t)

	t.Run("no body", func(t *testing.T) {
		res, _ := s.call(t, http.MethodPost, "/api/tasks/Facebook%202fa/enabled", "")
		if res.StatusCode != http.StatusBadRequest {
			t.Errorf("status %d, want 400", res.StatusCode)
		}
	})
	t.Run("enabled missing", func(t *testing.T) {
		res, _ := s.call(t, http.MethodPost, "/api/tasks/Facebook%202fa/enabled", `{}`)
		if res.StatusCode != http.StatusBadRequest {
			t.Errorf("status %d, want 400", res.StatusCode)
		}
	})
	t.Run("unknown job lists what exists", func(t *testing.T) {
		res, body := s.call(t, http.MethodPost, "/api/tasks/No%20Such%20Job/enabled", `{"enabled":false}`)
		if res.StatusCode != http.StatusNotFound {
			t.Errorf("status %d, want 404", res.StatusCode)
		}
		// The caller needs to be able to tell a typo from a missing job.
		if _, ok := body["jobs"].([]any); !ok {
			t.Errorf("no jobs list in %v, so the operator cannot see what exists", body)
		}
	})
	t.Run("GET is not allowed", func(t *testing.T) {
		res, _ := s.call(t, http.MethodGet, "/api/tasks/Facebook%202fa/enabled", "")
		if res.StatusCode != http.StatusMethodNotAllowed {
			t.Errorf("status %d, want 405", res.StatusCode)
		}
	})
}

// enabledInFile reads the flag straight off disk rather than trusting the
// in-memory catalogue, because the file is what a restart will load.
func enabledInFile(t *testing.T, path string) bool {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read catalogue: %v", err)
	}
	var f catalogFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parse catalogue: %v", err)
	}
	if len(f.Jobs) == 0 {
		t.Fatal("no jobs in the catalogue file")
	}
	return f.Jobs[0].Enabled
}

// --- GET /api/messages -----------------------------------------------------

// TestMessagesEndpointReturnsTheAudit is the wiring test. recent() has its own
// tests; what was broken is that the endpoint never called it.
func TestMessagesEndpointReturnsTheAudit(t *testing.T) {
	s := newTestServer(t)
	s.audit.log(legUserToBot, "text", 1772093705, "hello from a user", nil)
	s.audit.log(legBotToTaskly, "press", 0, "📋 Tasks", nil)
	s.audit.log(legTasklyToBot, "reply", 0, "Please select a task", nil)

	res, body := s.call(t, http.MethodGet, "/api/messages", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d, want 200", res.StatusCode)
	}
	items, _ := body["items"].([]any)
	if len(items) != 3 {
		t.Fatalf("got %d messages, want the 3 just logged: %v", len(items), body)
	}

	// Newest first, which is what the page expects.
	first, _ := items[0].(map[string]any)
	if txt, _ := first["text"].(string); txt != "Please select a task" {
		t.Errorf("newest = %q, want the last thing logged", txt)
	}
	requireNoNulls(t, "GET /api/messages", body)

	// The user id has to survive, or the page cannot attribute a message.
	// It arrives as a JSON number, so it decodes to float64, not int64.
	var sawUser bool
	for _, raw := range items {
		it, _ := raw.(map[string]any)
		if uid, _ := it["user_id"].(float64); uid == 1772093705 {
			sawUser = true
		}
	}
	if !sawUser {
		t.Error("no message carries user_id 1772093705")
	}
}

func TestMessagesRespectsLimit(t *testing.T) {
	s := newTestServer(t)
	for i := 0; i < 12; i++ {
		s.audit.log(legUserToBot, "text", 0, "message", nil)
	}
	res, body := s.call(t, http.MethodGet, "/api/messages?limit=5", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	items, _ := body["items"].([]any)
	if len(items) != 5 {
		t.Errorf("got %d items, want 5", len(items))
	}
}

// TestMessagesEmptyLogIsNotAnError is the state a fresh deploy is in, and it
// must read as "nothing yet" rather than as a failure.
func TestMessagesEmptyLogIsNotAnError(t *testing.T) {
	s := newTestServer(t)
	if err := os.WriteFile(s.audit.path, nil, 0o600); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	res, body := s.call(t, http.MethodGet, "/api/messages", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d, want 200", res.StatusCode)
	}
	if items, ok := body["items"].([]any); !ok || len(items) != 0 {
		t.Errorf("items = %v, want an empty array", body["items"])
	}
}

// TestSnapshotFileIsNotTheAuditFile guards a mix-up that would be easy to make
// in either direction: the availability snapshot and the transcript are separate
// files and neither may read the other.
// TestSessionsSurvivesANilDatabase is the regression test for a wiring bug that
// only production had.
//
// withTarget built the session manager BEFORE opening the store, so the manager
// was handed a nil *sql.DB and GET /api/sessions dereferenced it. The HTTP
// server recovers a panic per connection, so the process stayed up and healthz
// kept returning 200 while the page returned 502 forever - and it had never
// worked, so nobody had a "before" to compare against.
//
// The contract tests could not see it: they build the server themselves and wire
// the manager with a real handle. They verify the handler, not the order the
// production wiring happens in. So this asks the question the wiring failed to.
func TestSessionsSurvivesANilDatabase(t *testing.T) {
	s := newTestServer(t)
	// Exactly what production had: a manager, but with no handle behind it.
	s.sessions = newSessionManager(nil, s.audit)

	mux := http.NewServeMux()
	s.routes(mux)
	r := httptest.NewRequest(http.MethodGet, "/api/sessions", nil)
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: s.sign(testAdminUID)})
	w := httptest.NewRecorder()

	// The point is that this returns at all. A nil dereference here panics, and
	// httptest's recorder has no server to recover it, so the test dies.
	mux.ServeHTTP(w, r)

	if w.Result().StatusCode != http.StatusServiceUnavailable {
		t.Errorf("status %d, want 503 - a missing database is a clear error, not a panic",
			w.Result().StatusCode)
	}
}

// TestSessionsManagerIsBuiltAfterTheStore is a source-level check, and it is a
// source-level check on purpose.
//
// The ordering bug lived in withTarget, which cannot be unit tested: entering it
// starts a real MTProto client against a real Telegram account. Every test that
// builds an adminServer itself wires the manager correctly, so a test written
// that way passes no matter what withTarget does - which is exactly how the
// first version of this test managed to become a check that could not fail.
//
// So this asserts the invariant where it is actually expressed: in the source.
// It reads main.go and requires newSessionManager to appear after
// openCriticalStore. It is a lint, not a proof, and it is labelled as one.
func TestSessionsManagerIsBuiltAfterTheStore(t *testing.T) {
	raw, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	src := string(raw)

	open := strings.Index(src, "openCriticalStore()")
	build := strings.Index(src, "newSessionManager(")
	if open < 0 || build < 0 {
		t.Skip("the wiring moved out of main.go; check it by hand")
	}
	if build < open {
		t.Errorf("newSessionManager is called at offset %d, before openCriticalStore at %d.\n"+
			"The manager is handed admin.db, so it must be built after the store is open, "+
			"or GET /api/sessions panics on a nil handle.", build, open)
	}
}

func TestSnapshotFileIsNotTheAuditFile(t *testing.T) {
	s := newTestServer(t)
	avail := filepath.Join(outDir, "availability.json")
	if avail == s.audit.path {
		t.Fatal("the availability snapshot and the audit log are the same path")
	}
	if _, err := os.Stat(avail); err != nil {
		t.Fatalf("the availability snapshot the API reads is missing: %v", err)
	}
}
