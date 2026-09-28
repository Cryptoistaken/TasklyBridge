package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gotd/td/tg"
)

// The tool does exactly what a plan file says and nothing else. Two rules make
// it trustworthy:
//
//  1. No fixed sleeps. After an action the tool waits for the bot to go quiet,
//     so it always knows the reply is finished rather than guessing a delay.
//  2. Every action prints the resulting screen. The next line of a plan is
//     chosen from what is actually on offer, never from a remembered guess.
//
// Plan syntax, one action per line:
//
//	note <text>            write a marker into the transcript
//	click <label>          activate the button whose label contains <label>
//	!click <label>         same, but bypasses the destructive-action guard
//	text <message>         send a message
//	pressdata <id> <data>  press an inline callback by raw data
//	shot                   print the screen without acting
//	history <n>            dump the last n messages
//
// There is deliberately no `wait` step. If a bot is slow, raise TG_REPLY_TIMEOUT
// instead: the tool then waits for real replies instead of a guessed duration.

// riskyWords guard `click`. A plan is written by someone, but a mistyped
// withdraw is expensive, so the label is checked anyway. `!click` overrides.
var riskyWords = []string{
	"delete", "remove", "pay", "buy", "purchase", "checkout", "order",
	"confirm", "withdraw", "transfer", "upgrade", "renew", "subscribe",
	"cancel", "drop", "wipe", "reset", "logout", "log out", "sign out",
	"ban", "unsub", "topup", "top up", "charge", "refund", "close account",
}

func looksRisky(s string) bool {
	low := strings.ToLower(s)
	for _, w := range riskyWords {
		if strings.Contains(low, w) {
			return true
		}
	}
	return false
}

// ------------------------------------------------------------ recent window --

// entry pairs a message with a monotonic counter, so "what arrived since I
// acted" is a comparison rather than a guess about slice indices.
type entry struct {
	seq int64
	msg *tg.Message
}

// recent remembers the newest bot messages: the tool looks back here to find
// the live keyboard, and forward to tell new replies from old ones.
//
// The keyboard is also written to disk, because each run is a fresh process and
// this chat's getHistory comes back empty, so without a saved screen a new run
// would start blind and be unable to click anything.
type recent struct {
	mu    sync.Mutex
	items []entry
	max   int
	seq   int64
	// saveDir is where the last screen is persisted. Empty disables it.
	saveDir string
}

func newRecent(max int) *recent { return &recent{max: max} }

// savedScreen is the on-disk shape of the last keyboard seen.
type savedScreen struct {
	SavedAt  time.Time `json:"saved_at"`
	Bot      string    `json:"bot"`
	MsgID    int       `json:"msg_id"`
	Text     string    `json:"text"`
	Date     int       `json:"date"`
	Buttons  []button  `json:"buttons"`
	PeerUser int64     `json:"peer_user"`
}

func (r *recent) screenPath() string {
	if r.saveDir == "" {
		return ""
	}
	return filepath.Join(r.saveDir, "screen.json")
}

// persist writes the newest keyboard so the next run can resume from it.
func (r *recent) persist() {
	path := r.screenPath()
	if path == "" {
		return
	}
	m := r.newestWithButtons()
	if m == nil {
		return
	}
	saved := savedScreen{
		SavedAt:  time.Now(),
		Bot:      targetBot,
		MsgID:    m.ID,
		Text:     m.Message,
		Date:     m.Date,
		Buttons:  collectButtons(m),
		PeerUser: targetUserID,
	}
	raw, err := json.MarshalIndent(saved, "", "  ")
	if err != nil {
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return
	}
	// Rename is atomic, so an interrupted run cannot leave a half-written
	// screen that would make the next run click the wrong thing.
	_ = os.Rename(tmp, path)
}

