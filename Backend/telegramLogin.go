package main

// Telegram Login Widget authentication.
//
// Adapted from the working implementation in C:\Studio\Tools\SheetSubmit
// (backend/src/lib/telegramOidc.ts). That project already does this correctly,
// so the approach is copied rather than invented. See docs/telegram-login.md.
//
// This is the primary admin authentication. There is deliberately NO password
// fallback: a shared password is the weakest link in a panel that can move
// money, and anyone who learns it reaches the withdrawal screen.

import (
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// cryptoSHA256 is crypto.SHA256, spelled once so the verify call reads clearly.
const cryptoSHA256 = crypto.SHA256

const (
	telegramIssuer = "https://oauth.telegram.org"
	telegramJWKS   = "https://oauth.telegram.org/.well-known/jwks.json"
	jwksTTL        = time.Hour
	// maxTokenBytes caps the token before any parsing, so a hostile client
	// cannot make the server allocate on a 10MB "token".
	maxTokenBytes = 8192
)

type jwk struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	N   string `json:"n"`
	E   string `json:"e"`
	Alg string `json:"alg"`
	Use string `json:"use"`
}

// telegramClaims is the subset of the id_token we rely on.
type telegramClaims struct {
	UID      string
	Name     string
	Username string
	Phone    string
}

var (
	jwksMu    sync.Mutex
	jwksKeys  []jwk
	jwksFetch time.Time
)

// fetchJWKS returns Telegram's public keys, cached for an hour.
//
// On a fetch failure the existing cache is served rather than failing outright,
// because a key rotation must not log every admin out. When there is no cache
// at all the login fails, which is the correct trade: a login outage is far
// better than an authentication bypass.
func fetchJWKS() ([]jwk, error) {
	jwksMu.Lock()
	defer jwksMu.Unlock()

	if jwksKeys != nil && time.Since(jwksFetch) < jwksTTL {
		return jwksKeys, nil
	}

	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Get(telegramJWKS)
	if err == nil {
		defer resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			var parsed struct {
				Keys []jwk `json:"keys"`
			}
			if err := json.NewDecoder(resp.Body).Decode(&parsed); err == nil && len(parsed.Keys) > 0 {
				jwksKeys = parsed.Keys
				jwksFetch = time.Now()
				return jwksKeys, nil
			}
		}
	}

	if jwksKeys != nil {
		return jwksKeys, nil // stale cache beats no admins
	}
	return nil, fmt.Errorf("telegram signing keys unavailable and none cached")
}

func b64URLDecode(s string) ([]byte, error) {
	// The transport is base64url, so restore standard base64 and pad.
	s = strings.ReplaceAll(strings.ReplaceAll(s, "-", "+"), "_", "/")
	if pad := len(s) % 4; pad != 0 {
		s += strings.Repeat("=", 4-pad)
	}
	return base64.StdEncoding.DecodeString(s)
}

// verifyRS256 checks the token signature.
//
// The algorithm is read from the token's own header and must be RS256. That
// check is what stops the two classic JWT forgeries: an unsigned "alg: none"
// token, and an RS256 token re-signed as HS256 using the public key as the HMAC
// secret. The header is untrusted input, so nothing is verified before this.
func verifyRS256(token string, keys []jwk) (map[string]any, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, fmt.Errorf("token is not a JWT")
	}
	headerRaw, err := b64URLDecode(parts[0])
	if err != nil {
		return nil, fmt.Errorf("unreadable token header")
	}
	var header struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	if err := json.Unmarshal(headerRaw, &header); err != nil {
		return nil, fmt.Errorf("unreadable token header")
	}
	if header.Alg != "RS256" {
		return nil, fmt.Errorf("unsupported token algorithm %q", header.Alg)
	}

	payloadRaw, err := b64URLDecode(parts[1])
	if err != nil {
		return nil, fmt.Errorf("unreadable token payload")
	}
	signature, err := b64URLDecode(parts[2])
	if err != nil {
		return nil, fmt.Errorf("unreadable token signature")
	}

	signingInput := []byte(parts[0] + "." + parts[1])
	digest := sha256.Sum256(signingInput)

	// Try the key the header names first, then the rest. A rotation mid-session
	// means the named kid may already be gone, and falling back is what keeps
	// admins signed in.
	ordered := orderKeysByKid(keys, header.Kid)
	seen := map[string]bool{}
	for _, key := range ordered {
		if key.Kty != "RSA" || key.N == "" || key.E == "" {
			continue
		}
		id := key.Kid
		if id == "" {
			id = key.N + ":" + key.E
		}
		if seen[id] {
			continue
		}
		seen[id] = true

		pub, err := rsaPublicKey(key)
		if err != nil {
			continue
		}
		if rsa.VerifyPKCS1v15(pub, cryptoSHA256, digest[:], signature) == nil {
			var claims map[string]any
			if err := json.Unmarshal(payloadRaw, &claims); err != nil {
				return nil, fmt.Errorf("unreadable claims")
			}
			return claims, nil
		}
	}
	return nil, fmt.Errorf("token signature did not verify")
}

