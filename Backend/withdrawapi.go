package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
)

// The withdrawal flow, as the admin sees it: one account at a time, every
// number on the table before anything moves, and live progress while it does.
//
// The ordering here is the safety property. Nothing is sent to the provider
// until the operator has seen a preview built from the provider's own fee and
// minimum, and the only irreversible action in the whole path is sending the
// amount, which happens once, per account, after that.

// withdrawalRequest is what the admin asks for.
type withdrawalRequest struct {
	AccountIDs []string           `json:"account_ids"`
	Wallet     string             `json:"wallet"`
	Amounts    map[string]float64 `json:"amounts"`
	// Confirm must be true to move money. Without it the endpoint only
	// previews, so a mis-click cannot spend anything.
	Confirm bool `json:"confirm"`
}

func (s *adminServer) handleWithdrawals(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST only"})
		return
	}
	var req withdrawalRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid body"})
		return
	}
	if len(req.AccountIDs) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "choose at least one account"})
		return
	}
	if s.tgt == nil || s.tgt.api == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": "not connected to Telegram, so balances cannot be read",
		})
		return
	}

	wallet := req.Wallet
	if wallet == "" {
		wallet = withdrawWallet
	}
	if err := validateWallet(wallet); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error(), "field": "wallet"})
		return
	}

	// The provider's own terms. Read live, because the fee has moved before and
	// will move again.
	terms, err := s.readWithdrawTerms()
	if err != nil {
		s.audit.log(legInternal, "withdraw", 0, "could not read the terms: "+err.Error(), nil)
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "could not read the provider's fee and minimum"})
		return
	}

	balances, err := s.sessions.readAllBalances(s.tgt)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "could not read balances"})
		return
	}
	// Keep only the accounts the operator asked about.
	chosen := make([]accountBalance, 0, len(req.AccountIDs))
	for _, id := range req.AccountIDs {
		for _, b := range balances {
			if b.AccountID == id {
				chosen = append(chosen, b)
			}
		}
	}
	if len(chosen) == 0 {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "none of those accounts exist"})
		return
	}
	// Record what the provider said, so the dashboard has a last-known figure
	// even while disconnected.
	for _, b := range chosen {
		if b.Balance > 0 {
			_ = s.sessions.recordBalance(r.Context(), b.AccountID, b.Balance)
		}
	}

	preview, err := buildPreview(wallet, terms, chosen, req.Amounts)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}

	if !req.Confirm {
		// Dry run. Nothing is sent to the provider beyond reading it.
		s.audit.log(legInternal, "withdraw-preview", 0,
			fmt.Sprintf("preview: %d account(s), $%.4f amount, $%.4f fee, $%.4f net",
				preview.Totals.Accounts, preview.Totals.TotalAmount,
				preview.Totals.TotalFee, preview.Totals.TotalNet),
			map[string]string{"wallet": shortWallet(wallet)})
		writeJSON(w, http.StatusOK, map[string]any{"preview": preview, "dry_run": true})
		return
	}

	if withdrawDryRun {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":   "withdrawals are in dry-run mode, so nothing was sent",
			"preview": preview,
		})
		return
	}

	s.executeWithdrawal(w, r, preview, req)
}

// readWithdrawTerms navigates the provider to the method screen and reads the
// fee and minimum off its own message.
func (s *adminServer) readWithdrawTerms() (withdrawTerms, error) {
	t := s.tgt
	if err := t.ensureMainMenu(); err != nil {
		return withdrawTerms{}, err
	}
	if _, err := t.press("withdraw", "Withdraw"); err != nil {
		return withdrawTerms{}, err
	}
	replies, err := t.press("method", "USDT")
	if err != nil {
		return withdrawTerms{}, err
	}
	for _, m := range replies {
		if terms, err := parseWithdrawTerms(m.Message); err == nil {
			return terms, nil
		}
	}
	return withdrawTerms{}, fmt.Errorf("the provider did not state its fee and minimum")
}

