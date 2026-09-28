package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Price watching: notice when a job's price moves, when it appears, and when
// it disappears, then tell the operator.
//
// Three states, not two, because on this provider a job can simply be absent.
// "Absent" is not "free" and not "changed price", and treating it as either
// would either spam alerts or hide a real supply change.

// watchState is the last known price of every job, persisted so a restart does
// not treat every current price as a change.
type watchState struct {
	// Prices maps job name to price. A name absent from this map was not in
	// the list when last seen, which is different from being priced at 0.
	Prices    map[string]float64 `json:"prices"`
	UpdatedAt time.Time          `json:"updated_at"`
}

func (w *watchState) normalise() {
	if w.Prices == nil {
		w.Prices = map[string]float64{}
	}
}

// notifier is where an alert goes. Telegram is the default because it costs
// nothing and is instant; SMS would need a paid gateway and a phone number.
type notifier interface {
	notify(text string) error
}

// botNotifier sends alerts over Telegram.
//
// Recipients are admins only. An alert states the provider's price, which is
// this bridge's cost and the whole basis of its margin, so it must never reach
// an end user's chat. A failed send is counted, not retried in a loop, because
// hammering a chat that will never accept the message is just noise.
type botNotifier struct {
	bot       *botClient
	admins    []int64
	a         *audit
	delivered int
	failed    int
}

func (n *botNotifier) notify(text string) error {
	if len(n.admins) == 0 {
		return fmt.Errorf("no admins configured, alert dropped: %s", truncate(text, 80))
	}
	var firstErr error
	for _, id := range n.admins {
		n.a.log(legBotToUser, "alert", id, text, map[string]string{"to": "admin"})
		if err := n.bot.sendMessage(id, text, nil); err != nil {
			n.failed++
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		n.delivered++
	}
	if firstErr != nil && n.delivered == 0 {
		return firstErr
	}
	return nil
}

type watcher struct {
	audit     *audit
	note      notifier
	path      string
	availPath string
	every     time.Duration
	// watchFor is the job the operator cares about. Empty means all of them.
	watchFor string
	// subject names the job we sell, used in availability alerts.
	subject string
}

func newWatcher(outDir string, a *audit, note notifier, every time.Duration, watchFor, subject string) *watcher {
	return &watcher{
		audit:     a,
		note:      note,
		path:      filepath.Join(outDir, "prices.json"),
		availPath: filepath.Join(outDir, "availability.json"),
		every:     every,
		watchFor:  strings.TrimSpace(watchFor),
		subject:   strings.TrimSpace(subject),
	}
}

func (w *watcher) load() watchState {
	var st watchState
	st.normalise()
	raw, err := os.ReadFile(w.path)
	if err != nil || len(raw) == 0 {
		return st
	}
	// A corrupt baseline is discarded rather than fatal: the worst case is
	// one round of "everything changed" alerts, which is better than a
	// watcher that silently never reports again.
	if err := json.Unmarshal(raw, &st); err != nil {
		w.audit.log(legInternal, "watch-error", 0,
			"price baseline unreadable, starting fresh: "+err.Error(), nil)
		return watchState{Prices: map[string]float64{}}
	}
	st.normalise()
	return st
}

func (w *watcher) save(st watchState) error {
	raw, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	tmp := w.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, w.path)
}

// change is one detected difference against the previous snapshot.
type change struct {
	Job     string
	Before  float64
	After   float64
	Kind    string // "appeared", "gone", "price"
	Percent string
}

// compare returns the differences between the previous snapshot and now.
// An empty previous map means this is the first snapshot: it is recorded
// silently rather than announced as every job appearing at once.
func compare(prev map[string]float64, now map[string]float64) []change {
	var out []change
	first := len(prev) == 0

	for name, price := range now {
		old, seen := prev[name]
		if !seen {
			if !first {
				out = append(out, change{Job: name, After: price, Kind: "appeared"})
			}
			continue
		}
		if old != price {
			out = append(out, change{
				Job: name, Before: old, After: price, Kind: "price",
				Percent: percent(old, price),
			})
		}
	}
	for name, price := range prev {
		if _, still := now[name]; !still {
			out = append(out, change{Job: name, Before: price, Kind: "gone"})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Job < out[j].Job })
	return out
}

