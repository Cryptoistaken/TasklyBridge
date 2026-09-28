package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gotd/td/tg"
)

// ------------------------------------------------------------- transcript ---

// record is one captured message, appended to transcript.jsonl (machine
// readable) and transcript.txt (human readable).
type record struct {
	Time     string   `json:"time"`
	MsgID    int      `json:"msg_id"`
	Out      bool     `json:"out"`
	Peer     string   `json:"peer"`
	Text     string   `json:"text"`
	Entities []string `json:"entities,omitempty"`
	Buttons  []string `json:"buttons,omitempty"`
	Media    string   `json:"media,omitempty"`
	ReplyTo  int      `json:"reply_to,omitempty"`
	Note     string   `json:"note,omitempty"`
}

type recorder struct {
	mu  sync.Mutex
	dir string

	// Running tallies, so the report never has to re-parse its own output.
	entities map[string]int
	media    map[string]bool
}

func newRecorder(dir string) (*recorder, error) {
	// Truncate so each run is one clean, readable transcript.
	for _, name := range []string{"transcript.jsonl", "transcript.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0o600); err != nil {
			return nil, err
		}
	}
	return &recorder{
		dir:      dir,
		entities: map[string]int{},
		media:    map[string]bool{},
	}, nil
}

func (r *recorder) add(rec record) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for _, e := range rec.Entities {
		// "messageEntityBold[0:4]" -> "messageEntityBold"
		label := e
		if i := strings.IndexByte(label, '['); i >= 0 {
			label = label[:i]
		}
		r.entities[label]++
	}
	if rec.Media != "" {
		r.media[rec.Media] = true
	}

	if line, err := json.Marshal(rec); err == nil {
		r.append("transcript.jsonl", string(line)+"\n")
	}

	var sb strings.Builder
	dir := "IN "
	if rec.Out {
		dir = "OUT"
	}
	fmt.Fprintf(&sb, "%s  %s id=%-6d peer=%s\n", rec.Time, dir, rec.MsgID, rec.Peer)
	fmt.Fprintf(&sb, "   text: %s\n", oneline(rec.Text))
	for _, e := range rec.Entities {
		fmt.Fprintf(&sb, "   fmt:  %s\n", e)
	}
	for _, b := range rec.Buttons {
		fmt.Fprintf(&sb, "   btn:  %s\n", b)
	}
	if rec.Media != "" {
		fmt.Fprintf(&sb, "   media: %s\n", rec.Media)
	}
	if rec.ReplyTo != 0 {
		fmt.Fprintf(&sb, "   reply_to: %d\n", rec.ReplyTo)
	}
	if rec.Note != "" {
		fmt.Fprintf(&sb, "   note: %s\n", rec.Note)
	}

	r.append("transcript.txt", sb.String())
	fmt.Print(sb.String())
}

func (r *recorder) addNote(format string, args ...any) {
	r.add(record{Note: fmt.Sprintf(format, args...)})
}

func (r *recorder) path(name string) string { return filepath.Join(r.dir, name) }

// summary returns copies of the tallies, safe to read while recording is live.
func (r *recorder) summary() (map[string]int, map[string]bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ent := make(map[string]int, len(r.entities))
	for k, v := range r.entities {
		ent[k] = v
	}
	med := make(map[string]bool, len(r.media))
	for k, v := range r.media {
		med[k] = v
	}
	return ent, med
}

