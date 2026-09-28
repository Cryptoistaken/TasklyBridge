package main

// The assignment endpoint and the account listing, tested through the real
// router. This is the control that makes more than one user possible, and the
// two mistakes it can make are both expensive: handing one account to two
// people, and handing a person an account that is not connected.

import (
	"context"
	"net/http"
	"testing"
)

func TestAccountsEndpointListsRealRows(t *testing.T) {
	s := newTestServer(t)
	seedAccount(t, s.db, "acct-1", "+880 111 111 1111")
	seedAccount(t, s.db, "acct-2", "+880 222 222 2222")
	if err := assignAccount(context.Background(), s.db, "acct-2", 7777); err != nil {
		t.Fatalf("assign: %v", err)
	}

	res, body := s.call(t, http.MethodGet, "/api/accounts", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	items, _ := body["items"].([]any)
	// Not an exact count: the test database accumulates rows from other tests,
	// and what matters is that the accounts just created are present and real.
	if len(items) < 2 {
		t.Fatalf("got %d accounts, want at least the 2 just seeded: %v", len(items), body)
	}
	requireNoNulls(t, "GET /api/accounts", body)

	byID := map[string]map[string]any{}
	for _, raw := range items {
		it, _ := raw.(map[string]any)
		id, _ := it["id"].(string)
		byID[id] = it
	}
	for _, want := range []string{"acct-1", "acct-2"} {
		it, ok := byID[want]
		if !ok {
			t.Errorf("%s is missing from the listing", want)
			continue
		}
		if _, ok := it["has_session"].(bool); !ok {
			t.Errorf("%s has no has_session flag", want)
		}
		if _, ok := it["balance_known"].(bool); !ok {
			t.Errorf("%s has no balance_known flag", want)
		}
		if p, _ := it["phone"].(string); p == "unknown" || p == "" {
			t.Errorf("%s reports phone %q; the number is stored and must be shown", want, p)
		}
	}
	if got, _ := byID["acct-2"]["assigned_user_id"].(float64); int64(got) != 7777 {
		t.Errorf("acct-2 owner = %v, want 7777", byID["acct-2"]["assigned_user_id"])
	}
}

func TestAssignAccountThroughTheAPI(t *testing.T) {
	s := newTestServer(t)
	seedAccount(t, s.db, "acct-a", "+880 333 333 3333")

	res, body := s.call(t, http.MethodPost, "/api/accounts/acct-a/assign", `{"user_id":4242}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d, body %v", res.StatusCode, body)
	}
	got, ok := accountForUser(context.Background(), s.db, 4242)
	if !ok || got.ID != "acct-a" {
		t.Fatalf("the assignment did not stick: %v %v", got, ok)
	}
}

// TestAssignRefusesAUserServedElsewhere is the important one. Two accounts
// serving one user is the exact situation that made the provider read one
// person's job as another's cancel, so the refusal has to happen.
func TestAssignRefusesAUserServedElsewhere(t *testing.T) {
	s := newTestServer(t)
	seedAccount(t, s.db, "acct-a", "+880 444 444 4444")
	seedAccount(t, s.db, "acct-b", "+880 555 555 5555")
	ctx := context.Background()
	if err := assignAccount(ctx, s.db, "acct-a", 9090); err != nil {
		t.Fatalf("first assign: %v", err)
	}

	res, body := s.call(t, http.MethodPost, "/api/accounts/acct-b/assign", `{"user_id":9090}`)
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("status %d, want 409 so the conflict is explained rather than silent: %v",
			res.StatusCode, body)
	}
	// And the second account must NOT have taken the user.
	if got, ok := accountForUser(ctx, s.db, 9090); !ok || got.ID != "acct-a" {
		t.Errorf("the user was moved anyway: %v %v", got, ok)
	}
}

func TestAssignRejectsBadInput(t *testing.T) {
	s := newTestServer(t)
	seedAccount(t, s.db, "acct-c", "+880 666 666 6666")

	t.Run("unknown account", func(t *testing.T) {
		res, _ := s.call(t, http.MethodPost, "/api/accounts/nope/assign", `{"user_id":1}`)
		if res.StatusCode != http.StatusNotFound {
			t.Errorf("status %d, want 404", res.StatusCode)
		}
	})
	t.Run("GET is not allowed", func(t *testing.T) {
		res, _ := s.call(t, http.MethodGet, "/api/accounts/acct-c/assign", "")
		if res.StatusCode != http.StatusMethodNotAllowed {
			t.Errorf("status %d, want 405", res.StatusCode)
		}
	})
}

// TestReleaseAnAccountStopsServingItsUser is the undo.
func TestReleaseAnAccountStopsServingItsUser(t *testing.T) {
	s := newTestServer(t)
	seedAccount(t, s.db, "acct-d", "+880 777 777 7777")
	if err := assignAccount(context.Background(), s.db, "acct-d", 31337); err != nil {
		t.Fatalf("assign: %v", err)
	}
	res, body := s.call(t, http.MethodPost, "/api/accounts/acct-d/assign", `{"user_id":0}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d, body %v", res.StatusCode, body)
	}
	if _, ok := accountForUser(context.Background(), s.db, 31337); ok {
		t.Error("the account is released but still serves its user")
	}
}

// TestNormaliseAccountID covers the two things the Sessions page sends: a
// phone number, and a name.
func TestNormaliseAccountID(t *testing.T) {
	cases := map[string]string{
		"":                  "",
		"   ":               "",
		"backup-1":          "acct-backup-1",
		"Backup One":        "acct-backupone",
		"../../etc/passwd":  "acct-etcpasswd", // path traversal cannot survive
		"acct-with-dash_1":  "acct-acct-with-dash_1",
		"+880 19 240 72634": "acct-8801924072634",
		"8801924072634":     "acct-8801924072634",
	}
	for in, want := range cases {
		if got := normaliseAccountID(in); got != want {
			t.Errorf("normaliseAccountID(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestANameThatReducesToNothingMustNotFallBackSilently is the dangerous case.
// An empty result makes the caller use the DEFAULT account, which overwrites
// the session already stored there - so a name made entirely of punctuation has
// to be refused rather than quietly redirected.
func TestANameThatReducesToNothingMustNotFallBackSilently(t *testing.T) {
	for _, in := range []string{"...", "!!!", "///", "***"} {
		if got := normaliseAccountID(in); got != "" {
			t.Errorf("normaliseAccountID(%q) = %q, want \"\" so the caller refuses", in, got)
		}
	}
}

// TestHandlerRoutesEachUserToTheirOwnAccount is the behaviour the whole feature
// exists for, tested at the one level that can be tested without Telegram.
func TestHandlerRoutesEachUserToTheirOwnAccount(t *testing.T) {
	fl := newFleet()
	fl.set("acct-1", live("acct-1"), 1111)
	fl.set("acct-2", live("acct-2"), 2222)
	h := &handler{fleet: fl}

	if t1, ok := h.targetFor(1111); !ok || t1.accountID != "acct-1" {
		t.Errorf("user 1111 got %v, want acct-1", t1)
	}
	if t2, ok := h.targetFor(2222); !ok || t2.accountID != "acct-2" {
		t.Errorf("user 2222 got %v, want acct-2", t2)
	}
	if _, ok := h.targetFor(3333); ok {
		t.Error("a user nobody owns an account for was routed somewhere")
	}
}

// TestBoundUserStillWorksWithoutAFleet is the compatibility case: a deployment
// with no owner recorded anywhere must keep serving the user BOUND_USER_ID
// names, exactly as it did before multi-account existed.
func TestBoundUserStillWorksWithoutAFleet(t *testing.T) {
	tgt := live(defaultAccountID)
	h := &handler{tgt: tgt, boundUser: 1772093705}

	got, ok := h.targetFor(1772093705)
	if !ok || got != tgt {
		t.Errorf("the bound user got %v, %v; want the default account", got, ok)
	}
	if _, ok := h.targetFor(999); ok {
		t.Error("a different user was served by the single-account fallback")
	}
}

// TestAnExplicitAssignmentWinsOverBoundUser keeps the fallback from shadowing a
// real assignment: if an operator moved the account to somebody else,
// BOUND_USER_ID must not quietly route the old user back onto it.
func TestAnExplicitAssignmentWinsOverBoundUser(t *testing.T) {
	fl := newFleet()
	fl.set(defaultAccountID, live(defaultAccountID), 2222)
	h := &handler{fleet: fl, tgt: live(defaultAccountID), boundUser: 1111}

	got, ok := h.targetFor(2222)
	if !ok || got.accountID != defaultAccountID {
		t.Errorf("the assigned user got %v, want the account", got)
	}
	if _, ok := h.targetFor(1111); ok {
		t.Error("the previous bound user was still routed to an account reassigned away from them")
	}
}
