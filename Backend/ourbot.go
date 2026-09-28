package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Our own bot, over the Bot API. No library: the surface needed here is
// getUpdates, sendMessage, editMessageText and answerCallbackQuery, which is
// less code than importing and configuring one.

type botUser struct {
	ID        int64  `json:"id"`
	Username  string `json:"username"`
	FirstName string `json:"first_name"`
}

type botChat struct {
	ID int64 `json:"id"`
}

type botMessage struct {
	MessageID int64    `json:"message_id"`
	From      *botUser `json:"from"`
	Chat      *botChat `json:"chat"`
	Text      string   `json:"text"`
}

type botCallback struct {
	ID      string      `json:"id"`
	From    *botUser    `json:"from"`
	Message *botMessage `json:"message"`
	Data    string      `json:"data"`
}

// inboundUpdate is the subset of Telegram's update we act on.
type inboundUpdate struct {
	UpdateID      int64        `json:"update_id"`
	Message       *botMessage  `json:"message"`
	CallbackQuery *botCallback `json:"callback_query"`
}

type inlineButton struct {
	Text         string `json:"text"`
	CallbackData string `json:"callback_data"`
}

type inlineKeyboard struct {
	InlineKeyboard [][]inlineButton `json:"inline_keyboard"`
}

type botClient struct {
	token string
	http  *http.Client
	audit *audit
}

func newBot(token string, a *audit) *botClient {
	return &botClient{
		token: token,
		http:  &http.Client{Timeout: 70 * time.Second}, // long polling blocks this long
		audit: a,
	}
}

