package main

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gotd/td/tg"
)

// Everything that talks to @TasklyBux_bot lives here, over MTProto, driving the
// real Telegram account. Two observed facts shape all of it:
//
//  1. This bot returns an EMPTY getHistory, every time. There is no past to
//     read, so the menu path is written out rather than crawled.
//  2. The whole menu is a reply keyboard, so "clicking" a button means sending
//     its label as a message. There is no callback_data to route.

// Task is one purchasable job on the target bot.
type Task struct {
	Name  string
	Price float64
	Label string // the raw button text, needed to click it again
}

// priceRe pulls the trailing "($0.0500)" off a button label.
var priceRe = regexp.MustCompile(`\(\$([0-9]*\.?[0-9]+)\)`)

// emojiRe strips leading decorative emoji so the name is readable.
var emojiRe = regexp.MustCompile(`^[\p{So}\p{Sk}\p{Sm}\p{Cf}\s]+`)

// parseTask turns a button label into a task. Labels look like
// "🌟2FA:Create FB (No mail) ($0.0500)"; a row such as "❌ Cancel" has no
// price and must not become a task, or the menu would offer Cancel as a job.
func parseTask(label string) (Task, bool) {
	m := priceRe.FindStringSubmatch(label)
	if m == nil {
		return Task{}, false
	}
	price, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return Task{}, false
	}
	name := strings.TrimSpace(priceRe.ReplaceAllString(label, ""))
	name = strings.TrimSpace(emojiRe.ReplaceAllString(name, ""))
	if name == "" {
		return Task{}, false
	}
	return Task{Name: name, Price: price, Label: label}, true
}

// target is a live connection to the TasklyBux chat, driven through one MTProto
// client. Telegram only delivers updates to the client that is actually
// running, so this must share the running client rather than open its own.
type target struct {
	// accountID is which stored session this client is. It is the key into both
	// the sessions table and the fleet, and it is the only thing that tells one
	// live account from another: two targets share the same peer, because they
	// are two Telegram accounts talking to the same provider bot. That is the
	// case this whole file exists to support.
	accountID string
	ctx       context.Context
	api       *tg.Client
	peer      tg.InputPeerClass
	arrivals  chan seqMsg
	audit     *audit
	timeout   time.Duration
	// last holds the most recent replies, so the keyboard currently on screen
	// can be searched before sending anything.
	last []*tg.Message
	// seq counts arrivals, so a reply can be attributed to the action that
	// caused it. Without this, a message that lands while the bot is idle is
	// mistaken for the answer to the next action.
	seq int64
	// opMu is held for a WHOLE provider operation, from the first press to the
	// last reply. The price watcher and a user tapping a job both navigate the
	// same chat, and two overlapping navigations interleave into nonsense: one
	// consumes the other's reply, and the provider reads the stray message as a
	// cancel. That was observed as "could not read the job list", not theorised.
	opMu sync.Mutex
	// seqMu guards seq only. It must not be opMu: the update handler bumps seq
	// while an operation holds opMu and is waiting for that very arrival, so
	// sharing the lock would deadlock.
	seqMu sync.Mutex
}

// seqMsg is one arrival with its ordering number.
type seqMsg struct {
	seq int64
	msg *tg.Message
}

func (t *target) mark() int64 {
	t.seqMu.Lock()
	defer t.seqMu.Unlock()
	return t.seq
}

func (t *target) bump() {
	t.seqMu.Lock()
	t.seq++
	t.seqMu.Unlock()
}

// forward relays one end user's message. It takes the whole-operation lock so a
// forwarded message cannot land in the middle of a navigation, which the
// provider would read as a cancel.
func (t *target) forward(what, text string) ([]*tg.Message, error) {
	t.opMu.Lock()
	defer t.opMu.Unlock()
	return t.sendRaw(what, text)
}

// sendRaw sends text verbatim. Used for commands like /start and for text
// forwarded from an end user, neither of which is a button label and so
// neither can be resolved against the on-screen keyboard.
func (t *target) sendRaw(what, text string) ([]*tg.Message, error) {
	t.audit.log(legBotToTaskly, "send", 0, text, map[string]string{"what": what})
	mark := t.mark()
	if _, err := t.api.MessagesSendMessage(t.ctx, &tg.MessagesSendMessageRequest{
		Peer: t.peer, Message: text, RandomID: time.Now().UnixNano(),
	}); err != nil {
		t.audit.log(legBotToTaskly, "error", 0, err.Error(), map[string]string{"what": what})
		return nil, err
	}
	return t.wait(what, mark), nil
}

