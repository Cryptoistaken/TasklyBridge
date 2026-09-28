package main

// The data model half of multi-account support. These tests exist because the
// thing being modelled is a conflict: two accounts may not serve one user, and
// one account may not silently change hands. Both are enforced in SQL, and both
// are easy to break in a way no existing test would notice.

import (
	"context"
	"database/sql"
	"testing"
)

func seedAccount(t *testing.T, db *sql.DB, id, phone string) {
	t.Helper()
	if err := ensureAccountRow(context.Background(), db, id, phone); err != nil {
		t.Fatalf("seed %s: %v", id, err)
	}
}

func TestOwnerColumnMigrationIsIdempotent(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	// The migration runs on every boot against a live table, so running it twice
	// must be a no-op rather than an error that takes the service down.
	for i := 0; i < 3; i++ {
		if err := ensureOwnerColumn(ctx, s.db); err != nil {
			t.Fatalf("run %d: %v", i, err)
		}
		if err := ensureOwnerIndex(ctx, s.db); err != nil {
			t.Fatalf("index run %d: %v", i, err)
		}
	}
}

func TestAccountsListIncludesOnesWithoutASession(t *testing.T) {
	s := newTestServer(t)
	seedAccount(t, s.db, "acct-a", "+880 111 111 1111")
	seedAccount(t, s.db, "acct-b", "+880 222 222 2222")

	list, err := listAccounts(context.Background(), s.db)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) < 2 {
		t.Fatalf("got %d accounts, want at least 2: %v", len(list), list)
	}
	// Neither has a session stored, and both must still be listed: that is how
	// an operator sees a login they started and never finished.
	for _, a := range list {
		if a.HasSession {
			t.Errorf("%s claims a session exists but none was stored", a.ID)
		}
	}
}

func TestAssignAndLookUpAnOwner(t *testing.T) {
	s := newTestServer(t)
	seedAccount(t, s.db, "acct-x", "+880 333 333 3333")
	ctx := context.Background()

	if err := assignAccount(ctx, s.db, "acct-x", 4242); err != nil {
		t.Fatalf("assign: %v", err)
	}
	got, ok := accountForUser(ctx, s.db, 4242)
	if !ok {
		t.Fatal("the account is not found for the user it was just assigned to")
	}
	if got.ID != "acct-x" {
		t.Errorf("resolved to %q, want acct-x", got.ID)
	}
	if got.Owner != 4242 {
		t.Errorf("owner = %d, want 4242", got.Owner)
	}
}

func TestUnassignedAccountsAreNotReachableByAnyUser(t *testing.T) {
	s := newTestServer(t)
	seedAccount(t, s.db, "acct-y", "+880 444 444 4444")
	ctx := context.Background()

	// An account that exists but serves nobody must not answer for anybody.
	// This is the state a freshly created session is in, and treating it as
	// "available to anyone" would hand a stranger the account.
	if _, ok := accountForUser(ctx, s.db, 999); ok {
		t.Error("an unassigned account resolved a user")
	}

	// Assign it, confirm it resolves, then release it and confirm it stops.
	if err := assignAccount(ctx, s.db, "acct-y", 4242); err != nil {
		t.Fatalf("assign: %v", err)
	}
	if _, ok := accountForUser(ctx, s.db, 4242); !ok {
		t.Fatal("an assigned account does not resolve its own user")
	}
	if err := assignAccount(ctx, s.db, "acct-y", 0); err != nil {
		t.Fatalf("unassign: %v", err)
	}
	if _, ok := accountForUser(ctx, s.db, 4242); ok {
		t.Error("a cleared owner still resolves; the account would keep serving them")
	}
}

// TestAssigningToAnotherUserReleasesTheFirst is the whole point of the design.
// One account, one user, so a reassignment has to unbind the previous holder or
// the account would be serving two people at once - which is the failure that
// made the provider read one user's job as another's cancel.
func TestAssigningToAnotherUserReleasesTheFirst(t *testing.T) {
	s := newTestServer(t)
	seedAccount(t, s.db, "acct-z", "+880 555 555 5555")
	ctx := context.Background()

	if err := assignAccount(ctx, s.db, "acct-z", 1111); err != nil {
		t.Fatalf("first assign: %v", err)
	}
	if err := assignAccount(ctx, s.db, "acct-z", 2222); err != nil {
		t.Fatalf("second assign: %v", err)
	}
	if _, ok := accountForUser(ctx, s.db, 1111); ok {
		t.Error("the previous owner still resolves; two users now share one account")
	}
	got, ok := accountForUser(ctx, s.db, 2222)
	if !ok || got.ID != "acct-z" {
		t.Errorf("the new owner does not resolve it: %v %v", got, ok)
	}
}

