package main

// The fleet's routing rules. These are the decisions that decide whose Telegram
// account acts on a message, and getting one wrong means one user's job is
// driven on another user's provider conversation - the failure this project
// started with.

import (
	"testing"
	"time"

	"github.com/gotd/td/tg"
)

// live builds a target that looks connected, which is all the fleet checks.
func live(accountID string) *target {
	return &target{accountID: accountID, api: &tg.Client{}, arrivals: make(chan seqMsg, 1)}
}

// offline is registered but not connected, which is what a dropped client looks
// like until it is cleared.
func offline(accountID string) *target {
	return &target{accountID: accountID, arrivals: make(chan seqMsg, 1)}
}

func TestFleetRoutesAUserToTheirOwnAccount(t *testing.T) {
	f := newFleet()
	f.set("acct-a", live("acct-a"), 1111)
	f.set("acct-b", live("acct-b"), 2222)

	a, ok := f.forUser(1111)
	if !ok || a.accountID != "acct-a" {
		t.Errorf("user 1111 got %v, want acct-a", a)
	}
	b, ok := f.forUser(2222)
	if !ok || b.accountID != "acct-b" {
		t.Errorf("user 2222 got %v, want acct-b", b)
	}
}

func TestFleetRefusesAnUnknownUser(t *testing.T) {
	f := newFleet()
	f.set("acct-a", live("acct-a"), 1111)
	// This is the replacement for `userID != h.boundUser`. An end user nobody
	// owns an account for must be refused, never served on somebody else's.
	if got, ok := f.forUser(9999); ok {
		t.Errorf("an unknown user was routed to %q", got.accountID)
	}
}

// TestFleetRefusesADisconnectedAccount is the other half. An account that is
// registered but not connected must not be handed out: acting on it would fail
// mid-operation, or worse, appear to work on a stale connection.
func TestFleetRefusesADisconnectedAccount(t *testing.T) {
	f := newFleet()
	f.set("acct-a", offline("acct-a"), 1111)
	if got, ok := f.forUser(1111); ok {
		t.Errorf("a disconnected account was routed to: %q", got.accountID)
	}
}

func TestFleetClearingAnAccountStopsServingItsUser(t *testing.T) {
	f := newFleet()
	f.set("acct-a", live("acct-a"), 1111)
	f.set("acct-b", live("acct-b"), 2222)

	f.clear("acct-a")

	// The user must NOT be silently moved to acct-b, and must not keep a
	// dangling reference to an account that is gone.
	if got, ok := f.forUser(1111); ok {
		t.Errorf("a cleared account still serves its user: %q", got.accountID)
	}
	if got, ok := f.forUser(2222); !ok || got.accountID != "acct-b" {
		t.Error("clearing one account disturbed the other")
	}
}

// TestFleetReassignmentMovesTheMapping guards a subtle case: if a user is moved
// to a new account and the old one then drops, the user must keep the NEW
// account. Clearing blindly would drop them entirely.
func TestFleetReassignmentMovesTheMapping(t *testing.T) {
	f := newFleet()
	f.set("acct-old", live("acct-old"), 1111)
	f.set("acct-new", live("acct-new"), 1111)

	got, ok := f.forUser(1111)
	if !ok || got.accountID != "acct-new" {
		t.Fatalf("the user resolves to %v, want acct-new", got)
	}
	f.clear("acct-old")
	got, ok = f.forUser(1111)
	if !ok || got.accountID != "acct-new" {
		t.Errorf("after the old account dropped, the user resolves to %v, want acct-new", got)
	}
}

func TestFleetAnyPrefersTheBoundUser(t *testing.T) {
	f := newFleet()
	f.set("acct-a", live("acct-a"), 1111)
	f.set("acct-b", live("acct-b"), 2222)

	// The price watch and the provider terms are not per-user. They should use
	// a known-good account rather than whichever the map happens to yield, so
	// the behaviour is the same on every run.
	got, ok := f.any(2222)
	if !ok || got.accountID != "acct-b" {
		t.Errorf("any(2222) = %v, want acct-b", got)
	}
	// An unknown preferred user falls back to any live account rather than
	// failing, so the watcher still works before anything is assigned.
	if _, ok := f.any(9999); !ok {
		t.Error("any(9999) found nothing despite two live accounts")
	}
}

func TestFleetAnyWithNothingLive(t *testing.T) {
	f := newFleet()
	if _, ok := f.any(1111); ok {
		t.Error("any() invented a target with no accounts registered")
	}
	f.set("acct-a", offline("acct-a"), 1111)
	if _, ok := f.any(1111); ok {
		t.Error("any() returned a disconnected account")
	}
}

func TestFleetCount(t *testing.T) {
	f := newFleet()
	if live, total := f.count(); live != 0 || total != 0 {
		t.Errorf("empty fleet: live=%d total=%d", live, total)
	}
	f.set("acct-a", live("acct-a"), 1111)
	f.set("acct-b", offline("acct-b"), 2222)
	if l, tot := f.count(); l != 1 || tot != 2 {
		t.Errorf("live=%d total=%d, want 1 and 2", l, tot)
	}
	// A registered account with no owner is a session waiting for a user, which
	// is a normal state and must still be counted as held.
	f.set("acct-c", live("acct-c"), 0)
	if l, tot := f.count(); l != 2 || tot != 3 {
		t.Errorf("live=%d total=%d, want 2 and 3", l, tot)
	}
	if len(f.ids()) != 2 {
		t.Errorf("ids() = %v, want the two live accounts", f.ids())
	}
}

// TestFleetConcurrentAccess is a race check, run with -race. The fleet is read
// on every incoming update and written on every connect and disconnect, so the
// unsynchronised version would be a data race rather than a wrong answer.
func TestFleetConcurrentAccess(t *testing.T) {
	f := newFleet()
	f.set("acct-a", live("acct-a"), 1111)
	f.set("acct-b", live("acct-b"), 2222)

	done := make(chan struct{})
	for i := 0; i < 4; i++ {
		go func() {
			defer func() { done <- struct{}{} }()
			for j := 0; j < 500; j++ {
				f.forUser(1111)
				f.forUser(2222)
				f.forUser(9999)
				f.any(1111)
				f.count()
				f.ids()
				if j%100 == 0 {
					f.set("acct-a", live("acct-a"), 1111)
					f.clear("acct-b")
					f.set("acct-b", live("acct-b"), 2222)
				}
				time.Sleep(time.Microsecond)
			}
		}()
	}
	for i := 0; i < 4; i++ {
		<-done
	}
}