// press activates the button whose label contains want, then waits for the
// provider to stop talking.
//
// It sends the WHOLE label, not the fragment that was asked for. That is the
// difference between working and not: the provider matches on the exact
// keyboard text, so sending bare "Tasks" or "cookie" matches no button and the
// provider falls through to its cancel handler and answers
// "Action cancelled.". A fragment that matches nothing is refused rather than
// sent, because a blind send here costs a real job.
func (t *target) press(what, want string) ([]*tg.Message, error) {
	full, ok := t.resolveLabel(want)
	if !ok {
		labels := t.availableLabels()
		t.audit.log(legBotToTaskly, "no-match", 0, want, map[string]string{
			"what": what, "available": truncate(strings.Join(labels, " | "), 300),
		})
		return nil, fmt.Errorf("no button matches %q; on screen: %s",
			want, truncate(strings.Join(labels, " | "), 300))
	}

	t.audit.log(legBotToTaskly, "press", 0, full, map[string]string{
		"what": what, "matched": want,
	})

	mark := t.mark()
	if _, err := t.api.MessagesSendMessage(t.ctx, &tg.MessagesSendMessageRequest{
		Peer: t.peer, Message: full, RandomID: time.Now().UnixNano(),
	}); err != nil {
		t.audit.log(legBotToTaskly, "error", 0, err.Error(), map[string]string{"what": what})
		return nil, err
	}
	return t.wait(what, mark), nil
}

// resolveLabel finds the full label of the newest button containing want.
func (t *target) resolveLabel(want string) (string, bool) {
	q := strings.ToLower(strings.TrimSpace(want))
	for i := len(t.last) - 1; i >= 0; i-- {
		for _, lbl := range replyLabels(t.last[i]) {
			if q != "" && strings.Contains(strings.ToLower(lbl), q) {
				return lbl, true
			}
		}
	}
	return "", false
}

// remember keeps the recent replies, bounded, so resolveLabel can search the
// keyboard that is on screen without the window growing for the process life.
func (t *target) remember(msgs []*tg.Message) {
	const window = 12
	t.last = append(t.last, msgs...)
	if len(t.last) > window {
		t.last = t.last[len(t.last)-window:]
	}
}

func (t *target) availableLabels() []string {
	var out []string
	seen := map[string]bool{}
	for i := len(t.last) - 1; i >= 0; i-- {
		for _, lbl := range replyLabels(t.last[i]) {
			if !seen[lbl] {
				seen[lbl] = true
				out = append(out, lbl)
			}
		}
	}
	return out
}

// wait blocks until the bot has been silent for a moment, so a reply is never
// read half-finished and no fixed delay is guessed.
func (t *target) wait(what string, mark int64) []*tg.Message {
	const quiet = 500 * time.Millisecond

	hard := time.NewTimer(t.timeout)
	defer hard.Stop()
	idle := time.NewTimer(t.timeout)
	defer idle.Stop()

	var got []*tg.Message
	for {
		select {
		case in := <-t.arrivals:
			// Anything that arrived before this action started is not its
			// answer, so it is ignored rather than read as a reply.
			if in.seq <= mark {
				continue
			}
			got = append(got, in.msg)
			t.audit.log(legTasklyToBot, "reply", 0, in.msg.Message, map[string]string{
				"what": what, "msg_id": strconv.Itoa(in.msg.ID),
			})
			if !idle.Stop() {
				select {
				case <-idle.C:
				default:
				}
			}
			idle.Reset(quiet)
		case <-idle.C:
			t.remember(got)
			return got
		case <-hard.C:
			t.remember(got)
			return got
		case <-t.ctx.Done():
			t.remember(got)
			return got
		}
	}
}

