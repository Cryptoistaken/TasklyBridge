package main

// The fleet: every Telegram account this process holds, and the routing between
// an end user and the account that serves them.
//
// The bridge used to hold exactly one MTProto client, and proved who it served
// with a single comparison: `if userID != h.boundUser`. That is the whole of the
// old routing, and it cannot express a second account.
//
// The rule is unchanged, only generalised: one Telegram account serves one end
// user, because the provider keeps per-chat state. What changes is that there
// can now be several accounts, each with its own provider conversation, so the
// question becomes "which one serves this user" instead of "is this the one".
//
// Everything that made a single account delicate is per-account and stays that
// way: each target keeps its own opMu (one whole provider operation at a time)
// and its own seqMu (which must not be opMu, or an operation waiting for a
// reply deadlocks against the update that delivers it). Nothing is shared but
// the read-only catalogue and the audit log.

import (
	"sync"
)

// fleet holds the live accounts and knows who each one serves.
//
// The owner index is held in memory rather than read from the accounts table on
// every message. This is consulted for every incoming update, and a database
// round trip per update would be a self-inflicted rate limit. The table stays
// the durable record; this is the copy the process runs on, refreshed on boot
// and whenever an assignment changes.
type fleet struct {
	mu        sync.RWMutex
	byAccount map[string]*target
	// owner and served are the same relation read in both directions, so
	// removing an account is two deletes rather than a scan.
	owner  map[int64]string // end user id -> account id
	served map[string]int64 // account id -> end user id
}

func newFleet() *fleet {
	return &fleet{
		byAccount: map[string]*target{},
		owner:     map[int64]string{},
		served:    map[string]int64{},
	}
}

// set records an account as live, and which end user it serves.
func (f *fleet) set(accountID string, t *target, owner int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.byAccount[accountID] = t
	if owner != 0 {
		f.owner[owner] = accountID
		f.served[accountID] = owner
	}
}

// clear forgets an account, which is what happens when its client goes away.
//
// The owner entry goes with it. A user whose account is down must be told so,
// not silently left pointing at an account that no longer exists - and never
// routed to somebody else's.
func (f *fleet) clear(accountID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if uid, ok := f.served[accountID]; ok {
		// Only drop the user mapping if it still points here. A reassignment
		// may already have moved this user to a different account.
		if f.owner[uid] == accountID {
			delete(f.owner, uid)
		}
		delete(f.served, accountID)
	}
	delete(f.byAccount, accountID)
}

// forUser returns the live account serving this end user.
//
// found is false when nobody serves them, or when the account that does is not
// connected. Both mean the same thing to the caller: refuse politely rather than
// act on an account that may be somebody else's.
func (f *fleet) forUser(userID int64) (*target, bool) {
	f.mu.RLock()
	id, ok := f.owner[userID]
	f.mu.RUnlock()
	if !ok {
		return nil, false
	}
	return f.get(id)
}

// get returns a live account by id.
func (f *fleet) get(accountID string) (*target, bool) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	t, ok := f.byAccount[accountID]
	if !ok || t == nil || t.api == nil {
		return nil, false
	}
	return t, true
}

// any returns a live account, preferring the one serving preferredUser.
//
// It exists for the operations that genuinely are not per-user: reading the
// provider's fee and minimum, and the price watch. The provider is the same bot
// for every account and quotes the same terms, so one connected account answers
// for all of them - and polling N accounts every fifteen minutes would multiply
// the automated messages this account is judged on, which is the fastest way to
// get an account banned.
func (f *fleet) any(preferredUser int64) (*target, bool) {
	if preferredUser != 0 {
		if t, ok := f.forUser(preferredUser); ok {
			return t, true
		}
	}
	f.mu.RLock()
	defer f.mu.RUnlock()
	for _, t := range f.byAccount {
		if t != nil && t.api != nil {
			return t, true
		}
	}
	return nil, false
}

// count is how many accounts are live and how many are held, for the health
// check and the dashboard.
func (f *fleet) count() (live, total int) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	total = len(f.byAccount)
	for _, t := range f.byAccount {
		if t != nil && t.api != nil {
			live++
		}
	}
	return live, total
}

// isUnowned reports whether an account has no end user assigned.
//
// It exists for the single-account fallback. BOUND_USER_ID still serves the user
// it names, but ONLY while the account is unowned: the moment an operator
// assigns that account to somebody else, the old user must stop being routed
// onto it, or the assignment would be a lie and two people would be driving one
// provider conversation.
//
// It is also what keeps a live deployment working across this change: the
// existing account has no owner recorded, so it is unowned, so BOUND_USER_ID
// keeps serving it exactly as before.
func (f *fleet) isUnowned(accountID string) bool {
	f.mu.RLock()
	defer f.mu.RUnlock()
	_, has := f.served[accountID]
	return !has
}

// ids lists the live account ids, for logging and the dashboard.
func (f *fleet) ids() []string {
	f.mu.RLock()
	defer f.mu.RUnlock()
	out := make([]string, 0, len(f.byAccount))
	for id, t := range f.byAccount {
		if t != nil && t.api != nil {
			out = append(out, id)
		}
	}
	return out
}

// reassign updates the owner index after an operator changes an assignment
// through the dashboard.
//
// Without this the change reaches the database and not the routing: the fleet's
// in-memory copy is what every message consults, so the account would keep
// serving its previous owner until a restart. That is a worse failure than not
// applying it at all, because the dashboard would be showing the new state while
// the bot did the old thing.
func (f *fleet) reassign(accountID string, userID int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	// Drop the old owner, whichever user that was, but only if it still points
	// here - a later assignment may already have moved them.
	for uid, id := range f.owner {
		if id == accountID {
			delete(f.owner, uid)
			delete(f.served, accountID)
			break
		}
	}
	if userID != 0 {
		f.owner[userID] = accountID
		f.served[accountID] = userID
	}
}
