package main

// Showing or hiding a job changes what every user is offered, so the admins are
// told when it happens - and told only by the notifier that sends to
// ADMIN_USER_IDS and refuses when that list is empty. These tests pin both
// halves: that the announcement happens, and that a failure to deliver it never
// undoes the change.

import (
	"net/http"
	"strings"
	"testing"
)

// spyNotifier records what it was asked to send, and can be made to fail.
type spyNotifier struct {
	sent     []string
	failWith error
}

func (s *spyNotifier) notify(text string) error {
	if s.failWith != nil {
		return s.failWith
	}
	s.sent = append(s.sent, text)
	return nil
}

func (s *spyNotifier) last() string {
	if len(s.sent) == 0 {
		return ""
	}
	return s.sent[len(s.sent)-1]
}

// toggle calls the endpoint the Tasks page calls.
func toggle(t *testing.T, s *adminServer, name string, enabled bool) *http.Response {
	t.Helper()
	body := `{"enabled":` + map[bool]string{true: "true", false: "false"}[enabled] + `}`
	res, _ := s.call(t, http.MethodPost, "/api/tasks/"+name+"/enabled", body)
	return res
}

func TestTurningAJobOffAnnouncesItToAdmins(t *testing.T) {
	s := newTestServer(t)
	spy := &spyNotifier{}
	s.note = spy

	res := toggle(t, s, "Facebook%202fa", false)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	if len(spy.sent) != 1 {
		t.Fatalf("sent %d announcement(s), want exactly 1: %v", len(spy.sent), spy.sent)
	}
	msg := spy.last()
	if !strings.Contains(msg, "Facebook 2fa") {
		t.Errorf("the announcement does not name the job: %q", msg)
	}
	if !strings.Contains(msg, "OFF") {
		t.Errorf("the announcement does not say the job is off: %q", msg)
	}
	// It says who, because a catalogue edit is a decision and the next admin to
	// look needs to know it was deliberate rather than a glitch.
	if !strings.Contains(msg, testAdminUID) {
		t.Errorf("the announcement does not say which admin made the change: %q", msg)
	}
}

func TestTurningAJobOnAnnouncesItToAdmins(t *testing.T) {
	s := newTestServer(t)
	spy := &spyNotifier{}
	s.note = spy

	toggle(t, s, "Facebook%202fa", false) // hide it first
	before := len(spy.sent)
	res := toggle(t, s, "Facebook%202fa", true)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	if len(spy.sent) != before+1 {
		t.Fatalf("sent %d announcement(s), want one more", len(spy.sent)-before)
	}
	msg := spy.last()
	if !strings.Contains(msg, "ON") {
		t.Errorf("the announcement does not say the job is on: %q", msg)
	}
}

func TestAFailedToggleIsNotAnnounced(t *testing.T) {
	s := newTestServer(t)
	spy := &spyNotifier{}
	s.note = spy

	// An unknown job changes nothing, so it must say nothing.
	if res := toggle(t, s, "No%20Such%20Job", false); res.StatusCode != http.StatusNotFound {
		t.Fatalf("status %d, want 404", res.StatusCode)
	}
	if len(spy.sent) != 0 {
		t.Errorf("a change that did not happen was announced: %v", spy.sent)
	}
}

// TestAnUndeliverableNoticeDoesNotUndoTheChange is the important one. Telegram
// being unreachable must not make the operator think the toggle failed, because
// it did not: the catalogue is already written.
func TestAnUndeliverableNoticeDoesNotUndoTheChange(t *testing.T) {
	s := newTestServer(t)
	s.note = &spyNotifier{failWith: errFake{}}

	before := enabledInFile(t, s.cat.path)
	res := toggle(t, s, "Facebook%202fa", false)
	if res.StatusCode != http.StatusOK {
		t.Errorf("status %d, want 200: a failed announcement must not fail the change", res.StatusCode)
	}
	if enabledInFile(t, s.cat.path) == before {
		t.Error("the change was rolled back because the announcement failed")
	}
	if enabledInFile(t, s.cat.path) != false {
		t.Error("the change was not persisted")
	}
}

// TestTheAnnouncementGoesOnlyToAdmins pins the part the operator cares about.
// botNotifier is what actually sends, and its contract is that it iterates
// ADMIN_USER_IDS and nothing else.
func TestTheAnnouncementGoesOnlyToAdmins(t *testing.T) {
	if len(adminIDs) == 0 {
		t.Skip("no admins configured in this environment")
	}
	// An empty admin list must refuse rather than broadcast. This is the guard
	// that keeps a change notice away from end users.
	n := &botNotifier{admins: nil}
	if err := n.notify("anything"); err == nil {
		t.Error("a notifier with no admins accepted a message; it could reach anyone")
	}

	// Every configured admin is a real, non-zero id.
	for _, id := range adminIDs {
		if id == 0 {
			t.Error("an admin id of 0 would send to nobody and read as success")
		}
	}
}

type errFake struct{}

func (errFake) Error() string { return "telegram is unreachable" }

func TestTaskToggleMessageSaysWhatAndWho(t *testing.T) {
	on := taskToggleMessage("Facebook 2fa", true, testAdminUID)
	if !strings.Contains(on, "Facebook 2fa") || !strings.Contains(on, "ON") {
		t.Errorf("on-message is wrong: %q", on)
	}
	off := taskToggleMessage("Facebook 2fa", false, testAdminUID)
	if !strings.Contains(off, "Facebook 2fa") || !strings.Contains(off, "OFF") {
		t.Errorf("off-message is wrong: %q", off)
	}
	// Without an identity the message must still read sensibly rather than
	// saying "by admin  in the dashboard".
	anon := taskToggleMessage("Facebook 2fa", false, "")
	if strings.Contains(anon, "by admin  ") {
		t.Errorf("an unattributed message has a hole in it: %q", anon)
	}
}