func (r *recorder) append(name, body string) {
	f, err := os.OpenFile(filepath.Join(r.dir, name), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(body)
}

// oneline collapses newlines so multi-line replies stay greppable.
func oneline(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\n", "\\n")
}

// ------------------------------------------------------------- the dumper ---

func dumpMessage(m *tg.Message) record {
	rec := record{
		Time:     time.Unix(int64(m.Date), 0).Format("2006-01-02 15:04:05"),
		MsgID:    m.ID,
		Out:      m.Out,
		Peer:     peerName(m.PeerID),
		Text:     m.Message,
		Entities: dumpEntities(m.Entities),
		Buttons:  dumpMarkup(m.ReplyMarkup),
		Media:    dumpMedia(m.Media),
	}
	if h, ok := m.ReplyTo.(*tg.MessageReplyHeader); ok && h != nil {
		rec.ReplyTo = h.ReplyToMsgID
	}
	return rec
}

func peerName(p tg.PeerClass) string {
	switch v := p.(type) {
	case *tg.PeerUser:
		return fmt.Sprintf("user:%d", v.UserID)
	case *tg.PeerChat:
		return fmt.Sprintf("chat:%d", v.ChatID)
	case *tg.PeerChannel:
		return fmt.Sprintf("channel:%d", v.ChannelID)
	case nil:
		return "-"
	default:
		return fmt.Sprintf("%T", p)
	}
}

// dumpEntities leans on the generated interface: TypeName, GetOffset and
// GetLength cover every entity type, present and future, with no switch to
// forget to update.
func dumpEntities(ents []tg.MessageEntityClass) []string {
	if len(ents) == 0 {
		return nil
	}
	out := make([]string, 0, len(ents))
	for _, e := range ents {
		if e == nil {
			continue
		}
		s := fmt.Sprintf("%s[%d:%d]", e.TypeName(), e.GetOffset(), e.GetLength())
		if u, ok := e.(*tg.MessageEntityTextURL); ok {
			s += " url=" + u.URL
		}
		if p, ok := e.(*tg.MessageEntityPre); ok {
			s += " lang=" + p.Language
		}
		out = append(out, s)
	}
	return out
}

// dumpMarkup walks any reply markup. Unknown types print %T on purpose: a
// silently dropped button is far worse than a noisy one.
func dumpMarkup(m tg.ReplyMarkupClass) []string {
	switch v := m.(type) {
	case nil:
		return nil
	case *tg.ReplyKeyboardHide:
		return []string{"keyboard_hide"}
	case *tg.ReplyKeyboardForceReply:
		return []string{"keyboard_force_reply"}
	case *tg.ReplyInlineMarkup:
		var out []string
		for i, row := range v.Rows {
			for j, b := range row.Buttons {
				out = append(out, fmt.Sprintf("r%d c%d inline %s", i, j, dumpInlineButton(b)))
			}
		}
		return out
	case *tg.ReplyKeyboardMarkup:
		var out []string
		for i, row := range v.Rows {
			for j, b := range row.Buttons {
				out = append(out, fmt.Sprintf("r%d c%d reply %s", i, j, dumpReplyButton(b)))
			}
		}
		return out
	default:
		return []string{fmt.Sprintf("UNKNOWN markup %T", m)}
	}
}

func dumpInlineButton(b tg.KeyboardInlineButton) string {
	base := fmt.Sprintf("text=%q", b.Text)
	switch t := b.Type.(type) {
	case *tg.InlineButtonTypeCallback:
		return fmt.Sprintf("callback text=%q data=%q hex=%s needs_password=%v",
			base, string(t.Data), hex.EncodeToString(t.Data), t.RequiresPassword)
	case *tg.InlineButtonTypeURL:
		return fmt.Sprintf("url text=%q -> %q", base, t.URL)
	default:
		// %+v keeps every field, so a type we did not anticipate still
		// shows its payload.
		return fmt.Sprintf("%T text=%q %+v", b.Type, base, b.Type)
	}
}

func dumpReplyButton(b tg.KeyboardButton) string {
	base := fmt.Sprintf("text=%q", b.Text)
	switch t := b.Type.(type) {
	case *tg.ButtonTypeRequestPhone:
		return "request_phone " + base
	case *tg.ButtonTypeRequestGeoLocation:
		return "request_geo " + base
	case *tg.ButtonTypeDefault:
		return "default " + base
	default:
		return fmt.Sprintf("%T text=%q %+v", b.Type, base, t)
	}
}

func dumpMedia(md tg.MessageMediaClass) string {
	switch v := md.(type) {
	case nil:
		return ""
	case *tg.MessageMediaEmpty:
		return ""
	case *tg.MessageMediaPhoto:
		// The inner class is an interface; its concrete type is what tells us
		// whether the photo actually arrived or is still a placeholder.
		return fmt.Sprintf("photo inner=%T", v.Photo)
	case *tg.MessageMediaDocument:
		return fmt.Sprintf("document inner=%T", v.Document)
	case *tg.MessageMediaGeo:
		return "geo"
	case *tg.MessageMediaContact:
		return "contact"
	case *tg.MessageMediaUnsupported:
		return "unsupported"
	case *tg.MessageMediaWebPage:
		return "webpage"
	default:
		return fmt.Sprintf("UNKNOWN media %T", md)
	}
}

// extractMessage pulls a message out of whatever update shape Telegram used.
//
// The two update families are different types: *tg.Updates and the *Short
// variants are UpdatesClass, while *tg.UpdateNewMessage and friends are
// UpdateClass and only ever arrive nested inside one. The "short" variants also
// carry the body as a plain string with no *tg.Message, so they get rebuilt
// into one to keep a single shape downstream.
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
			ID:       v.ID,
			Out:      v.Out,
			Date:     v.Date,
			Message:  v.Message,
			Entities: v.Entities,
			ReplyTo:  v.ReplyTo,
			PeerID:   &tg.PeerUser{UserID: v.UserID},
		}
	case *tg.UpdateShortChatMessage:
		return &tg.Message{
			ID:       v.ID,
			Out:      v.Out,
			Date:     v.Date,
			Message:  v.Message,
			Entities: v.Entities,
			ReplyTo:  v.ReplyTo,
			PeerID:   &tg.PeerChat{ChatID: v.ChatID},
		}
	}
	return nil
}

