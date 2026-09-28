package main

// The Messages page read a `messages` table that nothing has ever inserted
// into, so it was blank from the day it was built while the four-leg transcript
// it should have shown went to the audit file. These tests pin the reader that
// replaced it.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func writeAudit(t *testing.T, dir string, lines ...string) *audit {
	t.Helper()
	a := newAudit(dir)
	if err := a.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	body := ""
	for _, l := range lines {
		body += l + "\n"
	}
	if err := os.WriteFile(a.path, []byte(body), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	return a
}

func line(t *testing.T, ev event) string {
	t.Helper()
	b, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

func TestRecentReturnsNewestFirst(t *testing.T) {
	dir := t.TempDir()
	a := writeAudit(t, dir,
		line(t, event{Time: "10:00:00.000", Leg: legUserToBot, Kind: "text", Text: "first"}),
		line(t, event{Time: "10:00:01.000", Leg: legBotToUser, Kind: "reply", Text: "second"}),
		line(t, event{Time: "10:00:02.000", Leg: legBotToTaskly, Kind: "press", Text: "third"}),
	)

	got := a.recent(10, time.Time{})
	if len(got) != 3 {
		t.Fatalf("got %d items, want 3: %v", len(got), got)
	}
	if got[0]["text"] != "third" {
		t.Errorf("newest first is wrong: got %v at index 0", got[0]["text"])
	}
	if got[2]["text"] != "first" {
		t.Errorf("oldest should be last: got %v", got[2]["text"])
	}
}

func TestRecentShapesMatchWhatThePageRenders(t *testing.T) {
	dir := t.TempDir()
	a := writeAudit(t, dir,
		line(t, event{Time: "13:17:41.469", Leg: legTasklyToBot, Kind: "reply",
			UserID: 1772093705, Text: "Please select a task"}),
	)
	got := a.recent(1, time.Time{})
	if len(got) != 1 {
		t.Fatalf("got %d items", len(got))
	}
	it := got[0]

	// The page reads every one of these; a missing key is a blank column and a
	// null is a crash.
	for _, k := range []string{"id", "account_id", "leg", "direction", "text", "at"} {
		if _, ok := it[k]; !ok {
			t.Errorf("missing key %q", k)
		}
	}
	if _, ok := it["buttons"].([]string); !ok {
		t.Errorf("buttons is %T, want []string", it["buttons"])
	}
	if uid, ok := it["user_id"].(int64); !ok || uid != 1772093705 {
		t.Errorf("user_id = %v (%T), want 1772093705", it["user_id"], it["user_id"])
	}
	// The date comes from the filename and the time from the line, joined into
	// what the page's Date parser expects. Milliseconds are kept: `at` doubles
	// as the ?before= cursor, and two events in the same second would otherwise
	// be indistinguishable to it.
	want := time.Now().UTC().Format("2006-01-02") + "T13:17:41.469Z"
	if at, _ := it["at"].(string); at != want {
		t.Errorf("at = %q, want %q", it["at"], want)
	}
	// taskly->bot is inbound.
	if d, _ := it["direction"].(string); d != "in" {
		t.Errorf("direction = %q, want \"in\"", d)
	}
}

func TestRecentRespectsTheLimit(t *testing.T) {
	dir := t.TempDir()
	var lines []string
	for i := 0; i < 20; i++ {
		lines = append(lines, line(t, event{
			Time: "09:00:00.000", Leg: legUserToBot, Kind: "text",
			Text: string(rune('a' + i)),
		}))
	}
	a := writeAudit(t, dir, lines...)
	if got := a.recent(5, time.Time{}); len(got) != 5 {
		t.Fatalf("got %d items, want 5", len(got))
	}
	if got := a.recent(5, time.Time{})[0]["text"]; got != "t" {
		t.Errorf("newest = %v, want \"t\"", got)
	}
}

func TestRecentSurvivesATornLine(t *testing.T) {
	dir := t.TempDir()
	a := writeAudit(t, dir,
		line(t, event{Time: "10:00:00.000", Leg: legUserToBot, Text: "whole"}),
		`{"ts":"10:00:01.000","leg":"bo`, // a line still being appended to
		line(t, event{Time: "10:00:02.000", Leg: legBotToUser, Text: "also whole"}),
		``,
		`not json at all`,
	)
	got := a.recent(10, time.Time{})
	if len(got) != 2 {
		t.Fatalf("got %d items, want the 2 intact ones: %v", len(got), got)
	}
	if got[0]["text"] != "also whole" {
		t.Errorf("newest = %v", got[0]["text"])
	}
}

func TestRecentOnAnEmptyOrMissingLog(t *testing.T) {
	dir := t.TempDir()
	a := writeAudit(t, dir)
	if got := a.recent(10, time.Time{}); len(got) != 0 {
		t.Errorf("empty log returned %d items", len(got))
	}
	// An audit that never opened has no path, and must not panic.
	var missing *audit
	if got := missing.recent(10, time.Time{}); got != nil {
		t.Errorf("nil audit returned %v", got)
	}
	// A path that does not exist reads as empty, not as an error.
	gone := &audit{path: filepath.Join(dir, "nope.jsonl")}
	if got := gone.recent(10, time.Time{}); got != nil {
		t.Errorf("missing file returned %v", got)
	}
}

// TestBeforeCursorPagesBackwards is the fix for a button that did nothing. The
// page sends ?before=<oldest at it has> and the handler used to ignore it, so
// every click refetched the same newest page for ever.
func TestBeforeCursorPagesBackwards(t *testing.T) {
	dir := t.TempDir()
	var lines []string
	for i := 1; i <= 5; i++ {
		lines = append(lines, line(t, event{
			Time: "10:00:0" + strconv.Itoa(i) + ".000",
			Leg:  legUserToBot, Kind: "text",
			Text: "message " + strconv.Itoa(i),
		}))
	}
	a := writeAudit(t, dir, lines...)

	// The first page, newest 2.
	page1 := a.recent(2, time.Time{})
	if len(page1) != 2 {
		t.Fatalf("page 1 has %d items, want 2", len(page1))
	}
	if page1[0]["text"] != "message 5" {
		t.Errorf("page 1 newest = %v, want message 5", page1[0]["text"])
	}
	// Newest first.
	if page1[1]["text"] != "message 4" {
		t.Errorf("page 1 second = %v, want message 4", page1[1]["text"])
	}

	// The cursor is the oldest `at` on the page just fetched.
	cursor, _ := page1[1]["at"].(string)
	when, err := time.Parse(time.RFC3339Nano, cursor)
	if err != nil {
		t.Fatalf("cursor %q does not parse: %v", cursor, err)
	}

	page2 := a.recent(2, when)
	if len(page2) != 2 {
		t.Fatalf("page 2 has %d items, want 2: %v", len(page2), page2)
	}
	// Strictly older, and not a repeat of the last item of page 1.
	if page2[0]["text"] != "message 3" {
		t.Errorf("page 2 newest = %v, want message 3", page2[0]["text"])
	}
	if page2[1]["text"] != "message 2" {
		t.Errorf("page 2 second = %v, want message 2", page2[1]["text"])
	}
}

// TestBeforeCursorIsExclusive guards the repeat. An inclusive comparison would
// put the cursor's own message back on the next page, and the list would never
// advance.
func TestBeforeCursorIsExclusive(t *testing.T) {
	dir := t.TempDir()
	a := writeAudit(t, dir,
		line(t, event{Time: "10:00:01.000", Leg: legUserToBot, Text: "one"}),
		line(t, event{Time: "10:00:02.000", Leg: legUserToBot, Text: "two"}),
		line(t, event{Time: "10:00:03.000", Leg: legUserToBot, Text: "three"}),
	)
	when, err := time.Parse(time.RFC3339Nano,
		time.Now().UTC().Format("2006-01-02")+"T10:00:03.000Z")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	got := a.recent(10, when)
	for _, it := range got {
		if it["text"] == "three" {
			t.Error("the cursor's own message came back; ?before= must be exclusive")
		}
	}
	if len(got) != 2 {
		t.Errorf("got %d items, want the 2 strictly older ones", len(got))
	}
}

// TestSameSecondEventsAreDistinguishable is why the milliseconds were kept.
func TestSameSecondEventsAreDistinguishable(t *testing.T) {
	dir := t.TempDir()
	a := writeAudit(t, dir,
		line(t, event{Time: "10:00:01.100", Leg: legUserToBot, Text: "first"}),
		line(t, event{Time: "10:00:01.900", Leg: legUserToBot, Text: "second"}),
	)
	got := a.recent(10, time.Time{})
	if len(got) != 2 {
		t.Fatalf("got %d items", len(got))
	}
	a1, _ := got[1]["at"].(string)
	a2, _ := got[0]["at"].(string)
	if a1 == a2 {
		t.Fatalf("both events carry at=%q, so ?before= could not tell them apart", a1)
	}
	// Paging from the older one must still return the newer one's predecessor.
	when, err := time.Parse(time.RFC3339Nano, a1)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	next := a.recent(10, when)
	if len(next) != 0 {
		t.Errorf("expected nothing older than the first event, got %v", next)
	}
}

func TestRecentHandlesMultiLineAndLongText(t *testing.T) {
	dir := t.TempDir()
	// The provider's welcome message is multi-line; log() flattens it, and the
	// reader must cope with what actually lands on disk.
	a := newAudit(dir)
	a.log(legTasklyToBot, "reply", 0, "line one\nline two\ttabbed", nil)
	_ = a.Close()

	got := a.recent(10, time.Time{})
	if len(got) != 1 {
		t.Fatalf("got %d items, want 1", len(got))
	}
	// oneline flattens the newline to a literal backslash-n and leaves the tab
	// alone; json.Marshal escapes the tab on the way out and the reader gets a
	// real one back.
	if txt, _ := got[0]["text"].(string); txt != "line one\\nline two\ttabbed" {
		t.Errorf("text = %q", txt)
	}
}
