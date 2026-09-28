package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Every interaction in the bridge is recorded, on both sides and both
// directions, so a delivery can be reconstructed afterwards:
//
//	user  -> bot      an end user presses a button or sends text
//	bot  -> user      our bot replies
//	bot  -> taskly    our bot drives the real Telegram account
//	taskly-> bot      the target bot answers
//
// This is the only record of what a user actually did, which matters when a
// user disputes a charge or a delivery.

// Leg names, so a log line can be read without cross-referencing the code.
const (
	legUserToBot   = "user->bot"
	legBotToUser   = "bot->user"
	legBotToTaskly = "bot->taskly"
	legTasklyToBot = "taskly->bot"
	legInternal    = "internal"
)

type event struct {
	Time   string            `json:"ts"`
	Leg    string            `json:"leg"`
	Kind   string            `json:"kind"`
	UserID int64             `json:"user_id,omitempty"`
	Text   string            `json:"text"`
	Meta   map[string]string `json:"meta,omitempty"`
}

type audit struct {
	mu sync.Mutex
	f  *os.File
}

// newAudit opens today's log. Audit failing must not take the bot down, so a
// bad path degrades to console-only rather than panicking at startup.
func newAudit(dir string) *audit {
	a := &audit{}
	name := fmt.Sprintf("audit-%s.jsonl", time.Now().Format("2006-01-02"))
	path := filepath.Join(dir, name)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		fmt.Fprintf(os.Stderr, "audit: cannot create %s: %v\n", dir, err)
		return a
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		fmt.Fprintf(os.Stderr, "audit: cannot open %s: %v\n", path, err)
		return a
	}
	a.f = f
	fmt.Printf("audit log: %s\n", path)
	return a
}

// Close releases the log file.
//
// The process normally lives until the end, so this only matters on shutdown
// and in tests, but without it a long-lived process that ever reopened its log
// would leak a handle, and on Windows a leaked handle makes the file
// undeletable.
func (a *audit) Close() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.f == nil {
		return nil
	}
	err := a.f.Close()
	a.f = nil
	return err
}

// log records one interaction. It is called for every message in both
// directions, so the file is a complete transcript rather than a summary.
func (a *audit) log(leg, kind string, userID int64, text string, meta map[string]string) {
	ev := event{
		Time:   time.Now().Format("15:04:05.000"),
		Leg:    leg,
		Kind:   kind,
		UserID: userID,
		Text:   truncate(oneline(text), 400),
		Meta:   meta,
	}

	a.mu.Lock()
	defer a.mu.Unlock()

	if a.f != nil {
		if b, err := json.Marshal(ev); err == nil {
			fmt.Fprintf(a.f, "%s\n", b)
		}
	}

	who := ""
	if userID != 0 {
		who = fmt.Sprintf(" [%d]", userID)
	}
	extra := ""
	if len(meta) > 0 {
		var kv []string
		for k, v := range meta {
			kv = append(kv, k+"="+v)
		}
		sortStrings(kv)
		extra = "  {" + strings.Join(kv, " ") + "}"
	}
	fmt.Printf("  %-12s %-9s %-38s %s%s\n", ev.Time, leg+who, kind, ev.Text, extra)
}

func oneline(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\n", "\\n")
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// sortStrings is a tiny insertion sort so the audit line is stable without
// pulling in a dependency for two keys.
func sortStrings(v []string) {
	for i := 1; i < len(v); i++ {
		for j := i; j > 0 && v[j] < v[j-1]; j-- {
			v[j], v[j-1] = v[j-1], v[j]
		}
	}
}