// hasButton reports whether any of the replies offers a button containing the
// given text, which is how a screen is identified without guessing.
func hasButton(msgs []*tg.Message, want string) bool {
	for _, m := range msgs {
		for _, lbl := range replyLabels(m) {
			if strings.Contains(strings.ToLower(lbl), strings.ToLower(want)) {
				return true
			}
		}
	}
	return false
}

func replyLabels(m *tg.Message) []string {
	var out []string
	switch v := m.ReplyMarkup.(type) {
	case *tg.ReplyKeyboardMarkup:
		for _, row := range v.Rows {
			for _, b := range row.Buttons {
				out = append(out, b.Text)
			}
		}
	case *tg.ReplyInlineMarkup:
		for _, row := range v.Rows {
			for _, b := range row.Buttons {
				out = append(out, b.Text)
			}
		}
	}
	return out
}

func firstText(msgs []*tg.Message) string {
	for _, m := range msgs {
		if s := strings.TrimSpace(m.Message); s != "" {
			return s
		}
	}
	return ""
}

// ensureMainMenu gets back to the main menu before navigating.
//
// Observed: once a job has been started, the provider sits in a modal state
// where ordinary menu labels are read as cancel and it replies
// "Action cancelled." Navigation therefore has to prove it is on the main
// menu, and clear the state if it is not.
func (t *target) ensureMainMenu() error {
	for attempt := 1; attempt <= 3; attempt++ {
		replies, err := t.sendRaw("knock", "/start")
		if err != nil {
			return err
		}
		if hasButton(replies, "Balance") {
			return nil
		}
		t.audit.log(legInternal, "not-on-menu", 0,
			fmt.Sprintf("attempt %d: no main menu, clearing provider state", attempt),
			map[string]string{"last_reply": firstText(replies)})
		if !hasButton(replies, "Cancel") {
			return fmt.Errorf("provider is not on the main menu and offers no Cancel (last said: %q)",
				truncate(firstText(replies), 120))
		}
		if _, err := t.press("clear state", "Cancel"); err != nil {
			return err
		}
	}
	return fmt.Errorf("could not return to the main menu after 3 attempts")
}

// fetchTasks walks to the task sub-list and reads the priced buttons off it.
//
// The list is taken from the reply to the last press, NOT from getHistory:
// this provider returns an empty history for the chat, so reading history
// finds nothing even though the keyboard is plainly on screen.
func (t *target) fetchTasks(group string) ([]Task, error) {
	t.opMu.Lock()
	defer t.opMu.Unlock()

	if err := t.ensureMainMenu(); err != nil {
		return nil, err
	}
	if _, err := t.press("open Tasks", "Tasks"); err != nil {
		return nil, fmt.Errorf("open Tasks: %w", err)
	}

	replies := t.last
	if group != "" {
		got, err := t.press("open "+group, group)
		if err != nil {
			return nil, fmt.Errorf("open %q: %w", group, err)
		}
		replies = got
	}

	// Newest keyboard first, and stop at the first that has priced buttons,
	// because a stale keyboard higher up the window would win otherwise.
	for i := len(replies) - 1; i >= 0; i-- {
		rows, ok := replies[i].ReplyMarkup.(*tg.ReplyKeyboardMarkup)
		if !ok {
			continue
		}
		var tasks []Task
		for _, row := range rows.Rows {
			for _, b := range row.Buttons {
				if task, ok := parseTask(b.Text); ok {
					tasks = append(tasks, task)
				}
			}
		}
		if len(tasks) > 0 {
			return tasks, nil
		}
	}
	return nil, fmt.Errorf("walked to the task list but read no priced buttons (on screen: %s)",
		truncate(strings.Join(t.availableLabels(), " | "), 300))
}

// jobFilter decides which of the provider's jobs we are willing to offer.
//
// The provider lists many jobs, but this service only sells some of them, so
// the rest are hidden. Matching is a case-insensitive substring because the
// provider's own names are close variants of each other: "2FA:Create FB (No
// mail)" and "Create FB (2FA)" are the same product at different prices, and an
// exact match would silently drop both the moment a letter moved.
type jobFilter struct {
	// wants are the configured substrings. Empty means offer everything.
	wants []string
}

