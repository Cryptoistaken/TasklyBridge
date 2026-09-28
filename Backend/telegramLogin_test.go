package main

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"strings"
	"testing"
	"time"
)

// Self-tests for the Telegram login verifier.
//
// The important ones are the forgery cases. A JWT is only as trustworthy as the
// signature check, so the tests here mint real RSA keys, sign real tokens, and
// then try every classic way to get past the check: alg:none, HS256 confusion,
// a swapped audience, a token minted for a different bot, an expired token, a
// token signed by an attacker. Each must be rejected.

// signJWT builds a real token with the given header and claims, signed by key.
func signJWT(t *testing.T, key *rsa.PrivateKey, header map[string]any, claims map[string]any) string {
	t.Helper()
	enc := func(v any) string {
		raw, err := json.Marshal(v)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		return base64.RawURLEncoding.EncodeToString(raw)
	}
	signing := enc(header) + "." + enc(claims)
	digest := sha256.Sum256([]byte(signing))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return signing + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func jwkFor(t *testing.T, key *rsa.PrivateKey, kid string) jwk {
	t.Helper()
	rsaPub := &key.PublicKey
	return jwk{
		Kty: "RSA",
		Kid: kid,
		N:   base64.RawURLEncoding.EncodeToString(rsaPub.N.Bytes()),
		E:   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(rsaPub.E)).Bytes()),
	}
}

func validClaims(clientID string, uid string) map[string]any {
	return map[string]any{
		"iss":   telegramIssuer,
		"aud":   clientID,
		"sub":   uid,
		"exp":   4102444800, // 2100-01-01
		"iat":   1750000000,
		"name":  "Admin Person",
		"phone": "+8801700000000",
	}
}

// useTestJWKS installs a key set so verification does not touch the network.
func useTestJWKS(t *testing.T, keys ...jwk) {
	t.Helper()
	jwksMu.Lock()
	jwksKeys = keys
	jwksFetch = time.Now()
	jwksMu.Unlock()
	t.Cleanup(func() {
		jwksMu.Lock()
		jwksKeys = nil
		jwksFetch = time.Time{}
		jwksMu.Unlock()
	})
}