// restore loads the saved screen into the window, so a fresh run can click
// without walking the menu again. It reports what it loaded, and refuses a
// screen saved for a different bot.
func (r *recent) restore() (savedScreen, bool) {
	var zero savedScreen
	path := r.screenPath()
	if path == "" {
		return zero, false
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return zero, false
	}
	var s savedScreen
	if err := json.Unmarshal(raw, &s); err != nil || len(s.Buttons) == 0 {
		return zero, false
	}
	// The bot name comes from config, so it is always known. The numeric id is
	// not: it is zero until the peer is resolved, which is exactly when the
	// first messages arrive, so it cannot be relied on to detect a stale file.
	if s.Bot != "" && targetBot != "" && s.Bot != targetBot {
		return zero, false
	}
	// Rebuild a message carrying the saved keyboard. Out=false because it is
	// the bot's screen, not ours.
	markup := &tg.ReplyKeyboardMarkup{}
	for _, b := range s.Buttons {
		if b.Kind == "callback" {
			// An inline callback needs its original message id to be
			// pressable, and that cannot be reconstructed from a label, so it
			// is kept as data but not offered as a text button.
			continue
		}
		markup.Rows = append(markup.Rows, tg.KeyboardButtonRow{
			Buttons: []tg.KeyboardButton{{Text: b.Label, Type: &tg.ButtonTypeDefault{}}},
		})
	}
	if len(markup.Rows) == 0 {
		return zero, false
	}
	r.add(&tg.Message{
		ID:          s.MsgID,
		Date:        s.Date,
		Message:     s.Text,
		PeerID:      &tg.PeerUser{UserID: s.PeerUser},
		ReplyMarkup: markup,
	})
	return s, true
}

func (r *recent) add(m *tg.Message) {
	r.mu.Lock()
	r.seq++
	r.items = append(r.items, entry{seq: r.seq, msg: m})
	if len(r.items) > r.max {
		r.items = r.items[len(r.items)-r.max:]
	}
	r.mu.Unlock()

	// A new keyboard is a new screen worth keeping.
	if m.ReplyMarkup != nil {
		r.persist()
	}
}

// mark returns the current counter, to be passed to since after acting.
func (r *recent) mark() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.seq
}

func (r *recent) since(mark int64) []*tg.Message {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []*tg.Message
	for _, e := range r.items {
		if e.seq > mark {
			out = append(out, e.msg)
		}
	}
	return out
}

func (r *recent) newestWithButtons() *tg.Message {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := len(r.items) - 1; i >= 0; i-- {
		if r.items[i].msg.ReplyMarkup != nil {
			return r.items[i].msg
		}
	}
	return nil
}

func (r *recent) lastMsg() *tg.Message {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.items) == 0 {
		return nil
	}
	return r.items[len(r.items)-1].msg
}

// withButtons returns every remembered message carrying a reply markup, oldest
// first. findButton searches this newest-first, because the live keyboard is
// the most recent one seen.
func (r *recent) withButtons() []*tg.Message {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []*tg.Message
	for _, e := range r.items {
		if e.msg.ReplyMarkup != nil {
			out = append(out, e.msg)
		}
	}
	return out
}

// ----------------------------------------------------------------- buttons --

// button is one activatable thing on a message. Fields are exported so the
// last screen can be saved to disk and restored by the next run.
type button struct {
	Label string `json:"label"`
	Kind  string `json:"kind"` // "text", "callback" or "noop"
	Data  string `json:"data,omitempty"`
	MsgID int    `json:"msg_id"`
}

// findButton looks for a label match, newest keyboard first, and returns the
// best candidate plus every label it saw so a miss can explain itself.
func findButton(msgs []*tg.Message, query string) (button, []string) {
	q := strings.ToLower(strings.TrimSpace(query))
	var all []string

	for i := len(msgs) - 1; i >= 0; i-- {
		m := msgs[i]
		var found *button
		for _, b := range collectButtons(m) {
			all = append(all, fmt.Sprintf("%s [%s] %s", b.Label, b.Kind, preview(b.Data)))
			if found == nil && strings.Contains(strings.ToLower(b.Label), q) {
				c := b
				found = &c
			}
		}
		if found != nil {
			return *found, all
		}
	}
	return button{}, all
}

