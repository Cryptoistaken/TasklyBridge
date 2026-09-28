package main

import "testing"

// The claims below are the real shape of a Telegram OIDC id_token, taken from a
// token this service actually received. The two numbers are the whole point:
// sub is an unrelated OIDC subject and id is the account's Telegram user id.
// They are both plausible digit strings, so nothing about their shape gives the
// difference away - only the order they are read in does.
const (
	realSub  = "1595440342989821376"
	realTgid = "8447133985"
)

// The admin list exactly as it is configured on the service.
var testAdmins = []int64{8447133985, 1772093705}

func TestTelegramUIDPrefersIDOverSub(t *testing.T) {
	// This is the token that produced "not authorised" for a real admin.
	claims := map[string]any{
		"sub":                realSub,
		"id":                 realTgid,
		"preferred_username": "someone",
		"name":               "A Name",
	}
	got := telegramUID(claims)
	if got != realTgid {
		t.Fatalf("uid = %q, want the id claim %q (sub is %q and is not the Telegram id)",
			got, realTgid, realSub)
	}
	// And the point of the whole exercise: that id has to be recognised as an
	// admin, which is what failed.
	if !isAdmin(got, testAdmins) {
		t.Fatalf("uid %q should be an admin of %v", got, testAdmins)
	}
}

func TestTelegramUIDFallsBackToSub(t *testing.T) {
	// No id claim at all: sub is then the best available answer.
	if got := telegramUID(map[string]any{"sub": realTgid}); got != realTgid {
		t.Fatalf("uid = %q, want %q from sub", got, realTgid)
	}
}

func TestTelegramUIDSkipsUnusableIDClaims(t *testing.T) {
	// An id claim that is not a Telegram id must not shadow a usable sub.
	got := telegramUID(map[string]any{
		"id":  "not-a-number",
		"sub": realTgid,
	})
	if got != realTgid {
		t.Fatalf("uid = %q, want %q - a junk id claim must be ignored", got, realTgid)
	}
}

func TestTelegramUIDAcceptsNumericClaims(t *testing.T) {
	// Telegram has sent these as JSON numbers as well as strings. A number that
	// was not handled would look like an absent claim.
	got := telegramUID(map[string]any{"id": float64(8447133985)})
	if got != realTgid {
		t.Fatalf("uid = %q, want %q from a numeric id claim", got, realTgid)
	}
}

func TestTelegramUIDRejectsNothingUsable(t *testing.T) {
	for _, claims := range []map[string]any{
		{},
		{"sub": "ab"},
		{"id": "12"},                    // too short
		{"id": "123456789012345678901"}, // too long
	} {
		if got := telegramUID(claims); got != "" {
			t.Fatalf("uid = %q, want \"\" for %v", got, claims)
		}
	}
}
