package main

import (
	"strings"
	"testing"
)

// nearly compares money to the four decimal places the provider quotes at.
func nearly(a, b float64) bool {
	d := a - b
	if d < 0 {
		d = -d
	}
	return d < 0.00005
}

// The withdrawal arithmetic is the code that decides how much money leaves and
// how much arrives. These tests are about the numbers an admin is shown, and
// about the cases that must be refused rather than quietly accepted.

func TestParseBalance(t *testing.T) {
	// The provider's real message.
	if v, ok := parseBalance("💰 Your balance: $0.3750"); !ok || v != 0.375 {
		t.Fatalf("balance parse = %v, %v; want 0.375, true", v, ok)
	}
	// A miss must be a miss, not a zero. A zero balance would be
	// indistinguishable from a genuinely empty account, and an admin would see
	// a total that is confidently wrong.
	for _, bad := range []string{"", "no number here", "balance unavailable", "0.3750"} {
		if v, ok := parseBalance(bad); ok {
			t.Errorf("%q parsed as %.4f, want no reading", bad, v)
		}
	}
}

func TestBuildPreviewArithmetic(t *testing.T) {
	// The provider's own observed figures.
	terms := withdrawTerms{Fee: 0.025, Minimum: 0.20, Method: "USDT (BEP-20)", Found: true}
	balances := []accountBalance{
		{AccountID: "a1", Phone: "+8801", Balance: 0.375},
		{AccountID: "a2", Phone: "+8802", Balance: 1.000},
	}
	amounts := map[string]float64{"a1": 0.375, "a2": 0.500}

	p, err := buildPreview("0x1111111111111111111111111111111111111111", terms, balances, amounts)
	if err != nil {
		t.Fatalf("buildPreview: %v", err)
	}

	// Per line: the fee comes out of the amount, matching the provider.
	if len(p.Lines) != 2 {
		t.Fatalf("expected 2 lines, got %d", len(p.Lines))
	}
	if p.Lines[0].Net != 0.350 {
		t.Errorf("line 0 net = %.4f, want 0.3500", p.Lines[0].Net)
	}
	if p.Lines[1].Net != 0.475 {
		t.Errorf("line 1 net = %.4f, want 0.4750", p.Lines[1].Net)
	}

	// Totals must add up, or the summary is a lie.
	want := map[string]float64{
		"TotalBalance": 1.375, "TotalAmount": 0.875,
		"TotalFee": 0.050, "TotalNet": 0.825,
	}
	got := map[string]float64{
		"TotalBalance": p.Totals.TotalBalance, "TotalAmount": p.Totals.TotalAmount,
		"TotalFee": p.Totals.TotalFee, "TotalNet": p.Totals.TotalNet,
	}
	for k, w := range want {
		if !nearly(got[k], w) {
			t.Errorf("%s = %.4f, want %.4f", k, got[k], w)
		}
	}
	if p.Totals.Accounts != 2 {
		t.Errorf("Accounts = %d", p.Totals.Accounts)
	}

	// The network must be stated. Most people hold USDT on Tron, and a BSC
	// address sent to someone expecting TRC-20 arrives and is unreachable.
	if p.Network != "BSC" {
		t.Errorf("network = %q, want BSC", p.Network)
	}
	if len(p.Warnings) == 0 {
		t.Error("a preview that moves money must carry warnings")
	}
}

func TestBuildPreviewRefusesBadInput(t *testing.T) {
	terms := withdrawTerms{Fee: 0.025, Minimum: 0.20, Method: "USDT (BEP-20)", Found: true}
	const good = "0x1111111111111111111111111111111111111111"
	balances := []accountBalance{{AccountID: "a1", Phone: "+8801", Balance: 0.375}}

	// A bad wallet must be refused outright, before any provider navigation.
	if _, err := buildPreview("TQn-not-a-bep20-address", terms, balances,
		map[string]float64{"a1": 0.2}); err == nil {
		t.Error("a Tron address must be refused")
	}
	// Terms the provider has not stated must not be invented.
	if _, err := buildPreview(good, withdrawTerms{}, balances,
		map[string]float64{"a1": 0.2}); err == nil {
		t.Error("missing terms must be an error, not a zero fee")
	}
}

func TestBuildPreviewFlagsEveryBadLine(t *testing.T) {
	terms := withdrawTerms{Fee: 0.025, Minimum: 0.20, Found: true}
	const good = "0x1111111111111111111111111111111111111111"

	cases := []struct {
		name    string
		balance float64
		amount  float64
		problem string
	}{
		{"empty account", 0, 0.2, "no balance"},
		{"no amount asked", 0.375, 0, "no amount requested"},
		{"more than the balance", 0.1, 0.5, "more than the balance"},
		{"below the provider minimum", 0.375, 0.05, "below the provider's minimum"},
	}
	for _, c := range cases {
		p, err := buildPreview(good, terms,
			[]accountBalance{{AccountID: "a1", Balance: c.balance}},
			map[string]float64{"a1": c.amount})
		if err != nil {
			t.Errorf("%s: buildPreview returned an error instead of flagging the line: %v", c.name, err)
			continue
		}
		// The message names the figure as well as the reason, which is more
		// useful to an operator, so the check is on the reason within it.
		if !strings.Contains(p.Lines[0].Problem, c.problem) {
			t.Errorf("%s: problem = %q, want it to contain %q", c.name, p.Lines[0].Problem, c.problem)
		}
		// A flagged line must contribute nothing to the money totals, or the
		// summary would promise money that will not arrive.
		if p.Totals.TotalNet != 0 {
			t.Errorf("%s: a refused line added %.4f to the net total", c.name, p.Totals.TotalNet)
		}
	}

	// An unreadable balance means the total is incomplete, and saying so is the
	// difference between an operator checking and an operator guessing.
	p, _ := buildPreview(good, terms,
		[]accountBalance{{AccountID: "a1", Balance: 0}},
		map[string]float64{"a1": 0.2})
	if p.Totals.KnownBalance {
		t.Error("a total built on an unreadable balance must not claim to be known")
	}
}

func TestFormatAmount(t *testing.T) {
	// The provider accepts a plain decimal. Trailing noise like an exponent
	// would be rejected or, worse, misread.
	for _, c := range []struct {
		in   float64
		want string
	}{
		{0.375, "0.3750"},
		{0.2, "0.2000"},
		{1, "1.0000"},
		{0.0001, "0.0001"},
	} {
		if got := formatAmount(c.in); got != c.want {
			t.Errorf("formatAmount(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestShortWalletNeverLeaksTheMiddle(t *testing.T) {
	const w = "0x2222222222222222222222222222222222222222"
	got := shortWallet(w)
	if len(got) >= len(w) {
		t.Errorf("shortWallet did not shorten: %q", got)
	}
	if !strings.Contains(got, "...") {
		t.Errorf("shortWallet = %q, want an elision", got)
	}
	// Enough to identify, not enough to use.
	if len(got) > 20 {
		t.Errorf("shortWallet = %q is long enough to be worth avoiding", got)
	}
}