func collectButtons(m *tg.Message) []button {
	var out []button
	switch v := m.ReplyMarkup.(type) {
	case *tg.ReplyInlineMarkup:
		for _, row := range v.Rows {
			for _, b := range row.Buttons {
				switch t := b.Type.(type) {
				case *tg.InlineButtonTypeCallback:
					out = append(out, button{Label: b.Text, Kind: "callback", Data: string(t.Data), MsgID: m.ID})
				default:
					// A url or copy button has nothing to route back to.
					out = append(out, button{Label: b.Text, Kind: "noop", MsgID: m.ID})
				}
			}
		}
	case *tg.ReplyKeyboardMarkup:
		for _, row := range v.Rows {
			for _, b := range row.Buttons {
				switch b.Type.(type) {
				case *tg.ButtonTypeRequestPhone, *tg.ButtonTypeRequestGeoLocation:
					out = append(out, button{Label: b.Text, Kind: "noop", MsgID: m.ID})
				default:
					out = append(out, button{Label: b.Text, Kind: "text", MsgID: m.ID})
				}
			}
		}
	}
	return out
}

func preview(s string) string {
	if s == "" {
		return ""
	}
	if len(s) > 60 {
		s = s[:60] + "..."
	}
	return s
}

// ------------------------------------------------------------ step runner ---

// stepSettings is the pacing and lookup limits the runner needs. It is built
// in main.go; this alias keeps the runner's fields readable.
type stepSettings struct {
	delay        time.Duration // gap between actions, to stay under flood limits
	quiet        time.Duration // silence from the bot that counts as "reply finished"
	replyTimeout time.Duration // hard ceiling on waiting for a reply
	history      int
}

type runner struct {
	ctx   context.Context
	api   *tg.Client
	peer  tg.InputPeerClass
	rec   *recorder
	in    *recent
	inbox chan *tg.Message // live arrivals, the event source for waiting
	cfg   stepSettings
	// dropped counts messages lost because the inbox filled. A non-zero value
	// means a screen may be missing something, so it is reported loudly.
	dropped atomic.Int64
	// sent counts actions already taken, so the first one can skip the gap.
	sent int
}

// noteArrival hands a live message to the runner without blocking the caller.
// A full inbox drops the message and counts it, because stalling here would
// stall Telegram's own read loop and cost far more than a missing line.
func (r *runner) noteArrival(m *tg.Message) {
	select {
	case r.inbox <- m:
	default:
		r.dropped.Add(1)
	}
}

func (r *runner) send(b button) error {
	switch b.Kind {
	case "text":
		_, err := r.api.MessagesSendMessage(r.ctx, &tg.MessagesSendMessageRequest{
			Peer: r.peer, Message: b.Label, RandomID: time.Now().UnixNano(),
		})
		return err
	case "callback":
		_, err := r.api.MessagesGetBotCallbackAnswer(r.ctx, &tg.MessagesGetBotCallbackAnswerRequest{
			Peer: r.peer, MsgID: b.MsgID, Data: []byte(b.Data),
		})
		return err
	default:
		return fmt.Errorf("button %q has no action attached to it", b.Label)
	}
}

func (r *runner) sendText(s string) error {
	_, err := r.api.MessagesSendMessage(r.ctx, &tg.MessagesSendMessageRequest{
		Peer: r.peer, Message: s, RandomID: time.Now().UnixNano(),
	})
	return err
}

func (r *runner) pressData(msgID int, data string) error {
	_, err := r.api.MessagesGetBotCallbackAnswer(r.ctx, &tg.MessagesGetBotCallbackAnswerRequest{
		Peer: r.peer, MsgID: msgID, Data: []byte(data),
	})
	return err
}

// collect waits for the bot to finish replying. It blocks on the arrival
// channel, so it returns as soon as the bot goes quiet and not a moment later.
func (r *runner) collect(mark int64) []*tg.Message {
	quiet := time.NewTimer(r.cfg.quiet)
	defer quiet.Stop()
	hard := time.NewTimer(r.cfg.replyTimeout)
	defer hard.Stop()

	var got []*tg.Message
	for {
		select {
		case m := <-r.inbox:
			got = append(got, m)
			if !quiet.Stop() {
				select {
				case <-quiet.C:
				default:
				}
			}
			quiet.Reset(r.cfg.quiet)
		case <-quiet.C:
			return got
		case <-hard.C:
			return got
		case <-r.ctx.Done():
			return got
		}
	}
}