// percent renders a signed percentage change, guarding against a zero base.
func percent(before, after float64) string {
	if before == 0 {
		return "n/a"
	}
	delta := (after - before) / before * 100
	return fmt.Sprintf("%+.2f%%", delta)
}

func describe(c change) string {
	switch c.Kind {
	case "appeared":
		return fmt.Sprintf("🆕 %s is available again at $%.4f", c.Job, c.After)
	case "gone":
		return fmt.Sprintf("❌ %s is no longer listed (was $%.4f)", c.Job, c.Before)
	default:
		return fmt.Sprintf("💰 %s price changed $%.4f -> $%.4f (%s)",
			c.Job, c.Before, c.After, c.Percent)
	}
}

// check performs one poll and alerts on any difference.
func (w *watcher) check(ctx context.Context, t *target, cat *catalog) {
	tasks, err := t.fetchTasks("cookie")
	if err != nil {
		w.audit.log(legInternal, "watch-error", 0, "poll failed: "+err.Error(), nil)
		return
	}

	// The availability verdict comes from the fetch above rather than a second
	// one. A poll is three automated messages to the provider and the account
	// is the product, so it is not worth paying for twice. It also has to run
	// before the early returns below, or the very first poll after a deploy
	// would record a price baseline and no availability at all - which is
	// exactly what happened, and it left the dashboard with no cost to show
	// until the next poll fifteen minutes later.
	w.updateAvailability(cat, tasks)

	now := map[string]float64{}
	var summary []string
	for _, task := range tasks {
		now[task.Name] = task.Price
		summary = append(summary, fmt.Sprintf("%s $%.4f", task.Name, task.Price))
	}
	sort.Strings(summary)

	prev := w.load()
	w.audit.log(legInternal, "watch-poll", 0,
		fmt.Sprintf("%d job(s): %s", len(tasks), truncate(strings.Join(summary, " | "), 300)),
		map[string]string{"first": boolText(prev.UpdatedAt.IsZero())})

	changes := compare(prev.Prices, now)

	fresh := watchState{Prices: now, UpdatedAt: time.Now()}
	if err := w.save(fresh); err != nil {
		w.audit.log(legInternal, "watch-error", 0, "could not save baseline: "+err.Error(), nil)
	}

	if prev.UpdatedAt.IsZero() {
		w.audit.log(legInternal, "watch-baseline", 0,
			"first snapshot recorded, no alerts for it", nil)
		return
	}
	if len(changes) == 0 {
		w.audit.log(legInternal, "watch-ok", 0, "no price changes", nil)
		return
	}

	for _, c := range changes {
		if w.watchFor != "" && !strings.Contains(strings.ToLower(c.Job), strings.ToLower(w.watchFor)) {
			continue // only the job the operator asked about
		}
		msg := describe(c)
		w.audit.log(legInternal, "watch-change", 0, msg, map[string]string{
			"job": c.Job, "kind": c.Kind,
		})
		if err := w.note.notify(msg); err != nil {
			w.audit.log(legInternal, "watch-error", 0, "alert failed: "+err.Error(), nil)
		}
	}
}

