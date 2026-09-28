// Command test is a throwaway exploration tool for the TasklyBridge project.
//
// It logs in as a real Telegram account, opens a chat with a target bot, crawls
// whatever menu it finds, and writes down the bot's format so the real bridge
// can be built against facts instead of guesses. Nothing about any particular
// bot is hardcoded: the target, limits and probe text all come from the
// environment.
//
//	go run ./Test              crawl the bot, then hand over to an interactive prompt
//	go run ./Test -no-crawl    skip the crawl, interactive prompt only
//	go run ./Test -selftest    offline checks, no network and no login
//
// Credentials come from Test/.env (gitignored). Never commit that file.
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/gotd/td/session"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/tg"
)

// ---------------------------------------------------------------- config ----

// Settings live at package scope: one process, one account, one target, so
// threading a struct through every function would be noise.
var (
	apiID        int
	apiHash      string
	phone        string
	password     string
	sessionPath  string
	targetBot    string
	outDir       string
	historyLimit int

	// step pacing only; there is no crawler any more
	stepDelay     time.Duration
	stepQuiet     time.Duration
	stepReplyWait time.Duration

	// modeLogin signs in, saves the session and exits.
	// modeNoRepl exits once the plan is done instead of waiting for input.
	modeLogin  bool
	modeNoRepl bool

	// planPath is the plan to execute; empty means just the interactive prompt.
	planPath string

	// targetUserID is the bot's user id, resolved once at connect. It is at
	// package scope because the persisted screen records which bot it belongs
	// to, so a stale screen is never used against a different bot.
	targetUserID int64
)

// stepConfig is the pacing and lookup limits the runner uses between actions.
func stepConfig() stepSettings {
	return stepSettings{
		delay:        stepDelay,
		quiet:        stepQuiet,
		replyTimeout: stepReplyWait,
		// A cold run has an empty memory window, so it has to read the
		// conversation to find any button at all. Keep this well above zero.
		history: max(historyLimit, 20),
	}
}

func loadConfig() error {
	// Credentials come from Test/.env. Check the working directory first so the
	// probe also works from inside Test/, then fall back to the repo root.
	if err := loadDotEnv(".env"); err != nil {
		return fmt.Errorf("read .env: %w", err)
	}
	if err := loadDotEnv(filepath.Join("Test", ".env")); err != nil {
		return fmt.Errorf("read Test/.env: %w", err)
	}

	var err error
	rawID := strings.TrimSpace(os.Getenv("TG_API_ID"))
	if rawID == "" {
		return errors.New("TG_API_ID not set - get it from https://my.telegram.org (API tools -> Create application)")
	}
	if v, convErr := strconv.Atoi(rawID); convErr == nil {
		apiID = v
	} else {
		return fmt.Errorf("TG_API_ID is not a number: %w", convErr)
	}
	if apiHash = os.Getenv("TG_API_HASH"); apiHash == "" {
		return errors.New("TG_API_HASH not set - same place as TG_API_ID")
	}
	phone = os.Getenv("TG_PHONE")
	password = os.Getenv("TG_PASSWORD")

	sessionPath = envOr("TG_SESSION", filepath.Join("Test", "sessions", "probe.session"))
	targetBot = strings.TrimPrefix(envOr("TG_TARGET", ""), "@")
	outDir = envOr("TG_OUT", filepath.Join("Test", "out"))

	historyLimit, err = envInt("TG_HISTORY", 20)
	if err != nil {
		return err
	}

	secs, err := envFloat("TG_DELAY", 0.4)
	if err != nil {
		return err
	}
	stepDelay = time.Duration(secs * float64(time.Second))
	replySecs, err := envFloat("TG_REPLY_TIMEOUT", 45)
	if err != nil {
		return err
	}
	stepReplyWait = time.Duration(replySecs * float64(time.Second))
	// How long the bot must stay silent before its reply counts as finished.
	quietSecs, err := envFloat("TG_QUIET", 0.35)
	if err != nil {
		return err
	}
	stepQuiet = time.Duration(quietSecs * float64(time.Second))

	// Login mode never touches the target bot, so it must not demand one.
	if targetBot == "" && !modeLogin {
		return errors.New("TG_TARGET not set - the bot to explore, e.g. TG_TARGET=some_bot")
	}
	for _, dir := range []string{filepath.Dir(sessionPath), outDir} {
		if err = os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("create %s: %w", dir, err)
		}
	}
	return nil
}