func (f jobFilter) allows(name string) bool {
	if len(f.wants) == 0 {
		return true
	}
	low := strings.ToLower(name)
	for _, w := range f.wants {
		if w != "" && strings.Contains(low, strings.ToLower(w)) {
			return true
		}
	}
	return false
}

// apply splits a job list into the ones we offer and the ones we hide.
func (f jobFilter) apply(in []Task) (kept, hidden []Task) {
	for _, task := range in {
		if f.allows(task.Name) {
			kept = append(kept, task)
		} else {
			hidden = append(hidden, task)
		}
	}
	return kept, hidden
}

func (f jobFilter) wantsText() string {
	if len(f.wants) == 0 {
		return "everything"
	}
	return strings.Join(f.wants, ", ")
}

// jobFilterFromEnv reads JOBS, a comma separated list of substrings.
// An empty value means offer every job, which is the safe default for a
// service that has not been configured yet.
func jobFilterFromEnv(raw string) jobFilter {
	var wants []string
	for _, part := range strings.Split(raw, ",") {
		if p := strings.TrimSpace(part); p != "" {
			wants = append(wants, p)
		}
	}
	return jobFilter{wants: wants}
}

// joinResult is what came back after asking the target bot to start a job.
type joinResult struct {
	Replies []string
	// Password stays empty until a real sample of the credential message has
	// been seen. The reply after Start is currently a request for a 2FA key,
	// not a credential, so inventing a pattern for it would be a guess dressed
	// up as a parser. The raw text is forwarded and this gets filled in once
	// there is something to match.
	Password string
}

// joinTask asks the target bot to start a job and returns whatever it says.
func (t *target) joinTask(task Task) (joinResult, error) {
	t.opMu.Lock()
	defer t.opMu.Unlock()

	var res joinResult

	if err := t.ensureMainMenu(); err != nil {
		return res, err
	}
	if _, err := t.press("open Tasks", "Tasks"); err != nil {
		return res, fmt.Errorf("open Tasks: %w", err)
	}
	if _, err := t.press("open task "+task.Name, task.Label); err != nil {
		return res, fmt.Errorf("open task %q: %w", task.Name, err)
	}
	replies, err := t.press("click Start", "Start")
	if err != nil {
		return res, fmt.Errorf("click Start on %q: %w", task.Name, err)
	}
	for _, m := range replies {
		if s := strings.TrimSpace(m.Message); s != "" {
			res.Replies = append(res.Replies, s)
		}
	}
	return res, nil
}

func resolve(ctx context.Context, api *tg.Client, username string) (tg.InputPeerClass, int64, error) {
	rp, err := api.ContactsResolveUsername(ctx, &tg.ContactsResolveUsernameRequest{Username: username})
	if err != nil {
		return nil, 0, err
	}
	for _, u := range rp.Users {
		if user, ok := u.(*tg.User); ok && user.Bot {
			return &tg.InputPeerUser{UserID: user.ID, AccessHash: user.AccessHash}, user.ID, nil
		}
	}
	return nil, 0, fmt.Errorf("@%s has no bot", username)
}

func pickMessages(res tg.MessagesMessagesClass) []*tg.Message {
	mm, ok := res.(*tg.MessagesMessages)
	if !ok {
		return nil
	}
	out := make([]*tg.Message, 0, len(mm.Messages))
	for _, m := range mm.Messages {
		if msg, ok := m.(*tg.Message); ok {
			out = append(out, msg)
		}
	}
	return out
}

func extractMessage(u tg.UpdatesClass) *tg.Message {
	switch v := u.(type) {
	case *tg.Updates:
		for _, e := range v.Updates {
			if m := extractUpdate(e); m != nil {
				return m
			}
		}
	case *tg.UpdatesCombined:
		for _, e := range v.Updates {
			if m := extractUpdate(e); m != nil {
				return m
			}
		}
	case *tg.UpdateShortMessage:
		return &tg.Message{
			ID: v.ID, Out: v.Out, Date: v.Date, Message: v.Message,
			PeerID: &tg.PeerUser{UserID: v.UserID},
		}
	}
	return nil
}

func extractUpdate(u tg.UpdateClass) *tg.Message {
	if v, ok := u.(*tg.UpdateNewMessage); ok {
		m, _ := v.Message.(*tg.Message)
		return m
	}
	return nil
}
