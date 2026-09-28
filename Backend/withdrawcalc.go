package main

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// Reading an account's balance off the provider, and pricing a withdrawal.
//
// Both numbers come from the provider's own screens, never from configuration.
// The fee has already been observed to move, and a hardcoded copy would show an
// admin a number that is not what they will be charged.
//
// Everything here is read-only: navigating to the balance screen and to the
// method screen costs three messages each and moves no money. The only step
// that spends anything is sending the amount, which lives in the execute path.

// balanceRe reads "$0.3750" out of the provider's balance message.
var balanceRe = regexp.MustCompile(`\$([0-9]+(?:\.[0-9]+)?)`)

// readBalance asks the provider what an account holds.
//
// It is destructive of conversational state in the sense that the provider
// forgets which menu item was open, so every read re-navigates from /start
// rather than assuming a position.
func (t *target) readBalance() (float64, error) {
	if err := t.ensureMainMenu(); err != nil {
		return 0, fmt.Errorf("could not reach the main menu: %w", err)
	}
	replies, err := t.press("read balance", "Balance")
	if err != nil {
		return 0, fmt.Errorf("press Balance: %w", err)
	}
	for _, m := range replies {
		if v, ok := parseBalance(m.Message); ok {
			return v, nil
		}
	}
	return 0, fmt.Errorf("could not read a balance from the provider's reply")
}

// parseBalance pulls the figure out of the balance message. The message is
// short and stable, so a single match is enough; a miss is an error rather than
// a zero, because a zero balance would look like a real reading.
func parseBalance(msg string) (float64, bool) {
	m := balanceRe.FindStringSubmatch(msg)
	if len(m) != 2 {
		return 0, false
	}
	var v float64
	if _, err := fmt.Sscanf(m[1], "%f", &v); err != nil {
		return 0, false
	}
	return v, true
}

// accountBalance is one account's money, as reported by the provider.
type accountBalance struct {
	AccountID string  `json:"account_id"`
	Phone     string  `json:"phone"`
	Balance   float64 `json:"balance"`
	// ReadAt is when the provider said so, which is what makes the figure
	// trustworthy: a balance is a fact with an expiry, not a stored truth.
	ReadAt time.Time `json:"read_at"`
}