func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) (int, error) {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("%s is not a number: %w", key, err)
	}
	return n, nil
}

func envFloat(key string, def float64) (float64, error) {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def, nil
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return 0, fmt.Errorf("%s is not a number: %w", key, err)
	}
	return f, nil
}

// loadDotEnv is a 15-line KEY=VALUE reader so the probe needs no dependency.
// Real environment variables always win, so Railway/CI behaviour is unchanged.
func loadDotEnv(path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		val = strings.Trim(strings.TrimSpace(val), `"'`)
		if _, exists := os.LookupEnv(key); !exists {
			_ = os.Setenv(key, val)
		}
	}
	return nil
}

// ------------------------------------------------------------------- main ---

func main() {
	selftest := flag.Bool("selftest", false, "run offline checks and exit")
	login := flag.Bool("login", false, "sign in, save the session, and exit")
	plan := flag.String("plan", "", "plan file to execute, e.g. Test/plan.txt (default from TG_PLAN)")
	interactive := flag.Bool("interactive", false, "run the plan, then hand over to the prompt")
	flag.Parse()

	switch {
	case *selftest:
		if err := selfTest(); err != nil {
			fmt.Println("SELFTEST FAILED:", err)
			os.Exit(1)
		}
		fmt.Println("SELFTEST OK")
		return
	case *login:
		modeLogin, modeNoRepl = true, true
		os.Setenv("TG_HISTORY", "0")
	default:
		planPath = *plan
		if planPath == "" {
			planPath = envOr("TG_PLAN", "")
		}
		if !*interactive {
			modeNoRepl = true
		}
	}

	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run() error {
	if err := loadConfig(); err != nil {
		return err
	}
	rec, err := newRecorder(outDir)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// A small window of the newest bot messages, so a plan can look back at
	// what was said and which buttons were on offer.
	inbox := newRecent(40)
	inbox.saveDir = outDir
	ignored := 0

	// Live arrivals. The runner blocks on this rather than sleeping, so it
	// always waits for the real reply instead of a guessed delay. It must
	// never block Telegram's read loop, so a full channel drops a message
	// rather than stalling the connection, and the run reports the loss.
	arrivals := make(chan *tg.Message, 256)

	// Declared before the handler below, which reports every arrival.
	run := &runner{rec: rec, in: inbox, inbox: arrivals, cfg: stepConfig()}

	// Set once the target bot is resolved (package var targetUserID). Every
	// incoming message is checked against it and anything else is dropped,
	// because this account sits in dozens of channels that would otherwise
	// bury the transcript.

	client := telegram.NewClient(apiID, apiHash, telegram.Options{
		SessionStorage: &session.FileStorage{Path: sessionPath},
		Device:         telegram.DeviceTDesktopWindows(),
		UpdateHandler: telegram.UpdateHandlerFunc(func(_ context.Context, u tg.UpdatesClass) error {
			m := extractMessage(u)
			if m == nil {
				return nil
			}
			// Allowlist, not denylist: only the target bot's chat gets in.
			pu, ok := m.PeerID.(*tg.PeerUser)
			if !ok || pu.UserID != targetUserID {
				ignored++
				return nil
			}
			rec.add(dumpMessage(m))
			inbox.add(m)
			run.noteArrival(m)
			return nil
		}),
	})

	fmt.Printf("account : %s\n", phone)
	fmt.Printf("session : %s\n", sessionPath)
	fmt.Printf("bot     : @%s\n", targetBot)
	fmt.Printf("transcript : %s\n", rec.path("transcript.txt"))
	if planPath != "" {
		if body, err := readPlan(planPath); err == nil {
			fmt.Printf("plan    : %s\n\n%s\n", planPath, body)
		}
	}
	fmt.Println()

	return client.Run(ctx, func(ctx context.Context) error {
		api := client.API()

		if err := authorize(ctx, client); err != nil {
			return err
		}

		// Login mode stops here: the session is on disk and the target bot is
		// never contacted.
		if modeLogin {
			self, _ := client.Self(ctx)
			who := "the account"
			if self != nil {
				who = fmt.Sprintf("%s (%d)", strings.TrimSpace(self.FirstName+" "+self.LastName), self.ID)
				if self.Phone != "" {
					who += " +" + self.Phone
				}
			}
			fmt.Printf("\nsigned in as %s\n", who)
			fmt.Printf("session saved to %s\n", sessionPath)
			fmt.Println("\nnothing was sent to any bot. ready for a plan.")
			return nil
		}

		peer, id, err := resolveTarget(ctx, api, targetBot)
		if err != nil {
			return err
		}
		targetUserID = id

		// The runner needs the live client and the resolved peer; the rest of
		// it was built before the client existed.
		run.ctx, run.api, run.peer = ctx, api, peer

		if historyLimit > 0 {
			msgs, err := flattenHistory(ctx, api, peer, historyLimit)
			if err != nil {
				return err
			}
			rec.addNote("existing history: %d message(s) from @%s", len(msgs), targetBot)
			for _, m := range msgs {
				rec.add(dumpMessage(m))
				inbox.add(m)
			}
		}

		if planPath != "" {
			if err := run.run(planPath); err != nil {
				return err
			}
		}
		if ignored > 0 {
			rec.addNote("filtered out %d message(s) from other chats", ignored)
		}
		if modeNoRepl {
			fmt.Println("\nplan done, exiting (session kept)")
			return nil
		}

		return repl(ctx, api, peer, rec)
	})
}

func authorize(ctx context.Context, client *telegram.Client) error {
	status, err := client.Auth().Status(ctx)
	if err != nil {
		return fmt.Errorf("auth status: %w", err)
	}
	if status.Authorized {
		name := "?"
		if status.User != nil {
			name = status.User.FirstName
		}
		fmt.Printf("already signed in as %s\n\n", name)
		return nil
	}
	if phone == "" {
		return errors.New("TG_PHONE not set - the account to explore with")
	}
	if !strings.HasPrefix(phone, "+") {
		phone = "+" + phone
	}

	sent, err := client.Auth().SendCode(ctx, phone, auth.SendCodeOptions{AllowAppHash: true})
	if err != nil {
		return fmt.Errorf("send code (check api_id/api_hash/phone): %w", err)
	}
	sc, ok := sent.(*tg.AuthSentCode)
	if !ok {
		return fmt.Errorf("unexpected sent-code type %T", sent)
	}

	code, err := prompt("code from Telegram: ")
	if err != nil {
		return err
	}

	if _, err := client.Auth().SignIn(ctx, phone, strings.TrimSpace(code), sc.PhoneCodeHash); err != nil {
		if !errors.Is(err, auth.ErrPasswordAuthNeeded) {
			return fmt.Errorf("sign in: %w", err)
		}
		pw := password
		if pw == "" {
			if pw, err = prompt("2FA password: "); err != nil {
				return err
			}
		}
		if _, err := client.Auth().Password(ctx, strings.TrimSpace(pw)); err != nil {
			return fmt.Errorf("2FA: %w", err)
		}
	}

	fmt.Println("signed in, session saved")
	return nil
}

func resolveTarget(ctx context.Context, api *tg.Client, username string) (tg.InputPeerClass, int64, error) {
	rp, err := api.ContactsResolveUsername(ctx, &tg.ContactsResolveUsernameRequest{Username: username})
	if err != nil {
		return nil, 0, fmt.Errorf("resolve @%s: %w", username, err)
	}
	for _, u := range rp.Users {
		user, ok := u.(*tg.User)
		if !ok {
			continue
		}
		if user.Bot {
			return &tg.InputPeerUser{UserID: user.ID, AccessHash: user.AccessHash}, user.ID, nil
		}
	}
	return nil, 0, fmt.Errorf("@%s resolved but contains no bot", username)
}

// ------------------------------------------------------------------- repl ---

// After the crawl finishes the tool stays interactive, so anything the crawler
// skipped or could not reach can be tried by hand.
func repl(ctx context.Context, api *tg.Client, peer tg.InputPeerClass, rec *recorder) error {
	fmt.Println("---------------------------------------------")
	fmt.Println("type a message to send it, or:")
	fmt.Println("  /start                 send /start to the bot")
	fmt.Println("  /press <msgid> <data>  press a button by its callback_data")
	fmt.Println("  /history [n]           re-dump the last n messages")
	fmt.Println("  /quit                  exit (session is kept)")
	fmt.Println("---------------------------------------------")

	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 0, 64*1024), 1<<20)

	for {
		select {
		case <-ctx.Done():
			fmt.Println("\ninterrupted, session kept")
			return nil
		default:
		}

		fmt.Print("\n> ")
		if !in.Scan() {
			fmt.Println("\neof, session kept")
			return nil
		}
		line := strings.TrimSpace(in.Text())
		if line == "" {
			continue
		}

		switch {
		case line == "/quit" || line == "/exit":
			fmt.Println("bye, session kept")
			return nil

		case line == "/start":
			if _, err := api.MessagesStartBot(ctx, &tg.MessagesStartBotRequest{
				Peer:     peer,
				RandomID: time.Now().UnixNano(),
			}); err != nil {
				fmt.Println("start failed:", err)
			} else {
				fmt.Println("sent /start")
			}

		case strings.HasPrefix(line, "/press "):
			args := strings.SplitN(strings.TrimPrefix(line, "/press "), " ", 2)
			if len(args) != 2 {
				fmt.Println("usage: /press <msgid> <callback_data>")
				continue
			}
			msgID, convErr := strconv.Atoi(args[0])
			if convErr != nil {
				fmt.Println("msgid must be a number")
				continue
			}
			if _, err := api.MessagesGetBotCallbackAnswer(ctx, &tg.MessagesGetBotCallbackAnswerRequest{
				Peer: peer, MsgID: msgID, Data: []byte(args[1]),
			}); err != nil {
				fmt.Println("press failed:", err)
			} else {
				fmt.Printf("pressed button on message %d\n", msgID)
			}

		case line == "/history" || strings.HasPrefix(line, "/history "):
			n := historyLimit
			if v := strings.TrimSpace(strings.TrimPrefix(line, "/history")); v != "" {
				if parsed, convErr := strconv.Atoi(v); convErr == nil {
					n = parsed
				}
			}
			msgs, err := flattenHistory(ctx, api, peer, n)
			if err != nil {
				fmt.Println("history failed:", err)
				continue
			}
			for _, m := range msgs {
				rec.add(dumpMessage(m))
			}
			fmt.Printf("dumped %d message(s)\n", len(msgs))

		default:
			// Plain input is a message to the bot. Space it out: Telegram
			// flood-controls bursts and the tool should look human.
			if stepDelay > 0 {
				time.Sleep(stepDelay)
			}
			if _, err := api.MessagesSendMessage(ctx, &tg.MessagesSendMessageRequest{
				Peer:     peer,
				Message:  line,
				RandomID: time.Now().UnixNano(),
			}); err != nil {
				fmt.Println("send failed:", err)
			} else {
				fmt.Println("sent")
			}
		}
	}
}

func prompt(label string) (string, error) {
	fmt.Print(label)
	s, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil && s == "" {
		return "", err
	}
	return s, nil
}