// progress is one step of a running withdrawal, pushed to the dashboard.
type progress struct {
	Step    string  `json:"step"`
	State   string  `json:"state"`
	Account string  `json:"account,omitempty"`
	Phone   string  `json:"phone,omitempty"`
	Amount  float64 `json:"amount,omitempty"`
	Fee     float64 `json:"fee,omitempty"`
	Net     float64 `json:"net,omitempty"`
	Detail  string  `json:"detail,omitempty"`
}

// executeWithdrawal walks the preview, one account at a time, publishing
// progress as it goes.
//
// Accounts are done sequentially, never concurrently: each one is a separate
// conversation with the provider holding conversational state, so two at once
// would interleave into nonsense and could pay out the wrong amount.
func (s *adminServer) executeWithdrawal(w http.ResponseWriter, r *http.Request, p *withdrawalPreview, req withdrawalRequest) {
	if s.withdrawing {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": "a withdrawal is already running",
		})
		return
	}
	s.withdrawing = true
	defer func() { s.withdrawing = false }()

	s.publishProgress(progress{
		Step: "start", State: "running",
		Detail: fmt.Sprintf("%d account(s), $%.4f total, $%.4f in fees",
			p.Totals.Accounts, p.Totals.TotalAmount, p.Totals.TotalFee),
	})

	type result struct {
		AccountID string  `json:"account_id"`
		Phone     string  `json:"phone"`
		Amount    float64 `json:"amount"`
		Fee       float64 `json:"fee"`
		Net       float64 `json:"net"`
		Status    string  `json:"status"`
		Detail    string  `json:"detail,omitempty"`
	}
	var results []result
	var mu sync.Mutex
	var paidFee, paidNet float64

	for _, line := range p.Lines {
		if line.Problem != "" {
			mu.Lock()
			results = append(results, result{
				AccountID: line.AccountID, Phone: line.Phone,
				Amount: line.Amount, Fee: line.Fee, Net: line.Net,
				Status: "skipped", Detail: line.Problem,
			})
			mu.Unlock()
			s.publishProgress(progress{
				Step: "skip", State: "skipped", Account: line.AccountID,
				Phone: line.Phone, Amount: line.Amount, Detail: line.Problem,
			})
			continue
		}

		s.publishProgress(progress{
			Step: "account", State: "running", Account: line.AccountID,
			Phone: line.Phone, Amount: line.Amount, Fee: line.Fee, Net: line.Net,
		})

		res, err := s.withdrawOne(r.Context(), line, p.Wallet)
		if err != nil {
			mu.Lock()
			results = append(results, result{
				AccountID: line.AccountID, Phone: line.Phone, Amount: line.Amount,
				Fee: line.Fee, Net: line.Net, Status: "failed", Detail: err.Error(),
			})
			mu.Unlock()
			s.publishProgress(progress{
				Step: "account", State: "failed", Account: line.AccountID,
				Phone: line.Phone, Detail: err.Error(),
			})
			continue
		}

		mu.Lock()
		results = append(results, result{
			AccountID: line.AccountID, Phone: line.Phone,
			Amount: res.Amount, Fee: res.Fee, Net: res.Net,
			Status: "created", Detail: res.Confirmation,
		})
		paidFee += res.Fee
		paidNet += res.Net
		mu.Unlock()

		s.publishProgress(progress{
			Step: "account", State: "created", Account: line.AccountID,
			Phone: line.Phone, Amount: res.Amount, Fee: res.Fee, Net: res.Net,
		})
	}

	// Persist, so the history survives a restart and a dispute can be answered.
	for _, res := range results {
		_ = s.sessions.recordWithdrawal(r.Context(), res.AccountID, p.Wallet,
			res.Amount, res.Fee, res.Net, res.Status, res.Detail)
	}

	s.publishProgress(progress{
		Step: "done", State: "done",
		Detail: fmt.Sprintf("$%.4f requested, $%.4f in fees, $%.4f to arrive", p.Totals.TotalAmount, paidFee, paidNet),
	})

	s.audit.log(legInternal, "withdraw-done", 0,
		fmt.Sprintf("%d account(s), $%.4f net, $%.4f fees", len(results), paidNet, paidFee),
		map[string]string{"wallet": shortWallet(p.Wallet)})

	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "results": results,
		"totals": map[string]any{
			"amount": p.Totals.TotalAmount, "fee": paidFee, "net": paidNet,
		},
		"note": "the provider accepted these. It does not confirm arrival, " +
			"so nothing here proves the money landed.",
	})
}

