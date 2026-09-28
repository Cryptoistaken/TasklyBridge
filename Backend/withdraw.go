package main

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// The provider states its own fee and minimum, in its own words, on its own
// screen:
//
//	You selected USDT (BEP-20).
//	📉 Fee: $0.025
//	🔢 Minimum withdrawal amount: $0.20
//
// So they are read from that message on every run rather than configured.
// Two reasons: the provider sets them and can change them without warning
// (the Cookies group already moved $0.0500 -> $0.0480 in a day), and a
// hardcoded copy would let the bridge quote a fee that is no longer true. A
// wrong fee is not a display bug here, because the fee is taken from the
// user's balance.

// withdrawTerms is what the provider's message tells us.
type withdrawTerms struct {
	Fee     float64
	Minimum float64
	Method  string // e.g. "USDT (BEP-20)", as the provider words it
	// Found reports whether both numbers were actually read. A missing one is
	// a hard error, never a silent zero.
	Found bool
}

// The amounts are written as $0.025 and $0.20. Matched loosely on purpose:
// the label wording and the emoji could change, and the numbers are the part
// that must be read.
var (
	feeRe = regexp.MustCompile(`(?i)fee\s*[:\-]?\s*\$?\s*([0-9]+(?:\.[0-9]+)?)`)
	// The minimum is matched by skipping every non-digit up to the first
	// number, so the wording between "Minimum" and the amount does not matter.
	// That is deliberate: the emoji, the word "amount" and the "$" are all
	// likely to change, and the number is the part that must be read.
	minimumRe = regexp.MustCompile(`(?i)min(?:imum)?[^0-9]*([0-9]+(?:\.[0-9]+)?)`)
	methodRe  = regexp.MustCompile(`(?i)you selected\s+([^\n]+)`)
)

// parseWithdrawTerms reads the fee and the minimum out of the provider's
// message. It is called on the live reply every time, and never trusts a
// previously stored value.
func parseWithdrawTerms(msg string) (withdrawTerms, error) {
	var t withdrawTerms

	// The method line is matched first and dropped, so a number in the method
	// name cannot be mistaken for the fee. Nothing else is removed.
	if m := methodRe.FindStringSubmatch(msg); len(m) == 2 {
		// The provider ends the line with a full stop: "You selected USDT
		// (BEP-20)." Trim punctuation so the method reads as a name.
		t.Method = strings.Trim(strings.TrimSpace(m[1]), " .")
		msg = strings.Replace(msg, m[0], "", 1)
	}

	// The fee is parsed on its own first, so a later screen that quotes the fee
	// without repeating the minimum still yields the fee to the caller. The
	// provider does exactly that when it switches to "Enter amount:".
	fee := feeRe.FindStringSubmatch(msg)
	if len(fee) == 2 {
		v, err := strconv.ParseFloat(fee[1], 64)
		if err == nil && v > 0 {
			t.Fee = v
		}
	}

	minimum := minimumRe.FindStringSubmatch(msg)
	if len(minimum) != 2 || len(fee) != 2 {
		return t, fmt.Errorf(
			"could not read the provider's fee and minimum from: %q\n"+
				"refusing to guess, because the fee comes out of the user's balance",
			truncate(oneline(msg), 200))
	}

	var err error
	if t.Minimum, err = strconv.ParseFloat(minimum[1], 64); err != nil {
		return t, fmt.Errorf("minimum %q did not parse: %w", minimum[1], err)
	}
	if t.Minimum, err = strconv.ParseFloat(minimum[1], 64); err != nil {
		return t, fmt.Errorf("minimum %q did not parse: %w", minimum[1], err)
	}
	if t.Fee <= 0 {
		return t, fmt.Errorf("provider reported a fee of %.4f, which cannot be right", t.Fee)
	}
	if t.Minimum <= 0 {
		return t, fmt.Errorf("provider reported a minimum of %.4f, which cannot be right", t.Minimum)
	}
	t.Found = true
	return t, nil
}

// net is what the user actually receives: the amount less the flat fee.
//
// The provider deducts the fee from the amount rather than adding it, so
// sending $0.375 yields $0.350. This mirrors the provider's own arithmetic so
// the dashboard can show a net figure that matches the confirmation.
func (t withdrawTerms) net(amount float64) float64 { return amount - t.Fee }