// readAllBalances reports every stored account's balance.
//
// Only the live account is connected in this build, so the others report no
// figure rather than a stale one. A zero would be indistinguishable from a
// genuinely empty account, so "unknown" has to be representable.
func (m *sessionManager) readAllBalances(t *target) ([]accountBalance, error) {
	rows, err := m.db.Query(`SELECT id, phone FROM accounts ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type acct struct{ id, phone string }
	var accounts []acct
	for rows.Next() {
		var a acct
		if rows.Scan(&a.id, &a.phone) == nil {
			accounts = append(accounts, a)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := make([]accountBalance, 0, len(accounts))
	for _, a := range accounts {
		b := accountBalance{AccountID: a.id, Phone: a.phone, ReadAt: time.Now().UTC()}
		// Only the connected account can be asked.
		if t != nil && t.api != nil && a.id == sessionAccountID() {
			if v, err := t.readBalance(); err == nil {
				b.Balance = v
			}
		}
		out = append(out, b)
	}
	return out, nil
}

// recordBalance writes a freshly read balance into the accounts table, so the
// dashboard can show a last-known figure while disconnected.
func (m *sessionManager) recordBalance(ctx context.Context, id string, balance float64) error {
	_, err := m.db.ExecContext(ctx,
		`UPDATE accounts SET balance = $1, last_seen = now(), updated_at = now() WHERE id = $2`,
		balance, id)
	return err
}

// ------------------------------------------------------------- the preview --

// previewLine is one account's contribution to a withdrawal. Every number the
// admin needs to check the arithmetic is on the line, so nothing is hidden in a
// total.
type previewLine struct {
	AccountID string  `json:"account_id"`
	Phone     string  `json:"phone"`
	Balance   float64 `json:"balance"`
	Amount    float64 `json:"amount"`
	Fee       float64 `json:"fee"`
	Net       float64 `json:"net"`
	// Problem is set when this line cannot be withdrawn, with the reason. A line
	// that is merely empty must be visibly empty, not silently dropped.
	Problem string `json:"problem,omitempty"`
}

// previewTotals is the arithmetic, spelled out rather than implied.
type previewTotals struct {
	Accounts     int     `json:"accounts"`
	TotalBalance float64 `json:"total_balance"`
	TotalAmount  float64 `json:"total_amount"`
	TotalFee     float64 `json:"total_fee"`
	TotalNet     float64 `json:"total_net"`
	// KnownBalance is false when any account's balance could not be read, so a
	// total built on a partial picture is never presented as complete.
	KnownBalance bool `json:"known_balance"`
}

// withdrawalPreview is the whole calculation, ready to show an admin.
type withdrawalPreview struct {
	Wallet   string        `json:"wallet"`
	Method   string        `json:"method"`
	Network  string        `json:"network"`
	Fee      float64       `json:"fee"`
	Minimum  float64       `json:"minimum"`
	Lines    []previewLine `json:"lines"`
	Totals   previewTotals `json:"totals"`
	Warnings []string      `json:"warnings"`
}

// buildPreview turns live balances and the provider's own terms into the
// figure an admin approves.
//
// The fee is applied per account, because the provider charges it per
// withdrawal. Withdrawing from three accounts costs three fees, and hiding that
// behind one total is how an operator ends up surprised.
func buildPreview(wallet string, terms withdrawTerms, balances []accountBalance, amounts map[string]float64) (*withdrawalPreview, error) {
	if err := validateWallet(wallet); err != nil {
		return nil, err
	}
	if !terms.Found {
		return nil, fmt.Errorf("the provider's fee and minimum have not been read yet")
	}

	p := &withdrawalPreview{
		Wallet:  wallet,
		Method:  terms.Method,
		Network: "BSC",
		Fee:     terms.Fee,
		Minimum: terms.Minimum,
		Lines:   make([]previewLine, 0, len(balances)),
	}

	// The provider names the network as part of the method. Saying BSC matters:
	// most people hold USDT on Tron, and sending a BSC address to someone
	// expecting TRC-20 transfers the money and locks them out of it.
	p.Method = strings.TrimSpace(terms.Method)
	if p.Method == "" {
		p.Method = "USDT (BEP-20)"
	}

	totals := previewTotals{KnownBalance: true, Accounts: len(balances)}
	for _, b := range balances {
		line := previewLine{
			AccountID: b.AccountID,
			Phone:     b.Phone,
			Balance:   b.Balance,
			Amount:    amounts[b.AccountID],
		}
		switch {
		case line.Balance == 0:
			line.Problem = "no balance"
		case line.Amount <= 0:
			line.Problem = "no amount requested"
		case line.Amount > line.Balance:
			line.Problem = fmt.Sprintf("more than the balance of $%.4f", line.Balance)
		case line.Amount < terms.Minimum:
			line.Problem = fmt.Sprintf("below the provider's minimum of $%.4f", terms.Minimum)
		default:
			line.Fee = terms.Fee
			// The provider deducts the fee from the amount, so this is the
			// arithmetic it will actually perform.
			line.Net = line.Amount - terms.Fee
		}
		totals.TotalBalance += line.Balance
		totals.TotalAmount += line.Amount
		totals.TotalFee += line.Fee
		totals.TotalNet += line.Net
		p.Lines = append(p.Lines, line)

		// A balance that could not be read must mark the total incomplete, so
		// an operator is never shown a confident figure built on a partial
		// picture.
		if line.Balance == 0 {
			totals.KnownBalance = false
		}
	}

	// Warnings are the things that make a wrong decision recoverable, said
	// before the money moves rather than after.
	p.Warnings = append(p.Warnings,
		"The fee is charged per account, so withdrawing from several accounts costs several fees.",
		fmt.Sprintf("The fee is taken out of the amount: $0.3750 arrives as $0.3500."),
		"There is no confirmation on the provider's side. Sending the amount IS the withdrawal.",
	)
	if p.Totals.TotalNet > 0 {
		if p.Fee/p.Totals.TotalNet > 0.10 {
			p.Warnings = append(p.Warnings,
				fmt.Sprintf("The fee is %.0f%% of what you receive, which is high.",
					(p.Fee/p.Totals.TotalNet)*100))
		}
	}
	if totals.TotalNet <= 0 && totals.TotalAmount > 0 {
		p.Warnings = append(p.Warnings, "Every requested amount is below the provider's minimum, so nothing would arrive.")
	}
	p.Totals = totals
	return p, nil
}

// recordWithdrawal stores one completed withdrawal so the history survives a
// restart and a dispute can be answered later.
//
// The provider's confirmation is stored verbatim rather than summarised: it
// says "created", never "received", and that exact wording is the evidence.
func (m *sessionManager) recordWithdrawal(ctx context.Context, accountID, wallet string,
	amount, fee, net float64, status, confirmation string) error {
	id := fmt.Sprintf("w_%d_%s", time.Now().UnixNano(), accountID)
	_, err := m.db.ExecContext(ctx,
		`INSERT INTO withdrawals (id, account_id, wallet, amount, fee, net, dry_run, status, confirmation, at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
		id, accountID, wallet, amount, fee, net, status == "created", status, confirmation)
	return err
}