func orderKeysByKid(keys []jwk, kid string) []jwk {
	if kid == "" {
		return keys
	}
	out := make([]jwk, 0, len(keys))
	for _, k := range keys {
		if k.Kid == kid {
			out = append(out, k)
		}
	}
	for _, k := range keys {
		if k.Kid != kid {
			out = append(out, k)
		}
	}
	return out
}

func rsaPublicKey(k jwk) (*rsa.PublicKey, error) {
	nBytes, err := b64URLDecode(k.N)
	if err != nil {
		return nil, err
	}
	eBytes, err := b64URLDecode(k.E)
	if err != nil {
		return nil, err
	}
	e := 0
	for _, b := range eBytes {
		e = e<<8 | int(b)
	}
	if e < 3 {
		return nil, fmt.Errorf("implausible RSA exponent")
	}
	return &rsa.PublicKey{
		N: new(big.Int).SetBytes(nBytes),
		E: e,
	}, nil
}

// verifyTelegramLogin validates an id_token and returns the identity it proves.
//
// The signature is checked before any claim is read, and the audience is
// checked against our own bot id so a token minted for a different application
// is rejected even though Telegram signed it.
func verifyTelegramLogin(idToken, clientID string) (telegramClaims, error) {
	var out telegramClaims

	if idToken == "" || len(idToken) > maxTokenBytes {
		return out, fmt.Errorf("missing or oversized token")
	}
	if clientID == "" {
		return out, fmt.Errorf("login is not configured")
	}

	keys, err := fetchJWKS()
	if err != nil {
		return out, err
	}
	claims, err := verifyRS256(idToken, keys)
	if err != nil {
		return out, err
	}

	now := time.Now().Unix()

	iss, _ := claims["iss"].(string)
	if iss != telegramIssuer && iss != telegramIssuer+"/" {
		return out, fmt.Errorf("token from an unexpected issuer")
	}

	// aud may be a bare string or an array of them.
	audOK := false
	switch aud := claims["aud"].(type) {
	case string:
		audOK = aud == clientID
	case []any:
		for _, v := range aud {
			if s, ok := v.(string); ok && s == clientID {
				audOK = true
				break
			}
		}
	}
	if !audOK {
		return out, fmt.Errorf("token is for a different application")
	}

	exp, ok := claims["exp"].(float64)
	if !ok || int64(exp) <= now {
		return out, fmt.Errorf("token has expired")
	}
	iat, ok := claims["iat"].(float64)
	if !ok || int64(iat) > now+60 {
		return out, fmt.Errorf("token issued in the future")
	}

	// The subject is the Telegram user id. The claim name has varied, so try
	// the known ones, then fall back to sub.
	uid, _ := claims["sub"].(string)
	for _, key := range []string{"id", "user_id", "telegram_id"} {
		if uid == "" {
			if v, ok := claims[key].(string); ok {
				uid = v
			}
		}
	}
	if !isTelegramUID(uid) {
		return out, fmt.Errorf("token has no usable subject")
	}

	username, _ := claims["preferred_username"].(string)
	if username == "" {
		username, _ = claims["username"].(string)
	}
	name, _ := claims["name"].(string)
	if name == "" {
		given, _ := claims["given_name"].(string)
		family, _ := claims["family_name"].(string)
		name = strings.TrimSpace(given + " " + family)
	}
	if name == "" {
		if n, ok := claims["nickname"].(string); ok {
			name = n
		} else {
			name = username
		}
	}
	if name == "" {
		name = uid
	}
	phone, _ := claims["phone_number"].(string)

	return telegramClaims{
		UID:      uid,
		Name:     truncate(name, 128),
		Username: truncate(username, 64),
		Phone:    truncate(strings.TrimSpace(phone), 32),
	}, nil
}

func isTelegramUID(s string) bool {
	if len(s) < 3 || len(s) > 20 {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// isAdmin reports whether a verified uid may use the panel.
//
// This is deliberately separate from token verification. A valid token proves
// only who the person is; this decides what they may do. A non-admin must never
// be issued a session, and the check must happen after verification so the
// endpoint does not leak who is on the allowlist.
func isAdmin(uid string, admins []int64) bool {
	for _, a := range admins {
		if strconv.FormatInt(a, 10) == uid {
			return true
		}
	}
	return false
}
