package main

// Availability alerting had a function, a comment describing when it ran, and no
// caller. The "job unavailable" alert had therefore never fired, and the
// snapshot the dashboard reads had never been written - which is why every job
// read as UNAVAILABLE out of a table nothing populated.
//
// These tests pin the behaviour that was missing: the snapshot is written on
// every poll, and an admin is told only when the state actually changes.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// recorder collects the alerts a notifier was asked to send.
type recorder struct{ sent []string }

func (r *recorder) notify(text string) error {
	r.sent = append(r.sent, text)
	return nil
}

// testWatcher builds a watcher writing into dir, with alerts captured.
func testWatcher(t *testing.T, dir string) (*watcher, *recorder) {
	t.Helper()
	rec := &recorder{}
	a := newAudit(dir)
	t.Cleanup(func() { _ = a.Close() })
	return newWatcher(dir, a, rec, 15*time.Minute, "2FA:Create FB", "Facebook 2fa"), rec
}

func testCatalog(t *testing.T, dir string) *catalog {
	t.Helper()
	raw, err := os.ReadFile("task.json")
	if err != nil {
		t.Fatalf("read task.json: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "task.json"), raw, 0o600); err != nil {
		t.Fatalf("copy task.json: %v", err)
	}
	cat, err := loadCatalog(filepath.Join(dir, "task.json"))
	if err != nil {
		t.Fatalf("catalogue: %v", err)
	}
	return cat
}

// snapshot reads back what the watcher persisted.
func snapshot(t *testing.T, w *watcher) (available bool, cost float64, known bool) {
	t.Helper()
	raw, err := os.ReadFile(w.availPath)
	if err != nil {
		t.Fatalf("no snapshot was written, which is the whole bug: %v", err)
	}
	var st struct {
		Available bool    `json:"available"`
		Cost      float64 `json:"cost"`
		At        string  `json:"at"`
	}
	if err := json.Unmarshal(raw, &st); err != nil {
		t.Fatalf("snapshot is not json: %v", err)
	}
	if st.At == "" {
		t.Error("snapshot has no timestamp, so the API will treat the cost as unknown")
	}
	return st.Available, st.Cost, true
}

// withdrawn is the provider's list as it actually is now: the job we sell is not
// in it. Note the decoy, which is the other product and must not match.
var withdrawn = []Task{
	{Name: "Create FB (2FA)", Price: 0.0480},
	{Name: "Create Twitter", Price: 0.0260},
}

var offered = []Task{
	{Name: "2FA:Create FB (No mail)", Price: 0.0480},
	{Name: "Create FB (2FA)", Price: 0.0480},
}

func TestSnapshotIsWrittenOnTheFirstPoll(t *testing.T) {
	dir := t.TempDir()
	w, rec := testWatcher(t, dir)
	cat := testCatalog(t, dir)

	w.updateAvailability(cat, withdrawn)

	avail, _, known := snapshot(t, w)
	if !known {
		t.Fatal("snapshot is not known")
	}
	if avail {
		t.Error("available = true, but the provider is not offering the job")
	}
	if len(rec.sent) != 0 {
		t.Errorf("sent %d alert(s) on a first observation: %v", len(rec.sent), rec.sent)
	}
}

func TestCostIsRecordedWhenTheJobIsOffered(t *testing.T) {
	dir := t.TempDir()
	w, _ := testWatcher(t, dir)
	cat := testCatalog(t, dir)

	w.updateAvailability(cat, withdrawn)
	w.updateAvailability(cat, offered)

	avail, cost, _ := snapshot(t, w)
	if !avail {
		t.Error("available = false after the job was offered")
	}
	if cost != 0.0480 {
		t.Errorf("cost = %v, want 0.0480 - the dashboard shows this as our cost", cost)
	}
}

func TestAlertsFireOnlyOnTransitions(t *testing.T) {
	dir := t.TempDir()
	w, rec := testWatcher(t, dir)
	cat := testCatalog(t, dir)

	// Cold start, job withdrawn: no alert.
	w.updateAvailability(cat, withdrawn)
	if len(rec.sent) != 0 {
		t.Fatalf("alerted on a cold start: %v", rec.sent)
	}

	// It appears: that is a transition and must be reported.
	w.updateAvailability(cat, offered)
	if len(rec.sent) != 1 {
		t.Fatalf("available-again alert = %d, want 1 (%v)", len(rec.sent), rec.sent)
	}

	// Still offered: nothing changed, so nothing is sent. Otherwise an admin
	// would be messaged every fifteen minutes for as long as a job is live.
	for i := 0; i < 3; i++ {
		w.updateAvailability(cat, offered)
	}
	if len(rec.sent) != 1 {
		t.Errorf("after 3 unchanged polls there are %d alerts, want 1: %v", len(rec.sent), rec.sent)
	}

	// It vanishes: a real transition.
	w.updateAvailability(cat, withdrawn)
	if len(rec.sent) != 2 {
		t.Fatalf("unavailable alert = %d, want 2 (%v)", len(rec.sent), rec.sent)
	}
	if got := rec.sent[1]; got == "" {
		t.Error("the unavailable alert is empty")
	}

	// Still gone: silent.
	for i := 0; i < 3; i++ {
		w.updateAvailability(cat, withdrawn)
	}
	if len(rec.sent) != 2 {
		t.Errorf("after 3 unchanged withdrawn polls there are %d alerts, want 2: %v", len(rec.sent), rec.sent)
	}
}

// TestTheDecoyJobDoesNotCountAsOurJob guards rule 6 through this path too:
// Create FB (2FA) is a different product and must not satisfy the catalogue.
func TestTheDecoyJobDoesNotCountAsOurJob(t *testing.T) {
	dir := t.TempDir()
	w, _ := testWatcher(t, dir)
	cat := testCatalog(t, dir)

	w.updateAvailability(cat, withdrawn)

	if avail, _, _ := snapshot(t, w); avail {
		t.Error("the catalogue matched Create FB (2FA), which is a different product")
	}
}