// checkSupported alerts an admin when the job we actually sell stops being
// offered, or comes back.
//
// This is separate from the price watcher on purpose. A price change is
// interesting; the job vanishing is an outage for this service, and it is
// exactly the event that is easy to miss because everything else still looks
// healthy. The provider drops jobs silently.
// updateAvailability records whether the job we sell is currently offered, and
// alerts an admin when that changes.
//
// It takes the list the price poll already fetched. It used to fetch its own,
// and it used to be called from nowhere at all: the function existed, was
// commented as though it ran every interval, and had no caller. So the
// "job unavailable" alert had never fired, and the snapshot the dashboard reads
// had never been written, which is why every job read as UNAVAILABLE from a
// table nothing populated.
//
// Alerts fire on a transition only. Notifying on every poll would send an
// admin a message every fifteen minutes for as long as a job stays withdrawn.
func (w *watcher) updateAvailability(cat *catalog, live []Task) {
	if cat == nil {
		return
	}
	offers := cat.resolve(live)
	was, _, hadSnapshot := w.availability()

	if len(offers) == 0 {
		w.setAvailability(false, 0)
		// The first poll after a deploy has no previous state, so there is no
		// transition to report. Saying "unavailable" on a cold start is just
		// noise; the snapshot is still written either way.
		if hadSnapshot && was {
			msg := "🚨 " + w.subject + " is NOT available right now. " +
				"The provider is not offering it, so the bot will show no jobs. " +
				"Provider listed: " + truncate(jobNames(live), 200)
			w.audit.log(legInternal, "watch-unavailable", 0, msg, nil)
			if err := w.note.notify(msg); err != nil {
				w.audit.log(legInternal, "watch-error", 0, "alert failed: "+err.Error(), nil)
			}
		} else {
			w.audit.log(legInternal, "watch-unavailable-quiet", 0,
				w.subject+" is not offered by the provider (first observation, no alert sent)",
				nil)
		}
		return
	}

	var sb strings.Builder
	for _, o := range offers {
		fmt.Fprintf(&sb, "%s at %s (provider cost $%.4f)", o.Display, priceLabel(o.SellBDT), o.Provider.Price)
	}
	w.setAvailability(true, offers[0].Provider.Price)
	if hadSnapshot && !was {
		msg := "✅ " + w.subject + " is available again: " + sb.String()
		w.audit.log(legInternal, "watch-available", 0, msg, nil)
		if err := w.note.notify(msg); err != nil {
			w.audit.log(legInternal, "watch-error", 0, "alert failed: "+err.Error(), nil)
		}
	}
}

// availability is the last known state of the job we sell, persisted so a
// restart does not re-announce a state that is already known.
//
// The third return says whether a snapshot existed at all. Without it "the job
// has never been seen" and "the job was available and just went away" look
// identical, and an alert meant for the second fires on the first - on every
// deploy.
func (w *watcher) availability() (available bool, cost float64, known bool) {
	raw, err := os.ReadFile(w.availPath)
	if err != nil {
		return false, 0, false
	}
	var st struct {
		Available bool    `json:"available"`
		Cost      float64 `json:"cost"`
	}
	if err := json.Unmarshal(raw, &st); err != nil {
		return false, 0, false
	}
	return st.Available, st.Cost, true
}

func (w *watcher) setAvailability(available bool, cost float64) {
	raw, err := json.Marshal(map[string]any{
		"available": available,
		"cost":      cost,
		"at":        time.Now().Format(time.RFC3339),
	})
	if err != nil {
		return
	}
	tmp := w.availPath + ".tmp"
	if os.WriteFile(tmp, raw, 0o600) == nil {
		_ = os.Rename(tmp, w.availPath)
	}
}

// run polls until the context ends. The interval is deliberately slow: every
// poll is three automated messages to the provider, and an account that
// automates too eagerly is exactly how an account gets banned.
func (w *watcher) run(ctx context.Context, t *target, cat *catalog) {
	w.check(ctx, t, cat)
	for {
		// A little jitter, so a fixed interval is not a machine signature.
		jitter := time.Duration(time.Now().Unix()%int64(w.every/4)) * time.Second
		select {
		case <-ctx.Done():
			return
		case <-time.After(w.every + jitter):
		}
		w.check(ctx, t, cat)
	}
}

func boolText(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

// envDuration reads a duration in seconds, with a floor so a typo cannot turn
// this into a flood against the provider.
func envDuration(key string, def time.Duration, floor time.Duration) time.Duration {
	secs, err := strconv.Atoi(envOr(key, strconv.Itoa(int(def.Seconds()))))
	if err != nil || time.Duration(secs)*time.Second < floor {
		return def
	}
	return time.Duration(secs) * time.Second
}