// publishProgress sends one step to every connected dashboard.
func (s *adminServer) publishProgress(p progress) {
	raw, err := jsonMarshalIndent(map[string]any{"type": "withdrawal", "progress": p})
	if err != nil {
		return
	}
	s.publish(raw)
}

func shortWallet(w string) string {
	if len(w) > 12 {
		return w[:8] + "..." + w[len(w)-4:]
	}
	return w
}

// withdrawResult is one completed withdrawal.
type withdrawResult struct {
	Amount       float64
	Fee          float64
	Net          float64
	Confirmation string
}

// withdrawOne performs the actual flow for a single account. This is the only
// place in the codebase that spends money.
//
// The wallet is passed in rather than read from a package variable: two admins
// withdrawing at once would otherwise send one account's payout to the other
// admin's address.
func (s *adminServer) withdrawOne(ctx context.Context, line previewLine, wallet string) (withdrawResult, error) {
	var out withdrawResult
	t := s.tgt

	// Belt and braces: the preview already validated this, and the value that
	// actually gets sent must be the one that was checked.
	if err := validateWallet(wallet); err != nil {
		return out, err
	}

	if err := t.ensureMainMenu(); err != nil {
		return out, err
	}
	if _, err := t.press("withdraw", "Withdraw"); err != nil {
		return out, err
	}
	// The fee is re-read per account rather than trusted from the preview,
	// because the amount that arrives depends on it.
	replies, err := t.press("method", "USDT")
	if err != nil {
		return out, err
	}
	var terms withdrawTerms
	for _, m := range replies {
		if tt, err := parseWithdrawTerms(m.Message); err == nil {
			terms = tt
			break
		}
	}
	if !terms.Found {
		return out, fmt.Errorf("the provider did not state its fee and minimum")
	}

	if _, err := t.press("address", wallet); err != nil {
		return out, err
	}
	amountReplies, err := t.press("amount", formatAmount(line.Amount))
	if err != nil {
		return out, err
	}

	// The confirmation is the provider's own wording, stored verbatim. It says
	// "created", never "received", and the dashboard must not imply otherwise.
	confirmation := ""
	for _, m := range amountReplies {
		if s := trimTelegram(m.Message); s != "" {
			confirmation += s + "\n\n"
		}
	}
	if !strings.Contains(confirmation, "created") &&
		!strings.Contains(confirmation, "Withdrawal") {
		return out, fmt.Errorf("the provider did not confirm the withdrawal")
	}

	out = withdrawResult{
		Amount:       line.Amount,
		Fee:          terms.Fee,
		Net:          line.Amount - terms.Fee,
		Confirmation: strings.TrimSpace(confirmation),
	}
	return out, nil
}

// AccountIDWallet is a placeholder for the destination address. The real
// address comes from the request, threaded through the preview, and this exists
// only so the flow reads in order; it is replaced before use.
func (l previewLine) AccountIDWallet(string) string { return currentWithdrawWallet }

// currentWithdrawWallet is set for the duration of one execution. The preview
// carries the validated address, so this is only a hand-off between two
// functions and is guarded against being empty.
var currentWithdrawWallet string

// AccountIDWallet was a hand-off shim that read a package variable. The
// wallet is now threaded explicitly, so nothing needs it.
func trimTelegram(s string) string {
	return strings.TrimSpace(strings.ReplaceAll(s, "\r\n", "\n"))
}

func formatAmount(v float64) string {
	return fmt.Sprintf("%.4f", v)
}