func (b *botClient) call(method string, payload any, out any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	endpoint := fmt.Sprintf("https://api.telegram.org/bot%s/%s", b.token, method)

	resp, err := b.http.Post(endpoint, "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	var envelope struct {
		OK          bool            `json:"ok"`
		Description string          `json:"description"`
		Result      json.RawMessage `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		return err
	}
	if !envelope.OK {
		return fmt.Errorf("%s: %s", method, envelope.Description)
	}
	if out != nil && len(envelope.Result) > 0 {
		return json.Unmarshal(envelope.Result, out)
	}
	return nil
}

// getUpdates long-polls. The offset is what makes it a cursor rather than a
// repeat, so it is held by the caller across calls.
func (b *botClient) getUpdates(offset int64, timeoutSeconds int) ([]inboundUpdate, error) {
	var out []inboundUpdate
	err := b.call("getUpdates", map[string]any{
		"offset":  offset,
		"timeout": timeoutSeconds,
		// Only what we handle, so service messages do not wake the loop.
		"allowed_updates": []string{"message", "callback_query"},
	}, &out)
	return out, err
}

// checkBotReachable reports whether the token is usable and whether something
// else is already polling it.
//
// Only one process may hold a bot's getUpdates lock. When the service is
// deployed, a second copy on a laptop silently takes the lock away from
// production, and the symptom is a 60-second backoff loop rather than an
// error. Checking once at startup turns that into a clear message.
func (b *botClient) checkBotReachable() error {
	if _, err := b.me(); err != nil {
		return fmt.Errorf("the bot token was rejected: %w", err)
	}
	// A single short poll. On success the lock is ours for the next 25s; on
	// conflict, someone else has it.
	var probe []inboundUpdate
	err := b.call("getUpdates", map[string]any{
		"offset":          -1,
		"timeout":         0,
		"allowed_updates": []string{"message"},
	}, &probe)
	if err != nil && isDuplicateInstance(err) {
		return fmt.Errorf("another instance is already polling this bot.\n" +
			"If the service is deployed, stop the local copy: two processes " +
			"sharing one bot fight over the update stream and the deployed one goes silent.\n" +
			"Stop the deployed service first with: railway down")
	}
	return nil
}

func (b *botClient) sendMessage(chatID int64, text string, kb *inlineKeyboard) error {
	payload := map[string]any{"chat_id": chatID, "text": text}
	if kb != nil {
		payload["reply_markup"] = kb
	}
	return b.call("sendMessage", payload, nil)
}

func (b *botClient) answerCallback(id, text string) {
	_ = b.call("answerCallbackQuery", map[string]any{
		"callback_query_id": id, "text": text, "show_alert": false,
	}, nil)
}

func (b *botClient) me() (string, error) {
	var out struct {
		Username string `json:"username"`
	}
	err := b.call("getMe", map[string]any{}, &out)
	return out.Username, err
}

// runUpdates polls until the context is cancelled.
func (b *botClient) runUpdates(ctx context.Context, offset *int64, handle func(inboundUpdate)) {
	for ctx.Err() == nil {
		updates, err := b.getUpdates(*offset, 25)
		if err != nil {
			b.audit.log(legInternal, "poll-error", 0, err.Error(), nil)
			select {
			case <-ctx.Done():
				return
			case <-time.After(3 * time.Second):
			}
			continue
		}
		for _, u := range updates {
			*offset = u.UpdateID + 1
			handle(u)
		}
	}
}

// ---------------------------------------------------------------- handlers --

// handler holds what the message handlers need.
type handler struct {
	bot   *botClient
	audit *audit
	store *store
	tgt   *target
	// boundUser is the one Telegram user this MTProto account serves. The
	// account holds per-user state, so it cannot be shared between users.
	boundUser int64
	// cat is the sellable catalogue: which provider jobs we offer, what we
	// call them, and what end users are charged.
	cat *catalog
	// alerts reaches admins only, never end users. Used for cost warnings.
	alerts notifier
}

func (h *handler) handle(u inboundUpdate) {
	switch {
	case u.CallbackQuery != nil:
		h.onCallback(u.CallbackQuery)
	case u.Message != nil:
		h.onMessage(u.Message)
	}
}

func (h *handler) onMessage(m *botMessage) {
	if m.From == nil || m.Chat == nil {
		return
	}
	userID := m.From.ID

	kind := "message"
	if strings.HasPrefix(m.Text, "/") {
		kind = "command"
	}
	h.audit.log(legUserToBot, kind, userID, m.Text, nil)

	// One account serves one user, so anyone else is told the truth rather
	// than queued for an account that does not exist yet.
	if userID != h.boundUser {
		h.reply(userID, notWhitelisted)
		return
	}

	cmd := ""
	if fields := strings.Fields(m.Text); len(fields) > 0 {
		cmd = strings.ToLower(strings.SplitN(fields[0], "@", 2)[0])
	}

	switch cmd {
	case "/start":
		h.showTasks(userID)
	case "/exitjob", "/exit_job", "/stop":
		h.exitJob(userID)
	case "":
		h.forwardText(userID, m.Text)
	default:
		h.forwardText(userID, m.Text)
	}
}

// showTasks lists the job list read live from the provider.
func (h *handler) showTasks(userID int64) {
	if j, ok := h.store.get(userID); ok {
		h.reply(userID, fmt.Sprintf(
			"✅ You are in the *%s* task.\n\nSend your 2FA key, or /exitjob to leave.", j.TaskName))
		return
	}

	live, err := h.tgt.fetchTasks(catalogGroupFor(h.cat))
	if err != nil {
		h.audit.log(legInternal, "tasklist-error", userID, err.Error(), nil)
		h.reply(userID, "Could not read the job list from the provider. Try again in a moment.")
		return
	}
	offers := h.cat.resolve(live)
	hidden := hiddenFrom(live, offers)
	h.audit.log(legInternal, "jobs-filtered", userID,
		fmt.Sprintf("offering %d, hiding %d", len(offers), len(hidden)),
		map[string]string{
			"hidden": jobNames(hidden),
			"cost":   costLine(h.cat, offers),
		})

	// Warn an admin when the provider's cost has risen above what we charge.
	// This is silent for users: they are told the price we sell at, and it is
	// the operator's problem, not theirs.
	for _, o := range offers {
		if cost, losing := h.cat.sellingAtLoss(o); losing {
			h.audit.log(legInternal, "selling-at-loss", userID,
				fmt.Sprintf("%s: provider cost ~%s but we charge %s",
					o.Display, priceLabel(cost), priceLabel(o.SellBDT)), nil)
			if h.alerts != nil {
				_ = h.alerts.notify(fmt.Sprintf(
					"⚠️ %s costs about %s at the provider but we charge %s. We are losing money on it.",
					o.Display, priceLabel(cost), priceLabel(o.SellBDT)))
			}
		}
	}

	// The job can be out of stock on the provider's side. Say so rather than
	// showing an empty menu.
	if len(offers) == 0 {
		// Tell the operator *why*, because a withdrawn job and a catalogue
		// that no longer matches look identical from the outside, and only one
		// of them is self-healing.
		if h.alerts != nil {
			why := h.cat.describeMiss(live)
			h.audit.log(legInternal, "no-offers", userID, why, nil)
			_ = h.alerts.notify("🚨 Nothing is being offered.\n\n" + why)
		}
		h.reply(userID, "No jobs are available right now.\n\nPlease check back shortly.")
		return
	}

	// The job name and price appear only on the buttons, never in the message
	// text. Listing them in both places meant a user could read a price that
	// did not match the button they then tapped.
	rows := make([][]inlineButton, 0, len(offers))
	for i, o := range offers {
		// The index is the only reliably short callback token: a job name can
		// be long and Telegram caps callback_data at 64 bytes.
		rows = append(rows, []inlineButton{{
			Text:         o.label(),
			CallbackData: "job:" + strconv.Itoa(i),
		}})
	}

	h.audit.log(legBotToUser, "joblist", userID,
		fmt.Sprintf("%d job(s) offered", len(offers)), nil)
	_ = h.bot.sendMessage(userID, "Available jobs", &inlineKeyboard{InlineKeyboard: rows})
}

// catalogGroupFor picks the provider sub-menu the catalogue expects. All current
// jobs live under Cookies, so the first configured group is used.
func catalogGroupFor(cat *catalog) string {
	if cat == nil || len(cat.jobs) == 0 {
		return "cookie"
	}
	if g := strings.TrimSpace(cat.jobs[0].Group); g != "" {
		return g
	}
	return "cookie"
}

// costLine shows what the bridge pays and charges, for the audit log only. The
// provider price is a cost and is never sent to an end user, so it stays in
// dollars here while the sell price is the static Taka figure.
func costLine(cat *catalog, offers []offer) string {
	out := make([]string, 0, len(offers))
	for _, o := range offers {
		line := fmt.Sprintf("%s: provider cost $%.4f, we charge %s",
			o.Display, o.Provider.Price, priceLabel(o.SellBDT))
		if cost, losing := cat.sellingAtLoss(o); losing {
			line += fmt.Sprintf(" (LOSS: cost about %s)", priceLabel(cost))
		}
		out = append(out, line)
	}
	return truncate(strings.Join(out, " | "), 300)
}

// onCallback handles a tap on one of our own inline buttons.
func (h *handler) onCallback(c *botCallback) {
	if c.From == nil {
		return
	}
	userID := c.From.ID
	h.audit.log(legUserToBot, "tap", userID, c.Data, nil)
	h.bot.answerCallback(c.ID, "")

	if userID != h.boundUser {
		h.reply(userID, notWhitelistedShort)
		return
	}

	switch {
	case strings.HasPrefix(c.Data, "job:"):
		h.joinJob(userID, c.Data)
	case c.Data == "exit":
		h.exitJob(userID)
	}
}

func (h *handler) joinJob(userID int64, data string) {
	idx, err := strconv.Atoi(strings.TrimPrefix(data, "job:"))
	if err != nil {
		return
	}
	live, err := h.tgt.fetchTasks(catalogGroupFor(h.cat))
	if err != nil {
		h.audit.log(legInternal, "tasklist-error", userID, err.Error(), nil)
		h.reply(userID, "Could not read the job list from the provider. Try again in a moment.")
		return
	}
	// The offer list is rebuilt and re-validated here, not trusted from the
	// earlier /start. A tapped index refers to this list, so joining from an
	// unfiltered one would let a job we do not sell be started by guessing a
	// callback value.
	offers := h.cat.resolve(live)
	o, ok := h.cat.find(offers, idx)
	if !ok {
		h.audit.log(legInternal, "join-refused", userID,
			fmt.Sprintf("index %d outside the offered list of %d", idx, len(offers)), nil)
		h.reply(userID, "That job is not available. Send /start to see the current list.")
		return
	}
	task := o.Provider

	if err := h.store.set(userID, Join{
		TaskName: o.Display, TaskLabel: task.Label,
		Price: o.SellBDT, JoinedAt: time.Now(),
	}); err != nil {
		h.audit.log(legInternal, "store-error", userID, err.Error(), nil)
	}

	// The green tick confirmation, as specified. The price shown is the static
	// Taka figure, never the provider's dollar cost.
	confirmation := fmt.Sprintf("✅ You have joined *%s* task\n\nPrice: %s",
		o.Display, priceLabel(o.SellBDT))
	h.audit.log(legBotToUser, "joined", userID, confirmation, nil)
	_ = h.bot.sendMessage(userID, confirmation, exitKeyboard())

	// Drive the provider, then forward whatever it says.
	res, err := h.tgt.joinTask(task)
	if err != nil {
		h.audit.log(legInternal, "join-error", userID, err.Error(), nil)
		h.reply(userID, "The provider could not start that job. Send /exitjob and try again.")
		return
	}
	if res.Password != "" {
		h.reply(userID, fmt.Sprintf("🔑 *Your 2FA key*\n\n`%s`", res.Password))
		return
	}
	// No confirmed credential format yet, so the provider's own words go
	// through unchanged rather than a guessed pattern being passed off as fact.
	body := strings.Join(res.Replies, "\n\n")
	if body == "" {
		body = "The provider accepted the job but sent no details."
	}
	h.audit.log(legBotToUser, "provider-reply", userID, body, nil)
	_ = h.bot.sendMessage(userID, body, exitKeyboard())
}

func (h *handler) exitJob(userID int64) {
	j, ok := h.store.get(userID)
	if !ok {
		h.reply(userID, "You are not in a job right now. Send /start to see the list.")
		return
	}
	if err := h.store.clear(userID); err != nil {
		h.audit.log(legInternal, "store-error", userID, err.Error(), nil)
	}
	msg := fmt.Sprintf("🚪 You left the *%s* task.\n\nSend /start to pick another.", j.TaskName)
	h.audit.log(legBotToUser, "exited", userID, msg, nil)
	_ = h.bot.sendMessage(userID, msg, nil)
}

// forwardText relays free text to the provider unchanged.
func (h *handler) forwardText(userID int64, text string) {
	if _, ok := h.store.get(userID); !ok {
		h.reply(userID, "Join a job first: send /start and tap one.")
		return
	}
	if _, err := h.tgt.forward("forward", text); err != nil {
		h.audit.log(legInternal, "forward-error", userID, err.Error(), nil)
		h.reply(userID, "Could not reach the provider. Try again in a moment.")
	}
}

func (h *handler) reply(userID int64, text string) {
	h.audit.log(legBotToUser, "reply", userID, text, nil)
	_ = h.bot.sendMessage(userID, text, nil)
}

// jobNames renders a job list for the audit log, so a hidden job is visible to
// the operator even though end users never see it.
func jobNames(tasks []Task) string {
	out := make([]string, 0, len(tasks))
	for _, task := range tasks {
		out = append(out, fmt.Sprintf("%s $%.4f", task.Name, task.Price))
	}
	return truncate(strings.Join(out, " | "), 300)
}

func exitKeyboard() *inlineKeyboard {
	return &inlineKeyboard{InlineKeyboard: [][]inlineButton{{
		{Text: "🚪 Exit job  /exitjob", CallbackData: "exit"},
	}}}
}