func TestAssigningAnUnknownAccountIsRefused(t *testing.T) {
	s := newTestServer(t)
	if err := assignAccount(context.Background(), s.db, "no-such-account", 3333); err == nil {
		t.Error("assigning an account that does not exist was accepted")
	}
}

func TestPhoneNormalisation(t *testing.T) {
	cases := map[string]string{
		"+880 19 240 72634": "+8801924072634",
		"+8801924072634":    "+8801924072634",
		"8801924072634":     "8801924072634",
		"":                  "unknown",
		// Only digits survive, and only a leading + is kept, so text that is
		// not a phone number becomes "unknown" rather than a plausible-looking
		// id built from stray letters.
		"not a number": "unknown",
	}
	for in, want := range cases {
		if got := normalisePhone(in); got != want {
			t.Errorf("normalisePhone(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestOneNumberCannotBecomeTwoAccounts guards the id derivation: the same phone
// in different spacing has to map to the same account, or one Telegram account
// would end up with two rows and two sessions fighting over one provider chat.
func TestOneNumberCannotBecomeTwoAccounts(t *testing.T) {
	a := accountIDForPhone("+880 19 240 72634")
	b := accountIDForPhone("+8801924072634")
	if a == "" || b == "" {
		t.Fatalf("no id derived: %q %q", a, b)
	}
	if a != b {
		t.Errorf("the same number produced two account ids: %q and %q", a, b)
	}
	if accountIDForPhone("") != "" {
		t.Error("an unknown phone produced an account id")
	}
}

func TestEnsureAccountRowUpsertsThePhone(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	seedAccount(t, s.db, "acct-p", "+880 666 666 6666")
	// A second login for the same account must update the row, not fail on the
	// primary key.
	seedAccount(t, s.db, "acct-p", "+880 666 000 0000")

	var phone string
	if err := s.db.QueryRowContext(ctx, `SELECT phone FROM accounts WHERE id = 'acct-p'`).Scan(&phone); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if phone != "+8806660000000" {
		t.Errorf("phone = %q, want the second number", phone)
	}
}

func TestUnreadBalanceIsNotAZeroBalance(t *testing.T) {
	s := newTestServer(t)
	seedAccount(t, s.db, "acct-q", "+880 777 777 7777")
	list, err := listAccounts(context.Background(), s.db)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	for _, a := range list {
		if a.ID != "acct-q" {
			continue
		}
		if a.BalanceKnown {
			t.Error("a balance nobody has read is reported as known")
		}
		if a.Balance != 0 {
			t.Errorf("balance = %v, want 0", a.Balance)
		}
	}
}

func TestOwnedElsewhereExplainsAConflict(t *testing.T) {
	s := newTestServer(t)
	seedAccount(t, s.db, "acct-m", "+880 888 888 8888")
	seedAccount(t, s.db, "acct-n", "+880 999 999 9999")
	ctx := context.Background()
	if err := assignAccount(ctx, s.db, "acct-m", 6161); err != nil {
		t.Fatalf("assign: %v", err)
	}
	// A second account claiming the same user must be detectable BEFORE the
	// write, so the dashboard can explain rather than refuse silently.
	if id, held := ownedElsewhere(ctx, s.db, "acct-n", 6161); !held || id != "acct-m" {
		t.Errorf("ownedElsewhere = %q, %v; want acct-m, true", id, held)
	}
	// And the account asking about itself is not a conflict.
	if _, held := ownedElsewhere(ctx, s.db, "acct-m", 6161); held {
		t.Error("an account reported itself as owned by another")
	}
}

func TestDescribeAccountHasNoSecretInIt(t *testing.T) {
	a := account{ID: "acct-1", Phone: "+8801924072634", Owner: 4242}
	got := describeAccount(a)
	if !hasText(got, "4242") || !hasText(got, "acct-1") {
		t.Errorf("describeAccount = %q", got)
	}
	if hasText(got, "blob") || hasText(got, "session") {
		t.Errorf("the description mentions the credential: %q", got)
	}
}

func hasText(s, sub string) bool {
	return len(sub) > 0 && len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}
