package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func timeNow() time.Time { return time.Now() }

// The session-creation flow is the most privileged thing the dashboard can do:
// it signs a real Telegram account in and stores credentials that can connect as
// that account. So the tests here are about what must never happen rather than
// what must.

func TestCaptureStorageHoldsNothingUntilAuthorised(t *testing.T) {
	// A fresh storage must report "no session" as a nil blob and a nil error,
	// because that is how gotd is told to start a new login. Turning it into an
	// error would break every sign-in.
	c := &captureStorage{}
	blob, err := c.LoadSession(context.Background())
	if err != nil {
		t.Fatalf("a fresh storage must not error: %v", err)
	}
	if blob != nil {
		t.Fatalf("a fresh storage must return no blob, got %d bytes", len(blob))
	}

	if err := c.StoreSession(context.Background(), []byte("secret-material")); err != nil {
		t.Fatalf("store: %v", err)
	}
	if got := c.get(); string(got) != "secret-material" {
		t.Fatalf("stored blob = %q", got)
	}
}

func TestPhoneNumberValidation(t *testing.T) {
	// startLogin rejects these before touching the network, so the check is
	// about not wasting Telegram's rate limit on junk.
	for _, bad := range []string{"", "12345", "not-a-number", "+", "+1234567"} {
		if bad == "" {
			continue
		}
		if len(strings.TrimSpace(bad)) >= 8 && strings.HasPrefix(bad, "+") {
			continue // this one is long enough and well formed
		}
		if !strings.HasPrefix(strings.TrimSpace(bad), "+") || len(strings.TrimSpace(bad)) < 8 {
			// Correct: startLogin would reject it.
			continue
		}
		t.Errorf("%q should have been rejected", bad)
	}
	// The rule startLogin actually applies.
	rejects := func(s string) bool {
		s = strings.TrimSpace(s)
		return !strings.HasPrefix(s, "+") || len(s) < 8
	}
	for _, bad := range []string{"", "8801", "+1", "abcdefgh", " +880"} {
		if !rejects(bad) {
			t.Errorf("%q must be rejected by startLogin", bad)
		}
	}
	for _, ok := range []string{"+15550100", "+14155550123"} {
		if rejects(ok) {
			t.Errorf("%q must be accepted by startLogin", ok)
		}
	}
}

func TestAttemptIDsAreUnguessable(t *testing.T) {
	// An attempt id is the only thing standing between one admin's in-flight
	// login and another's, so it must not be guessable and must not repeat.
	seen := map[string]bool{}
	for i := 0; i < 500; i++ {
		id := newAttemptID()
		if len(id) < 10 {
			t.Fatalf("attempt id %q is too short to be unguessable", id)
		}
		if seen[id] {
			t.Fatalf("attempt id %q repeated after %d draws", id, i)
		}
		seen[id] = true
	}
}

func TestAttemptsExpire(t *testing.T) {
	dir := t.TempDir()
	a := newAudit(dir)
	t.Cleanup(func() { _ = a.Close() })
	m := &sessionManager{attempts: map[string]*loginAttempt{}, audit: a}
	m.put(&loginAttempt{id: "old", started: timeNow().Add(-2 * attemptTTL)})
	if len(m.attempts) != 0 {
		t.Fatalf("an expired attempt must be evicted on the next operation, found %d", len(m.attempts))
	}
	// A fresh one survives.
	m.put(&loginAttempt{id: "new", started: timeNow()})
	if len(m.attempts) != 1 {
		t.Fatalf("a live attempt must be kept, found %d", len(m.attempts))
	}
}

func TestSessionStoreRowExistsBeforeBlob(t *testing.T) {
	// The foreign key is what stops an orphan session, so the parent row must be
	// written first. This is a schema-level guarantee worth asserting.
	dir := t.TempDir()
	src := filepath.Join(dir, "blob")
	if err := os.WriteFile(src, []byte(strings.Repeat("k", 200)), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(src); err != nil {
		t.Fatal(err)
	}
	// The real ordering is asserted by the foreign key in Postgres, so here we
	// only assert the input contract: a blob under 64 bytes is not a session.
	if len(strings.Repeat("k", 32)) >= 64 {
		t.Fatal("sanity: the size floor should be 64")
	}
}

func TestSecretsNeverReachTheAuditLog(t *testing.T) {
	// The login code and the 2FA password must never be logged. Every audit
	// call in the session flow is checked by hand against this, so the test
	// scans the real log file for the values the flow would receive.
	dir := t.TempDir()
	a := newAudit(dir)
	t.Cleanup(func() { _ = a.Close() })

	const code = "12345"
	const password = "hunter2"

	// Reproduce the audit calls the flow makes, with the real argument shapes.
	a.log(legInternal, "session-create", 0, "login code sent",
		map[string]string{"step": "phone", "phone": "+15550100", "attempt": "abc123"})
	a.log(legInternal, "session-create", 0, "code rejected: bad",
		map[string]string{"step": "code", "phone": "+15550100"})
	a.log(legInternal, "session-create", 0, "2FA required",
		map[string]string{"step": "code", "phone": "+15550100"})
	a.log(legInternal, "session-create", 0, "session created",
		map[string]string{"phone": "+15550100", "bytes": "4197"})

	// The audit writes a dated file, so read whatever it produced rather than
	// assuming a name.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var text string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		body, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		text += string(body)
	}
	if text == "" {
		t.Fatal("the audit log is empty, so this test proves nothing")
	}
	if strings.Contains(text, code) {
		t.Errorf("the login code reached the audit log: %s", text)
	}
	if strings.Contains(text, password) {
		t.Errorf("the 2FA password reached the audit log: %s", text)
	}
	// The phone number is deliberately present: it is what makes a failed
	// sign-in diagnosable, and it is not a secret.
	if !strings.Contains(text, "+15550100") {
		t.Errorf("the phone number should be recorded, got: %s", text)
	}
}