// screen prints what the bot said and what is clickable right now. This runs
// after every action, so the next plan line is always chosen from facts.
func (r *runner) screen(mark int64) {
	fresh := r.in.since(mark)
	if len(fresh) == 0 {
		r.rec.addNote("  no reply within %s", r.cfg.replyTimeout)
	} else {
		r.rec.addNote("  the bot replied:")
		for _, m := range fresh {
			r.printMessage(m)
		}
	}
	r.printButtons()
}

// printCurrent prints the latest screen without claiming anything arrived.
// Used by `shot`, where nothing was sent and so nothing should be waited for.
func (r *runner) printCurrent() {
	if last := r.in.lastMsg(); last != nil {
		r.rec.addNote("  latest message:")
		r.printMessage(last)
	} else {
		r.rec.addNote("  nothing received yet")
	}
	r.printButtons()
}

// printButtons lists what can be clicked right now, from the newest keyboard
// still on screen. Labels are shown verbatim so the next plan line can be
// copied from the log rather than remembered.
func (r *runner) printButtons() {
	keyboard := r.in.newestWithButtons()
	if keyboard == nil {
		r.rec.addNote("  no buttons on screen")
		return
	}
	labels := collectButtons(keyboard)
	if len(labels) == 0 {
		return
	}
	r.rec.addNote("  clickable now (from id=%d):", keyboard.ID)
	for _, b := range labels {
		marker := ""
		if b.Kind == "noop" {
			marker = "   <- nothing to click"
		}
		r.rec.addNote("    %-30s [%s] %s%s", b.Label, b.Kind, preview(b.Data), marker)
	}
}

// printMessage summarises a message for the step log. The live update handler
// already records the full detail of every arrival, so repeating it here would
// write every reply to the transcript twice.
func (r *runner) printMessage(m *tg.Message) {
	text := oneline(m.Message)
	if len(text) > 300 {
		text = text[:300] + "..."
	}
	if text == "" {
		text = "(no text)"
	}
	r.rec.addNote("    id=%d out=%v  %s", m.ID, m.Out, text)
	if media := dumpMedia(m.Media); media != "" {
		r.rec.addNote("      media: %s", media)
	}
	for _, e := range dumpEntities(m.Entities) {
		r.rec.addNote("      fmt:  %s", e)
	}
}

// perform is the one path every action takes: act, wait for the real reply,
// then print the resulting screen. Keeping it single-path is what guarantees
// no action can be blind.
func (r *runner) perform(what string, do func() error) error {
	// Space consecutive actions apart so a long plan does not look like
	// spamming. The first action of a run has nothing before it, so it skips
	// the gap entirely.
	if r.sent > 0 && r.cfg.delay > 0 {
		time.Sleep(r.cfg.delay)
	}
	mark := r.in.mark()

	if err := do(); err != nil {
		return fmt.Errorf("%s: %w", what, err)
	}
	r.sent++
	r.rec.addNote("  sent: %s", what)

	got := r.collect(mark)
	r.screen(mark)
	if len(got) > 1 {
		r.rec.addNote("  (%d messages in this reply)", len(got))
	}
	return nil
}

// ensureKnown gives the window something to search before the first click.
//
// Order matters. This chat's getHistory comes back empty, so the saved screen
// is the only thing a fresh run can use. Loading it first means a plan can be
// a single "click Start" instead of walking the whole menu again.
func (r *runner) ensureKnown() error {
	if len(r.in.withButtons()) > 0 {
		return nil
	}
	if s, ok := r.in.restore(); ok {
		r.rec.addNote("  resumed from saved screen: id=%d, %d button(s), saved %s ago",
			s.MsgID, len(s.Buttons), time.Since(s.SavedAt).Round(time.Minute))
		return nil
	}
	msgs, err := flattenHistory(r.ctx, r.api, r.peer, r.cfg.history)
	if err != nil {
		return err
	}
	for _, m := range msgs {
		r.in.add(m)
	}
	if len(r.in.withButtons()) == 0 {
		r.rec.addNote("  no saved screen and no history - send /start to get a menu")
	}
	return nil
}