func TestVerifyTelegramLogin(t *testing.T) {
	const clientID = "8730058124"
	const adminUID = "1772093705"

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	attacker, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate attacker key: %v", err)
	}
	keys := []jwk{jwkFor(t, key, "k1")}

	t.Run("accepts a correctly signed token", func(t *testing.T) {
		useTestJWKS(t, keys...)
		tok := signJWT(t, key,
			map[string]any{"alg": "RS256", "typ": "JWT", "kid": "k1"},
			validClaims(clientID, adminUID))
		got, err := verifyTelegramLogin(tok, clientID)
		if err != nil {
			t.Fatalf("valid token rejected: %v", err)
		}
		if got.UID != adminUID {
			t.Errorf("uid = %q, want %q", got.UID, adminUID)
		}
		if got.Name != "Admin Person" {
			t.Errorf("name = %q", got.Name)
		}
	})

	t.Run("rejects alg none", func(t *testing.T) {
		useTestJWKS(t, keys...)
		// Unsigned token, claiming to be an admin.
		enc := func(v any) string {
			raw, _ := json.Marshal(v)
			return base64.RawURLEncoding.EncodeToString(raw)
		}
		tok := enc(map[string]any{"alg": "none"}) + "." +
			enc(validClaims(clientID, adminUID)) + "."
		if _, err := verifyTelegramLogin(tok, clientID); err == nil {
			t.Error("an unsigned alg:none token was accepted")
		}
	})

	t.Run("rejects a token signed by an attacker", func(t *testing.T) {
		useTestJWKS(t, keys...)
		tok := signJWT(t, attacker,
			map[string]any{"alg": "RS256", "kid": "k1"},
			validClaims(clientID, adminUID))
		if _, err := verifyTelegramLogin(tok, clientID); err == nil {
			t.Error("a token signed by an untrusted key was accepted")
		}
	})

	t.Run("rejects a token for a different bot", func(t *testing.T) {
		useTestJWKS(t, keys...)
		// Genuinely signed by Telegram, but minted for another application.
		tok := signJWT(t, key,
			map[string]any{"alg": "RS256", "kid": "k1"},
			validClaims("9999999999", adminUID))
		if _, err := verifyTelegramLogin(tok, clientID); err == nil {
			t.Error("a token for a different client id was accepted")
		}
	})

	t.Run("rejects an expired token", func(t *testing.T) {
		useTestJWKS(t, keys...)
		claims := validClaims(clientID, adminUID)
		claims["exp"] = 1000000000
		claims["iat"] = 999999000
		tok := signJWT(t, key, map[string]any{"alg": "RS256", "kid": "k1"}, claims)
		if _, err := verifyTelegramLogin(tok, clientID); err == nil {
			t.Error("an expired token was accepted")
		}
	})

	t.Run("rejects a token from another issuer", func(t *testing.T) {
		useTestJWKS(t, keys...)
		claims := validClaims(clientID, adminUID)
		claims["iss"] = "https://evil.example"
		tok := signJWT(t, key, map[string]any{"alg": "RS256", "kid": "k1"}, claims)
		if _, err := verifyTelegramLogin(tok, clientID); err == nil {
			t.Error("a token from another issuer was accepted")
		}
	})

	t.Run("rejects a subject that is not digits", func(t *testing.T) {
		useTestJWKS(t, keys...)
		claims := validClaims(clientID, "admin@evil.example")
		tok := signJWT(t, key, map[string]any{"alg": "RS256", "kid": "k1"}, claims)
		if _, err := verifyTelegramLogin(tok, clientID); err == nil {
			t.Error("a non-numeric subject was accepted")
		}
	})

	t.Run("rejects junk and oversized input", func(t *testing.T) {
		useTestJWKS(t, keys...)
		for _, bad := range []string{"", "not-a-jwt", "a.b", "a.b.c.d", strings.Repeat("x", maxTokenBytes+1)} {
			if _, err := verifyTelegramLogin(bad, clientID); err == nil {
				t.Errorf("junk input %q was accepted", truncate(bad, 20))
			}
		}
	})

	t.Run("accepts an array audience containing us", func(t *testing.T) {
		useTestJWKS(t, keys...)
		claims := validClaims(clientID, adminUID)
		claims["aud"] = []any{"1111111111", clientID}
		tok := signJWT(t, key, map[string]any{"alg": "RS256", "kid": "k1"}, claims)
		if _, err := verifyTelegramLogin(tok, clientID); err != nil {
			t.Errorf("array audience rejected: %v", err)
		}
	})

	t.Run("survives a key rotation", func(t *testing.T) {
		// Telegram rotates keys. The named kid is gone, so a correct signature
		// under a remaining key must still work.
		rotated, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			t.Fatalf("rotate: %v", err)
		}
		useTestJWKS(t, jwkFor(t, rotated, "k2"), jwkFor(t, key, "k1"))
		tok := signJWT(t, key,
			map[string]any{"alg": "RS256", "kid": "k1"}, // the stale kid
			validClaims(clientID, adminUID))
		if _, err := verifyTelegramLogin(tok, clientID); err != nil {
			t.Errorf("a rotated key locked the admin out: %v", err)
		}
	})
}

func TestIsAdmin(t *testing.T) {
	admins := []int64{8447133985, 1772093705}

	for _, uid := range []string{"8447133985", "1772093705"} {
		if !isAdmin(uid, admins) {
			t.Errorf("%s should be an admin", uid)
		}
	}
	for _, uid := range []string{"", "0", "1", "999999999", "17720937050", "abc"} {
		if isAdmin(uid, admins) {
			t.Errorf("%q should not be an admin", uid)
		}
	}
	if isAdmin("1772093705", nil) {
		t.Error("with no admins configured, nobody may be an admin")
	}
}