// feeIsHeavy reports whether the flat fee would eat a meaningful share of a
// withdrawal. At the provider's own figures the fee is 12.5% of the minimum,
// which is worth showing rather than hiding.
func (t withdrawTerms) feeIsHeavy(amount float64) bool {
	if amount <= 0 {
		return false
	}
	return t.Fee/amount >= 0.10
}

// selfTestWithdrawTerms covers the parser against the provider's real messages
// and against the shapes that must be refused.
func selfTestWithdrawTerms() error {
	// The exact message observed on 2026-09-28.
	real := "You selected USDT (BEP-20).\n" +
		"📉 Fee: $0.025\n" +
		"🔢 Minimum withdrawal amount: $0.20"

	got, err := parseWithdrawTerms(real)
	if err != nil {
		return fmt.Errorf("the provider's real message must parse: %w", err)
	}
	if !got.Found {
		return fmt.Errorf("terms must be reported as found")
	}
	if got.Fee != 0.025 {
		return fmt.Errorf("fee = %v, want 0.025", got.Fee)
	}
	if got.Minimum != 0.20 {
		return fmt.Errorf("minimum = %v, want 0.20", got.Minimum)
	}
	if got.Method != "USDT (BEP-20)" {
		return fmt.Errorf("method = %q", got.Method)
	}

	// The second message form, which omits the minimum because it was already
	// given and the bot is asking for an amount.
	amountPrompt := "You selected USDT (BEP-20).\n" +
		"📉 Fee: $0.025\n" +
		"Enter amount:"
	partial, err := parseWithdrawTerms(amountPrompt)
	if err == nil {
		return fmt.Errorf("a message with no minimum must not be reported as complete")
	}
	// The fee is still readable on its own, and the caller may want it.
	if partial.Fee != 0.025 {
		return fmt.Errorf("the fee should still parse from the amount prompt, got %v", partial.Fee)
	}
	if partial.Found {
		return fmt.Errorf("terms must not be marked found without a minimum")
	}

	// A changed fee and minimum must be read, not clamped to the old values.
	// This is the whole point of parsing instead of hardcoding.
	moved := "You selected USDT (BEP-20).\n" +
		"📉 Fee: $0.04\n" +
		"🔢 Minimum withdrawal amount: $0.50"
	got2, err := parseWithdrawTerms(moved)
	if err != nil {
		return fmt.Errorf("a changed fee must parse: %w", err)
	}
	if got2.Fee != 0.04 || got2.Minimum != 0.50 {
		return fmt.Errorf("changed terms not read: %+v", got2)
	}

	// Missing or unusable input must be an error, never a silent zero, because
	// a zero fee or a zero minimum would let a nonsensical withdrawal through.
	for name, bad := range map[string]string{
		"empty":        "",
		"no numbers":   "Choose withdraw method:",
		"fee only":     "Fee: $0.025",
		"zero fee":     "Fee: $0 Minimum withdrawal amount: $0.20",
		"zero minimum": "Fee: $0.025 Minimum withdrawal amount: $0",
	} {
		if _, err := parseWithdrawTerms(bad); err == nil {
			return fmt.Errorf("%s must be refused, not guessed at", name)
		}
	}

	// The currency symbol is presentation, not fact, so a message without it
	// must still be read rather than refused. Same for the emoji and the word
	// "amount", both of which the provider is free to change.
	noSymbol := "You selected USDT (BEP-20).\n" +
		"Fee: 0.025\n" +
		"Minimum withdrawal amount: 0.20"
	got3, err := parseWithdrawTerms(noSymbol)
	if err != nil {
		return fmt.Errorf("a message without a currency symbol must still parse: %w", err)
	}
	if got3.Fee != 0.025 || got3.Minimum != 0.20 {
		return fmt.Errorf("symbol-free terms not read: %+v", got3)
	}

	// Net arithmetic must mirror the provider: the fee comes out of the amount.
	t := withdrawTerms{Fee: 0.025, Minimum: 0.20, Found: true}
	if n := t.net(0.375); n < 0.3499 || n > 0.3501 {
		return fmt.Errorf("net(0.375) = %v, want 0.350", n)
	}
	// Sending the minimum yields the smallest possible payout, where the fee is
	// 12.5%, and that must be visible rather than hidden.
	if !t.feeIsHeavy(0.20) {
		return fmt.Errorf("a 12.5%% fee on the minimum must be reported as heavy")
	}
	if t.feeIsHeavy(10) {
		return fmt.Errorf("a 0.25%% fee on 10 dollars must not be reported as heavy")
	}
	return nil
}