// run executes the plan, one line at a time, stopping only on a hard error.
func (r *runner) run(path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read plan %s: %w", path, err)
	}

	r.rec.addNote("=== plan %s ===", path)
	steps := 0

	for n, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		steps++
		r.rec.addNote("step %d: %s", n+1, line)

		if err := r.step(line); err != nil {
			return fmt.Errorf("step %d (%s): %w", n+1, line, err)
		}
	}
	if n := r.dropped.Load(); n > 0 {
		r.rec.addNote("WARNING: %d message(s) dropped, a screen may be incomplete", n)
	}
	r.rec.addNote("=== plan finished, %d step(s) ===", steps)
	return nil
}

func (r *runner) step(line string) error {
	verb, rest, _ := strings.Cut(line, " ")
	rest = strings.TrimSpace(rest)
	force := false
	if verb == "!click" {
		verb, force = "click", true
	}

	switch verb {
	case "note":
		r.rec.addNote("%s", rest)

	case "shot":
		// Reading the screen must not wait: there is no action, so no reply is
		// coming. Printing the current screen is the whole job.
		if err := r.ensureKnown(); err != nil {
			return err
		}
		r.rec.addNote("screen as it stands (no action taken, no waiting):")
		r.printCurrent()

	case "history":
		n := r.cfg.history
		if rest != "" {
			v, err := strconv.Atoi(rest)
			if err != nil {
				return fmt.Errorf("history needs a number, got %q", rest)
			}
			n = v
		}
		msgs, err := flattenHistory(r.ctx, r.api, r.peer, n)
		if err != nil {
			return err
		}
		for _, m := range msgs {
			r.rec.add(dumpMessage(m))
		}

	case "text":
		if rest == "" {
			return fmt.Errorf("text needs a message")
		}
		return r.perform("text "+preview(rest), func() error { return r.sendText(rest) })

	case "pressdata":
		id, data, ok := strings.Cut(rest, " ")
		if !ok {
			return fmt.Errorf("pressdata needs <msgid> <callback_data>")
		}
		msgID, err := strconv.Atoi(strings.TrimSpace(id))
		if err != nil {
			return fmt.Errorf("pressdata msgid must be a number, got %q", id)
		}
		return r.perform(fmt.Sprintf("pressdata %d %q", msgID, preview(data)), func() error {
			return r.pressData(msgID, data)
		})

	case "click":
		// The window can be empty on a cold run, so try history before failing.
		if err := r.ensureKnown(); err != nil {
			return err
		}
		btn, seen := findButton(r.in.withButtons(), rest)
		if btn.Label == "" {
			r.rec.addNote("  click %q matched nothing. Labels on screen right now:", rest)
			for _, s := range seen {
				r.rec.addNote("    %s", s)
			}
			if len(seen) == 0 {
				r.rec.addNote("    (nothing on screen - send /start first)")
			}
			// Not fatal: one wrong line should not abandon the rest of a plan.
			return nil
		}
		if btn.Kind == "noop" {
			r.rec.addNote("  click %q REFUSED - %q has no action behind it", btn.Label, btn.Label)
			return nil
		}
		if !force && looksRisky(btn.Label) {
			r.rec.addNote("  click %q REFUSED - label looks destructive, use !click to force", btn.Label)
			return nil
		}
		return r.perform(fmt.Sprintf("click %q [%s] data=%q", btn.Label, btn.Kind, preview(btn.Data)), func() error {
			return r.send(btn)
		})

	default:
		return fmt.Errorf("unknown step %q (use note, click, !click, text, pressdata, shot, history)", verb)
	}
	return nil
}

// readPlan returns the plan body so the caller can echo it before running.
func readPlan(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var keep []string
	sc := bufio.NewScanner(strings.NewReader(string(raw)))
	for sc.Scan() {
		if l := strings.TrimSpace(sc.Text()); l != "" {
			keep = append(keep, l)
		}
	}
	return strings.Join(keep, "\n"), sc.Err()
}