func extractUpdate(u tg.UpdateClass) *tg.Message {
	switch v := u.(type) {
	case *tg.UpdateNewMessage:
		m, _ := v.Message.(*tg.Message)
		return m
	case *tg.UpdateNewChannelMessage:
		m, _ := v.Message.(*tg.Message)
		return m
	case *tg.UpdateEditMessage:
		m, _ := v.Message.(*tg.Message)
		return m
	case *tg.UpdateEditChannelMessage:
		m, _ := v.Message.(*tg.Message)
		return m
	default:
		return nil
	}
}

// flattenHistory normalises both getHistory result shapes into []*tg.Message.
func flattenHistory(ctx context.Context, api *tg.Client, peer tg.InputPeerClass, limit int) ([]*tg.Message, error) {
	res, err := api.MessagesGetHistory(ctx, &tg.MessagesGetHistoryRequest{Peer: peer, Limit: limit})
	if err != nil {
		return nil, fmt.Errorf("getHistory: %w", err)
	}

	switch v := res.(type) {
	case *tg.MessagesMessages:
		return pickMessages(v.Messages), nil
	case *tg.MessagesMessagesSlice:
		// A slice carries MessageEmpty placeholders holding only IDs, so the
		// real bodies have to be fetched by ID.
		ids := make([]tg.InputMessageClass, 0, len(v.Messages))
		for _, m := range v.Messages {
			if empty, ok := m.(*tg.MessageEmpty); ok {
				ids = append(ids, &tg.InputMessageID{ID: empty.ID})
			}
		}
		if len(ids) == 0 {
			return nil, nil
		}
		got, err := api.MessagesGetMessages(ctx, ids)
		if err != nil {
			return nil, fmt.Errorf("getMessages: %w", err)
		}
		if mm, ok := got.(*tg.MessagesMessages); ok {
			return pickMessages(mm.Messages), nil
		}
		return nil, fmt.Errorf("unexpected getMessages shape %T", got)
	default:
		return nil, fmt.Errorf("unexpected getHistory shape %T", res)
	}
}

func pickMessages(in []tg.MessageClass) []*tg.Message {
	out := make([]*tg.Message, 0, len(in))
	for _, m := range in {
		if msg, ok := m.(*tg.Message); ok {
			out = append(out, msg)
		}
	}
	return out
}

// -------------------------------------------------------------- self test ---

