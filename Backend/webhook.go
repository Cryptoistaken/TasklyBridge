package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
)

// Telegram webhook registration.
//
// Railway injects RAILWAY_PUBLIC_DOMAIN, so the bot can register its own
// endpoint on every boot. That matters because the domain changes whenever a
// new service is created, and a webhook pointing at a dead URL silently stops
// delivering: the bot looks fine and simply never hears anything again.
//
// Webhook and long polling are mutually exclusive. Telegram refuses getUpdates
// while a webhook is set, so this does not sit beside the poller, it replaces
// it.

// webhookSecret guards the endpoint.
//
// Without it, the URL is the only secret, and the domain is public knowledge
// from the Railway dashboard and from any error page. Telegram echoes this
// value back in X-Telegram-Bot-Api-Secret-Token on every delivery, and a
// request without it is refused before it is parsed.
func webhookSecret() string {
	if s := strings.TrimSpace(os.Getenv("WEBHOOK_SECRET")); s != "" {
		return s
	}
	// A generated value is better than none, but it changes on every deploy,
	// which means the webhook must be re-registered each time. Registration
	// happens on boot anyway, so that is not a problem.
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	return hex.EncodeToString(b)
}

// publicBaseURL is the externally reachable origin of this service.
func publicBaseURL() string {
	// An explicit override wins, so a custom domain or a preview URL can be
	// pinned without changing code.
	if v := strings.TrimSpace(os.Getenv("WEBHOOK_BASE_URL")); v != "" {
		return strings.TrimRight(v, "/")
	}
	if d := strings.TrimSpace(os.Getenv("RAILWAY_PUBLIC_DOMAIN")); d != "" {
		// Railway gives a bare host with no scheme.
		if strings.HasPrefix(d, "http://") || strings.HasPrefix(d, "https://") {
			return strings.TrimRight(d, "/")
		}
		return "https://" + strings.TrimRight(d, "/")
	}
	return ""
}

// setWebhook registers the endpoint and reports what Telegram made of it.
func (b *botClient) setWebhook(url, secret string) error {
	payload := map[string]any{
		"url":             url,
		"allowed_updates": []string{"message", "callback_query"},
		// Drop any backlog the old endpoint did not receive, so the first
		// delivery after a redeploy is not a pile of stale updates.
		"drop_pending_updates": true,
		"max_connections":      4,
	}
	if secret != "" {
		payload["secret_token"] = secret
	}
	return b.call("setWebhook", payload, nil)
}

func (b *botClient) deleteWebhook() error {
	return b.call("deleteWebhook", map[string]any{"drop_pending_updates": false}, nil)
}

// webhookInfo is Telegram's view of the registration, used to confirm it rather
// than assume the call worked.
type webhookInfo struct {
	URL                string `json:"url"`
	PendingUpdateCount int    `json:"pending_update_count"`
	LastErrorMessage   string `json:"last_error_message"`
}

func (b *botClient) getWebhookInfo() (webhookInfo, error) {
	var out webhookInfo
	err := b.call("getWebhookInfo", map[string]any{}, &out)
	return out, err
}

// registerWebhook points Telegram at this service and verifies it.
//
// The base URL comes from RAILWAY_PUBLIC_DOMAIN, which Railway injects and
// which changes when the service is recreated, so this runs on every boot
// rather than once at setup.
func registerWebhook(b *botClient, a *audit) (string, error) {
	base := publicBaseURL()
	if base == "" {
		// Not deployed, or a custom domain. Falling back to long polling is
		// better than refusing to start, but it must be said out loud because
		// long polling from a hosting platform is unreliable and was the
		// reason for this in the first place.
		a.log(legInternal, "webhook-skip", 0,
			"no RAILWAY_PUBLIC_DOMAIN or WEBHOOK_BASE_URL, staying on long polling", nil)
		return "", nil
	}

	url := base + "/webhook"
	secret := webhookSecret()
	if err := b.setWebhook(url, secret); err != nil {
		a.log(legInternal, "webhook-error", 0, "setWebhook failed: "+err.Error(),
			map[string]string{"url": url})
		return "", err
	}
	info, err := b.getWebhookInfo()
	if err != nil {
		a.log(legInternal, "webhook-error", 0, "getWebhookInfo failed: "+err.Error(), nil)
	} else {
		a.log(legInternal, "webhook-set", 0, "Telegram is posting to "+info.URL,
			map[string]string{
				"pending":    strconv.Itoa(info.PendingUpdateCount),
				"last_error": info.LastErrorMessage,
			})
		if info.LastErrorMessage != "" {
			// A 4xx here means Telegram cannot reach us at all, and the bot
			// would look alive while hearing nothing.
			return "", fmt.Errorf("Telegram reports a webhook error: %s", info.LastErrorMessage)
		}
	}
	return secret, nil
}

// verifyWebhookSecret checks Telegram's header in constant time.
func verifyWebhookSecret(r *http.Request, secret string) bool {
	if secret == "" {
		// No secret configured: accept, because refusing would break the bot
		// silently. Registration logs this case so it is visible.
		return true
	}
	got := r.Header.Get("X-Telegram-Bot-Api-Secret-Token")
	return subtle.ConstantTimeCompare([]byte(got), []byte(secret)) == 1
}