// selfTest asserts the dump and crawl logic against hand-built values. No
// network, no Telegram account, so it can gate every change here.
func selfTest() error {
	// 1. plain text, no markup
	r1 := dumpMessage(&tg.Message{
		ID: 1, Date: 1700000000, Message: "hello", PeerID: &tg.PeerUser{UserID: 42},
	})
	assert(r1.Text == "hello", "plain text kept, got %q", r1.Text)
	assert(len(r1.Buttons) == 0, "plain message has no buttons")
	assert(r1.Media == "", "plain message has no media")
	assert(r1.Peer == "user:42", "peer decoded, got %q", r1.Peer)

	// 2. formatting entities carry type + offset + length
	r2 := dumpMessage(&tg.Message{
		ID: 2, Date: 1700000000, Message: "bold words", PeerID: &tg.PeerUser{UserID: 42},
		Entities: []tg.MessageEntityClass{&tg.MessageEntityBold{Offset: 0, Length: 4}},
	})
	assert(len(r2.Entities) == 1, "one entity dumped, got %d", len(r2.Entities))
	assert(strings.Contains(r2.Entities[0], "Bold") && strings.Contains(r2.Entities[0], "[0:4]"),
		"entity type and range, got %q", r2.Entities[0])

	// 3. inline buttons expose raw callback_data
	r3 := dumpMessage(&tg.Message{
		ID: 3, Date: 1700000000, Message: "pick one", PeerID: &tg.PeerUser{UserID: 42},
		ReplyMarkup: &tg.ReplyInlineMarkup{Rows: []tg.KeyboardInlineButtonRow{{
			Buttons: []tg.KeyboardInlineButton{
				{Text: "Add", Type: &tg.InlineButtonTypeCallback{Data: []byte("add:1")}},
				{Text: "Docs", Type: &tg.InlineButtonTypeURL{URL: "https://example.com"}},
			},
		}}},
	})
	assert(len(r3.Buttons) == 2, "two buttons dumped, got %d", len(r3.Buttons))
	assert(strings.Contains(r3.Buttons[0], `data="add:1"`), "callback_data captured, got %q", r3.Buttons[0])
	assert(strings.Contains(r3.Buttons[0], "6164643a31"), "callback_data hex captured, got %q", r3.Buttons[0])
	assert(strings.Contains(r3.Buttons[1], "https://example.com"), "url button captured, got %q", r3.Buttons[1])

	// 4. non-inline keyboard is reported too
	r4 := dumpMessage(&tg.Message{
		ID: 4, Date: 1700000000, PeerID: &tg.PeerUser{UserID: 42},
		ReplyMarkup: &tg.ReplyKeyboardMarkup{Rows: []tg.KeyboardButtonRow{{
			Buttons: []tg.KeyboardButton{{Text: "One", Type: &tg.ButtonTypeDefault{}}},
		}}},
	})
	assert(len(r4.Buttons) == 1 && strings.Contains(r4.Buttons[0], `"One"`),
		"reply keyboard captured, got %v", r4.Buttons)

	// 5. keyboard_hide is typed
	r5 := dumpMessage(&tg.Message{
		ID: 5, Date: 1700000000, PeerID: &tg.PeerUser{UserID: 42},
		ReplyMarkup: &tg.ReplyKeyboardHide{},
	})
	assert(len(r5.Buttons) == 1 && strings.Contains(r5.Buttons[0], "keyboard_hide"),
		"keyboard_hide reported, got %v", r5.Buttons)

	// 6. media is typed
	r6 := dumpMessage(&tg.Message{
		ID: 6, Date: 1700000000, PeerID: &tg.PeerUser{UserID: 42}, Media: &tg.MessageMediaGeo{},
	})
	assert(r6.Media == "geo", "geo media typed, got %q", r6.Media)

	// 7. update extraction covers both update families
	m := &tg.Message{ID: 7, Date: 1700000000, PeerID: &tg.PeerUser{UserID: 42}}
	sm := extractMessage(&tg.UpdateShortMessage{ID: 7, UserID: 42, Date: 1700000000, Message: "hi"})
	assert(sm != nil && sm.Message == "hi" && peerName(sm.PeerID) == "user:42",
		"short user message rebuilt, got %+v", sm)
	sc := extractMessage(&tg.UpdateShortChatMessage{ID: 8, ChatID: -99, Date: 1700000000, Message: "yo"})
	assert(sc != nil && peerName(sc.PeerID) == "chat:-99", "short chat message rebuilt, got %+v", sc)
	assert(extractMessage(&tg.Updates{Updates: []tg.UpdateClass{
		&tg.UpdateNewMessage{Message: m},
	}}) == m, "new message found inside an updates batch")
	assert(extractMessage(&tg.Updates{Updates: []tg.UpdateClass{
		&tg.UpdateNewChannelMessage{Message: m},
	}}) == m, "channel message found inside an updates batch")
	assert(extractUpdate(&tg.UpdateBotCallbackQuery{QueryID: 1}) == nil,
		"callback query yields no message")

	// 8. newlines collapse in the text log without corrupting content
	dir, err := os.MkdirTemp("", "probe")
	if err != nil {
		return fmt.Errorf("temp dir: %w", err)
	}
	defer os.RemoveAll(dir)
	rec := &recorder{dir: dir}
	rec.add(record{Time: "t", MsgID: 1, Peer: "selftest", Text: "line1\nline2"})
	logBody, err := os.ReadFile(filepath.Join(dir, "transcript.txt"))
	if err != nil {
		return fmt.Errorf("read transcript: %w", err)
	}
	assert(strings.Contains(string(logBody), `line1\nline2`), "newline collapsed in log, got %q", logBody)

	// 9. the safety guard must catch destructive labels and let safe ones pass
	assert(looksRisky("Delete account"), "delete is treated as risky")
	assert(looksRisky("pay_now"), "risky word inside callback_data is caught")
	assert(looksRisky("CONFIRM"), "check is case-insensitive")
	assert(!looksRisky("Add task"), "benign label allowed")
	assert(!looksRisky("back"), "benign label allowed")

	// 10. a reply-keyboard button must resolve to a send-its-label action,
	//     and a share-phone button must resolve to nothing pressable
	keyb := &tg.Message{
		ID: 10, Date: 1700000000, PeerID: &tg.PeerUser{UserID: 42},
		ReplyMarkup: &tg.ReplyKeyboardMarkup{Rows: []tg.KeyboardButtonRow{
			{Buttons: []tg.KeyboardButton{
				{Text: "💰 Balance", Type: &tg.ButtonTypeDefault{}},
				{Text: "📤 Withdraw", Type: &tg.ButtonTypeDefault{}},
			}},
			{Buttons: []tg.KeyboardButton{
				{Text: "Share phone", Type: &tg.ButtonTypeRequestPhone{}},
			}},
		}},
	}
	btns := collectButtons(keyb)
	assert(len(btns) == 3, "three buttons collected, got %d", len(btns))
	assert(btns[0].Kind == "text" && btns[0].Label == "💰 Balance",
		"reply button sends its own label, got %+v", btns[0])
	assert(btns[2].Kind == "noop", "share-phone button is not pressable, got %+v", btns[2])

	// 11. click must match a label and remember how to activate it
	got, seen := findButton([]*tg.Message{keyb}, "Balance")
	assert(got.Label == "💰 Balance" && got.Kind == "text",
		"Balance found and resolves to a text send, got %+v", got)
	assert(len(seen) == 3, "every label is offered for diagnosis, got %d", len(seen))
	_, seen = findButton([]*tg.Message{keyb}, "Nonexistent")
	assert(len(seen) == 3, "a miss still lists what was on offer, got %d", len(seen))

	// 12. an inline callback must resolve to a press carrying its raw data
	inl := &tg.Message{
		ID: 11, Date: 1700000000, PeerID: &tg.PeerUser{UserID: 42},
		ReplyMarkup: &tg.ReplyInlineMarkup{Rows: []tg.KeyboardInlineButtonRow{{
			Buttons: []tg.KeyboardInlineButton{
				{Text: "👤 Find my place", Type: &tg.InlineButtonTypeCallback{Data: []byte("my_rank")}},
				{Text: "Help", Type: &tg.InlineButtonTypeURL{URL: "https://example.com"}},
			},
		}}},
	}
	got, _ = findButton([]*tg.Message{inl}, "Find my place")
	assert(got.Kind == "callback" && got.Data == "my_rank" && got.MsgID == 11,
		"inline callback resolves to its raw data on the right message, got %+v", got)
	got, _ = findButton([]*tg.Message{inl}, "Help")
	assert(got.Kind == "noop", "url button is listed but not pressable, got %+v", got)

	// 13. the newest keyboard wins, since it is the live one
	newer := &tg.Message{
		ID: 12, Date: 1700000001, PeerID: &tg.PeerUser{UserID: 42},
		ReplyMarkup: &tg.ReplyKeyboardMarkup{Rows: []tg.KeyboardButtonRow{{
			Buttons: []tg.KeyboardButton{{Text: "Back", Type: &tg.ButtonTypeDefault{}}},
		}}},
	}
	got, _ = findButton([]*tg.Message{keyb, newer}, "Balance")
	assert(got.Label == "💰 Balance", "older keyboard still searched after a miss on the newest")

	// 14. mark/since must isolate one action's reply from earlier traffic.
	//     This is what stops a stale message being shown as the current screen.
	r := newRecent(10)
	old1 := &tg.Message{ID: 1, PeerID: &tg.PeerUser{UserID: 42}, Message: "old one"}
	r.add(old1)
	mark := r.mark()
	fresh := r.since(mark)
	assert(len(fresh) == 0, "nothing new before an action, got %d", len(fresh))
	new1 := &tg.Message{ID: 2, PeerID: &tg.PeerUser{UserID: 42}, Message: "the reply"}
	r.add(new1)
	fresh = r.since(mark)
	assert(len(fresh) == 1 && fresh[0].ID == 2, "only the new message is reported, got %+v", fresh)
	r.add(&tg.Message{ID: 3, PeerID: &tg.PeerUser{UserID: 42}, Message: "second part"})
	fresh = r.since(mark)
	assert(len(fresh) == 2, "a multi-part reply is reported whole, got %d", len(fresh))

	// 15. the window is bounded, and a mark older than the window must not
	//     resurrect messages that were dropped from it.
	tiny := newRecent(3)
	for i := 1; i <= 6; i++ {
		tiny.add(&tg.Message{ID: i, PeerID: &tg.PeerUser{UserID: 42}})
	}
	assert(tiny.lastMsg().ID == 6, "newest kept, got id=%d", tiny.lastMsg().ID)
	assert(len(tiny.since(0)) == 3, "only what is still in the window, got %d", len(tiny.since(0)))

	// 16. an empty window must report rather than panic
	blank := newRecent(4)
	assert(blank.lastMsg() == nil, "empty window has no last message")
	assert(blank.newestWithButtons() == nil, "empty window has no keyboard")
	assert(len(blank.withButtons()) == 0, "empty window offers no buttons")

	// 17. the saved screen must survive a round trip through disk, since a
	//     fresh process cannot otherwise resume. This is the check behind the
	//     claim that a single "click Start" is enough.
	dir2, err := os.MkdirTemp("", "screen")
	if err != nil {
		return fmt.Errorf("temp dir: %w", err)
	}
	defer os.RemoveAll(dir2)

	savedBot := targetBot
	targetBot = "tasklyBux_bot"

	live := newRecent(10)
	live.saveDir = dir2
	taskPage := &tg.Message{
		ID: 500, Date: 1700000000, Message: "Task page", PeerID: &tg.PeerUser{UserID: 42},
		ReplyMarkup: &tg.ReplyKeyboardMarkup{Rows: []tg.KeyboardButtonRow{
			{Buttons: []tg.KeyboardButton{{Text: "Start", Type: &tg.ButtonTypeDefault{}}}},
			{Buttons: []tg.KeyboardButton{{Text: "Cancel", Type: &tg.ButtonTypeDefault{}}}},
		}},
	}
	live.add(taskPage)
	if _, statErr := os.Stat(filepath.Join(dir2, "screen.json")); statErr != nil {
		return fmt.Errorf("screen was not written: %w", statErr)
	}

	// A brand new window, exactly as a new process would have.
	resumed := newRecent(10)
	resumed.saveDir = dir2
	saved, ok := resumed.restore()
	assert(ok, "saved screen must be restorable")
	assert(saved.MsgID == 500 && len(saved.Buttons) == 2, "saved screen intact, got %+v", saved)

	// The whole point: one click, no menu walk, no /start.
	resumedBtn, offered := findButton(resumed.withButtons(), "Start")
	assert(resumedBtn.Label == "Start" && resumedBtn.Kind == "text",
		"Start clickable straight off disk, got %+v", resumedBtn)
	assert(len(offered) == 2, "both saved buttons offered, got %d", len(offered))

	// A screen saved for a different bot must never be used. Keyed on the bot
	// name, because the numeric id is still zero when the first screen is
	// written and so cannot detect a stale file.
	other := newRecent(10)
	other.saveDir = dir2
	targetBot = "some_other_bot"
	_, ok = other.restore()
	assert(!ok, "a screen belonging to another bot is refused")
	targetBot = savedBot

	// A corrupt file must be refused, not half-applied.
	if err = os.WriteFile(filepath.Join(dir2, "screen.json"), []byte("{not json"), 0o600); err != nil {
		return fmt.Errorf("write corrupt screen: %w", err)
	}
	broken := newRecent(10)
	broken.saveDir = dir2
	_, ok = broken.restore()
	assert(!ok, "corrupt screen file is refused")

	return nil
}

func assert(cond bool, format string, args ...any) {
	if !cond {
		panic(fmt.Sprintf(format, args...))
	}
}
