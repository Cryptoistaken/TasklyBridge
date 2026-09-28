// Command bridge is the TasklyBridge backend: one binary that does both sides.
//
//	user -> @OpenTasksBot  (Bot API)  ->  real Telegram account (MTProto)  ->  @TasklyBux_bot
//
// It owns a single real Telegram account, bound to a single end user, because
// the provider keeps per-chat state that cannot be shared.
//
//	main              run the bridge
//	main -list        read the provider's job list and exit
//	main -selftest    offline checks, no network, no login
package main

import (
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
	"github.com/gotd/td/tg"
)

// ---------------------------------------------------------------- config ----

var (
	apiID       int
	apiHash     string
	sessionPath string
	targetBot   string
	outDir      string
	botToken    string
	boundUserID int64
	waitTimeout time.Duration
	watchEvery  time.Duration
	watchForJob string
	jobsFilter  jobFilter
	adminIDs    []int64
	// telegramLoginClientID is the bot id that owns the dashboard login widget.
	telegramLoginClientID string
)

func loadConfig() error {
	// Backend/.env first, then the repo root, so both layouts work.
	for _, p := range []string{filepath.Join("Backend", ".env"), ".env"} {
		if err := loadDotEnv(p); err != nil {
			return fmt.Errorf("read %s: %w", p, err)
		}
	}

	raw := strings.TrimSpace(os.Getenv("TG_API_ID"))
	if raw == "" {
		return fmt.Errorf("TG_API_ID not set - copy Backend/.env.example to Backend/.env")
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return fmt.Errorf("TG_API_ID: %w", err)
	}
	apiID = v

	if apiHash = os.Getenv("TG_API_HASH"); apiHash == "" {
		return fmt.Errorf("TG_API_HASH not set")
	}
	targetBot = strings.TrimPrefix(strings.TrimSpace(os.Getenv("TG_TARGET")), "@")
	if targetBot == "" {
		targetBot = "tasklyBux_bot"
	}
	// Reuse the session the probe authenticated, so one account is never
	// signed in from two programs at once.
	sessionPath = envOr("TG_SESSION", filepath.Join("Test", "sessions", "probe.session"))
	outDir = envOr("OUT_DIR", filepath.Join("Backend", "out"))
	botToken = strings.TrimSpace(os.Getenv("BOT_TOKEN"))

	if r := strings.TrimSpace(os.Getenv("BOUND_USER_ID")); r != "" {
		if boundUserID, err = strconv.ParseInt(r, 10, 64); err != nil {
			return fmt.Errorf("BOUND_USER_ID: %w", err)
		}
	}
	waitTimeout = 30 * time.Second
	if secs, err := strconv.Atoi(envOr("WAIT_TIMEOUT", "30")); err == nil && secs > 0 {
		waitTimeout = time.Duration(secs) * time.Second
	}

	// Price polling sends three automated messages to the provider every time
	// it runs, so the interval is slow by default and has a hard floor. An
	// account that automates too eagerly is how accounts get banned.
	watchEvery = envDuration("WATCH_INTERVAL", 15*time.Minute, 5*time.Minute)
	watchForJob = envOr("WATCH_JOB", "2FA:Create FB")
	// Only these provider jobs are offered to end users. Everything else is
	// hidden, and a hidden job cannot be joined even by guessing its index.
	jobsFilter = jobFilterFromEnv(envOr("JOBS", "Create FB"))
	// Withdrawal destination. The provider pays USDT on BEP-20 (BSC) only, and
	// validates nothing on their side, so ours is checked before any use.
	// The fee and the minimum are NOT configured: they are read off the
	// provider's own message on every run, because the provider sets them and
	// can change them. See parseWithdrawTerms.
	withdrawWallet = strings.TrimSpace(os.Getenv("WITHDRAW_WALLET"))
	withdrawDryRun = envBool("WITHDRAW_DRY_RUN", true)

	// Dashboard auth. telegramLoginClientID is the BOT ID that owns the login
	// widget (@OpenTasksBot), which is public and identifies the app.
	// adminIDs is the allowlist of Telegram user ids permitted in, which is the
	// actual security boundary. Conflating them would let anyone register a
	// widget for their own bot and walk in.
	telegramLoginClientID = strings.TrimSpace(os.Getenv("TELEGRAM_LOGIN_CLIENT_ID"))

	// Price and availability alerts go to admins only. Never to an end user:
	// these messages expose the provider's cost, which is the bridge's margin.
	adminIDs = nil
	for _, part := range strings.Split(os.Getenv("ADMIN_USER_IDS"), ",") {
		idText := strings.TrimSpace(part)
		if idText == "" {
			continue
		}
		id, err := strconv.ParseInt(idText, 10, 64)
		if err != nil {
			return fmt.Errorf("ADMIN_USER_IDS has a bad id %q: %w", idText, err)
		}
		adminIDs = append(adminIDs, id)
	}
	if len(adminIDs) == 0 && boundUserID != 0 {
		adminIDs = []int64{boundUserID}
	}
	return os.MkdirAll(outDir, 0o700)
}

// Withdrawal settings. The wallet is configuration, not a constant, because it
// will change; fee and minimum are only for the dashboard estimate and are
// re-read from the provider's screen on every run, because the provider is free
// to change them. See docs/withdraw.md.
var (
	withdrawWallet string
	withdrawDryRun bool
)

// validateWallet checks a BEP-20 address shape. The provider accepts anything,
// so this must happen before forwarding: a truncated or wrong-network address
// is unrecoverable, and a BSC address sent to someone expecting Tron (TRC-20)
// loses their money with no reversal.
func validateWallet(addr string) error {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return fmt.Errorf("no withdrawal wallet configured (set WITHDRAW_WALLET)")
	}
	if !strings.HasPrefix(addr, "0x") && !strings.HasPrefix(addr, "0X") {
		if strings.HasPrefix(strings.ToUpper(addr), "T") {
			return fmt.Errorf("%s looks like a Tron (TRC-20) address; "+
				"this provider pays on BEP-20, which is BSC", addr)
		}
		return fmt.Errorf("withdrawal wallet must start with 0x, got %q", addr)
	}
	body := addr[2:]
	if len(body) != 40 {
		return fmt.Errorf("BEP-20 wallet must be 0x plus 40 hex characters, got %d", len(body))
	}
	for _, r := range body {
		if !strings.ContainsRune("0123456789abcdefABCDEF", r) {
			return fmt.Errorf("BEP-20 wallet contains a non-hex character %q", r)
		}
	}
	return nil
}

// envBool reads a flag. Dry run defaults to true for withdrawals because the
// provider flow has no confirmation step to catch a mistake later.
func envBool(key string, def bool) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return def
}

// getenv reads an environment variable, for code that runs before or
// outside the dotenv loader.
func getenv(key string) string { return strings.TrimSpace(os.Getenv(key)) }

// sessionSecret is the key the admin session cookie is signed with. It must
// not be blank in production, because a blank key would make every cookie
// forgeable.
func sessionSecret() string {
	if s := getenv("ADMIN_SESSION_SECRET"); s != "" {
		return s
	}
	return "insecure-development-secret-do-not-use-in-production"
}

func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func loadDotEnv(path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		v = strings.Trim(strings.TrimSpace(v), `"'`)
		if _, exists := os.LookupEnv(k); !exists {
			_ = os.Setenv(k, v)
		}
	}
	return nil
}

// ------------------------------------------------------------------ main ---

func main() {
	selftest := flag.Bool("selftest", false, "run offline checks and exit")
	list := flag.Bool("list", false, "read the provider job list and exit")
	migrate := flag.Bool("migrate", false, "apply the database schema and exit")
	status := flag.Bool("status", false, "print configuration and database state, then exit")
	asCLI := flag.Bool("cli", false, "run the operator CLI, passing the rest of the arguments to it")
	flag.Parse()

	switch {
	case *selftest:
		if err := selfTest(); err != nil {
			fmt.Println("SELFTEST FAILED:", err)
			os.Exit(1)
		}
		fmt.Println("SELFTEST OK")
	case *migrate:
		if err := loadConfig(); err != nil {
			fail(err)
		}
		if err := runMigrate(); err != nil {
			fail(err)
		}
	case *status:
		if err := runStatus(); err != nil {
			fail(err)
		}
	case *list:
		if err := runList(); err != nil {
			fail(err)
		}
	case *asCLI:
		if err := runCLI(flag.Args()); err != nil {
			fail(err)
		}
	default:
		if err := run(); err != nil {
			fail(err)
		}
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}

// withTarget starts the MTProto client, hands a live target to fn, and shuts
// down cleanly. Everything MTProto-related goes through here, because Telegram
// only delivers updates to the client that is actually running.
//
// The target is built before the client so the update handler can stamp
// arrivals; its api and peer are filled in once the client is running.
// withTarget starts the MTProto client, hands a live target to fn, and shuts
// down cleanly. Everything MTProto-related goes through here, because Telegram
// only delivers updates to the client that is actually running.
//
// The target is built before the client so the update handler can stamp
// arrivals; its api and peer are filled in once the client is running.
//
// admin is nil in -list mode, which simply means no dashboard and no HTTP
// server. hookSecret is empty when there is no webhook, in which case the
// caller polls instead.
func withTarget(ctx context.Context, a *audit, admin *adminServer, cat *catalog, st *store, hookSecret string, fn func(*target) error) error {
	arrivals := make(chan seqMsg, 64)
	var targetID int64

	tgt := &target{arrivals: arrivals, audit: a, timeout: waitTimeout}

	// The session comes from the critical store when there is one, and from
	// disk otherwise. Reading a file would work right up until the first
	// deploy, at which point the container has no session and the account
	// would have to be signed in again by hand.
	storage := sessionStorage(ctx, a)

	client := telegram.NewClient(apiID, apiHash, telegram.Options{
		SessionStorage: storage,
		Device:         telegram.DeviceTDesktopWindows(),
		UpdateHandler: telegram.UpdateHandlerFunc(func(_ context.Context, u tg.UpdatesClass) error {
			m := extractMessage(u)
			if m == nil || targetID == 0 {
				return nil
			}
			// Allowlist: this account sits in many channels, and anything
			// other than the provider would bury the log.
			if pu, ok := m.PeerID.(*tg.PeerUser); !ok || pu.UserID != targetID {
				return nil
			}
			tgt.bump()
			select {
			case arrivals <- seqMsg{seq: tgt.seq, msg: m}:
			default:
				a.log(legInternal, "inbox-full", 0, "a reply was dropped", nil)
			}
			return nil
		}),
	})

	return client.Run(ctx, func(ctx context.Context) error {
		status, err := client.Auth().Status(ctx)
		if err != nil {
			return fmt.Errorf("auth: %w", err)
		}
		if !status.Authorized {
			// A missing session is a state, not a fatal error.
			//
			// Returning an error here crash-looped the whole service, which took
			// the dashboard down at exactly the moment an operator needed it to
			// add a session. So: say so loudly, keep serving, and wait for one
			// to arrive at POST /api/session.
			a.log(legInternal, "no-session", 0,
				"no Telegram session stored. The bot is idle but the dashboard is up. "+
					"Add a session at POST /api/session, or run: cli session push",
				map[string]string{"service": "still serving", "bot": "idle"})
			// Hold the connection open with no account. The HTTP server runs
			// alongside this, so the dashboard stays reachable.
			select {
			case <-ctx.Done():
				return nil
			case <-reconnectSignal:
				a.log(legInternal, "retrying", 0, "a session arrived, reconnecting", nil)
				return errReconnect
			}
		}
		peer, id, err := resolve(ctx, client.API(), targetBot)
		if err != nil {
			return err
		}
		targetID = id

		self, err := client.Self(ctx)
		if err != nil {
			return err
		}
		a.log(legInternal, "connected", 0,
			fmt.Sprintf("MTProto account %s (+%s) is live", self.FirstName, self.Phone),
			map[string]string{"bot": targetBot})

		tgt.ctx, tgt.api, tgt.peer = ctx, client.API(), peer

		// The dashboard and the Bot API webhook both live inside this, so there
		// is one process: one MTProto connection, one session, one lock.
		// The -list mode passes a nil admin, which simply means no dashboard.
		if admin == nil {
			return fn(tgt)
		}
		// Remember the live connection so the sessions page can show which
		// stored session is actually in use rather than merely present.
		currentTarget = tgt
		admin.tgt = tgt
		admin.webhookSecret = hookSecret
		// The store is opened BEFORE the session manager is built, because the
		// manager is handed the handle. Built in the other order it received a
		// nil *sql.DB, and GET /api/sessions dereferenced it and panicked on
		// the first call - a 502 on a page that had never worked. The contract
		// tests did not catch it because they wire the manager with a real
		// handle: they verify the handler, not this ordering.
		if admin.db, err = openCriticalStore(); err != nil {
			a.log(legInternal, "admin-db", 0, "no critical store: "+err.Error(), nil)
		} else {
			defer admin.db.Close()
		}
		admin.sessions = newSessionManager(admin.db, a)
		go func() {
			if err := startAdmin(ctx, admin); err != nil {
				a.log(legInternal, "admin-stopped", 0, err.Error(), nil)
			}
		}()

		return fn(tgt)
	})
}

// updateSourceName is the banner line, so it is obvious at a glance whether
// updates arrive by webhook or by long polling. The two are mutually exclusive
// and being in the wrong one is a silent failure.
func updateSourceName(webhook bool) string {
	if webhook {
		return "webhook (POST /webhook)"
	}
	return "long polling"
}

// sessionStorage picks where the Telegram session lives.
//
// The critical store is the answer whenever it is configured, because a
// container filesystem is wiped on every deploy and this service has no volume.
// The file path remains the fallback so a purely local run needs no database.
//
// The session blob is a live credential, so it is never logged. Only the fact
// of its presence and size is ever reported.
func sessionStorage(ctx context.Context, a *audit) telegram.SessionStorage {
	db, err := openCriticalStore()
	if err != nil {
		a.log(legInternal, "session-store", 0,
			"no critical store, falling back to the session file: "+err.Error(), nil)
		return &session.FileStorage{Path: sessionPath}
	}
	// A cold Neon must not crash-loop the service, so give it a few seconds.
	if err := waitForDB(ctx, db, 5); err != nil {
		a.log(legInternal, "session-store", 0, err.Error(), map[string]string{
			"fallback": "session file",
		})
		db.Close()
		return &session.FileStorage{Path: sessionPath}
	}
	store := &neonSessionStore{db: db, accountID: sessionAccountID()}
	if has, size, err := HasSession(ctx, db, sessionAccountID()); err == nil {
		if has {
			a.log(legInternal, "session-store", 0,
				"session loaded from the critical store", map[string]string{
					"account": sessionAccountID(), "bytes": strconv.Itoa(size),
				})
		} else {
			a.log(legInternal, "session-store", 0,
				"no session stored yet; the account must be signed in once", nil)
		}
	}
	return store
}

func runList() error {
	if err := loadConfig(); err != nil {
		return err
	}
	a := newAudit(outDir)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	return withTarget(ctx, a, nil, nil, nil, "", func(t *target) error {
		tasks, err := t.fetchTasks("cookie")
		if err != nil {
			return err
		}
		fmt.Printf("\n%d job(s) live on @%s:\n\n", len(tasks), targetBot)
		for i, task := range tasks {
			fmt.Printf("  %d. %-34s $%.4f\n", i+1, task.Name, task.Price)
		}
		return nil
	})
}

func run() error {
	if err := loadConfig(); err != nil {
		return err
	}
	if botToken == "" {
		return fmt.Errorf("BOT_TOKEN not set - create a bot with @BotFather and put the token in Backend/.env")
	}
	if boundUserID == 0 {
		return fmt.Errorf("BOUND_USER_ID not set - the Telegram user id this account serves")
	}

	// Refuse to run beside another copy. Two bridges sharing one MTProto session
	// and one provider chat break each other in ways that look like provider
	// faults, so this is checked before anything connects. The lock lives in the
	// OS temp directory, not the data directory: see lockDir for why a lock on
	// a volume made every deploy impossible.
	release, err := acquireLock(lockDir())
	if err != nil {
		return err
	}
	defer release()

	a := newAudit(outDir)
	st, err := newStore(outDir)
	if err != nil {
		return err
	}
	cat, err := loadCatalog(defaultCatalogPath())
	if err != nil {
		return err
	}

	bot := newBot(botToken, a)
	me, err := bot.me()
	if err != nil {
		return fmt.Errorf("bot token rejected: %w", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Register the webhook before the duplicate-instance check, because that
	// check probes getUpdates and Telegram refuses getUpdates outright once a
	// webhook is set. Order is load-bearing here.
	//
	// Registering on every boot is deliberate: Railway injects
	// RAILWAY_PUBLIC_DOMAIN and the domain changes when the service is
	// recreated, so a webhook set once at setup would quietly stop delivering.
	// The bot would look healthy and simply never hear anything again.
	hookSecret, hookErr := registerWebhook(bot, a)
	if hookErr != nil {
		// Not fatal: long polling is better than a service that will not start,
		// and the log line says which of the two happened.
		a.log(legInternal, "webhook-fallback", 0,
			"continuing on long polling: "+hookErr.Error(), nil)
	}
	if hookSecret == "" {
		// Polling only. In webhook mode getUpdates is permanently refused
		// with a 409 that is not a duplicate, so the probe there would both
		// do nothing and hide the check that actually matters: two processes
		// polling one bot is what rule 1 is about, and it can only happen
		// here.
		if err := bot.checkBotReachable(); err != nil {
			return err
		}
	}

	admin := &adminServer{
		bot: bot, audit: a, store: st, cat: cat,
		secret:  []byte(sessionSecret()),
		clients: map[chan []byte]struct{}{},
		// Admin-only announcements: a catalogue change made in the dashboard is
		// told to the same people who can make it. botNotifier sends to
		// ADMIN_USER_IDS and refuses when that list is empty, so it cannot
		// reach an end user.
		note: &botNotifier{bot: bot, admins: adminIDs, a: a},
	}

	fmt.Printf("our bot    : @%s\n", me)
	fmt.Printf("provider   : @%s\n", targetBot)
	fmt.Printf("bound user : %d\n", boundUserID)
	fmt.Printf("state file : %s\n", filepath.Join(outDir, "state.json"))
	fmt.Printf("updates    : %s\n", updateSourceName(hookSecret != ""))

	// One MTProto client for the life of the process, shared by the update
	// source and every provider action. A second client on the same session
	// would fight over the auth key, so withTarget is entered exactly once and
	// the update loop lives inside it.
	//
	// A reconnect is not fatal. When no session is stored the process stays up
	// serving the dashboard, and a session uploaded over HTTP asks for a
	// reconnect rather than needing a redeploy.
	for ctx.Err() == nil {
		err := withTarget(ctx, a, admin, cat, st, hookSecret, func(t *target) error {
			note := &botNotifier{bot: bot, admins: adminIDs, a: a}
			w := newWatcher(outDir, a, note, watchEvery, watchForJob, catalogSubject(cat))
			fmt.Printf("watching   : %q every %s (min 5m)\n", watchForJob, watchEvery)
			go w.run(ctx, t, cat)

			// One handler for both update sources, built once the provider is
			// connected. The webhook needs it to exist before the HTTP server
			// begins accepting deliveries.
			h := &handler{bot: bot, audit: a, store: st, tgt: t,
				boundUser: boundUserID, cat: cat, alerts: note}
			admin.dispatch = h.handle

			if hookSecret != "" {
				// Webhook mode. Telegram refuses getUpdates while a webhook
				// is set, so the poller must not also run: it would error
				// every 25 seconds and bury the log in noise.
				fmt.Println("running. /start in Telegram to see the job list.")
				// The webhook owns the updates now, so there is nothing to
				// loop on. Wait for shutdown; the HTTP server is already up.
				<-ctx.Done()
				return nil
			}

			var offset int64
			for ctx.Err() == nil {
				updates, err := bot.getUpdates(offset, 25)
				if err != nil {
					// Another instance holds the getUpdates lock. Retrying
					// fast would just fill the log, so say it once and back
					// right off.
					if isDuplicateInstance(err) {
						a.log(legInternal, "duplicate-instance", 0,
							"another instance is polling this bot; backing off 60s", nil)
						select {
						case <-ctx.Done():
							return nil
						case <-time.After(60 * time.Second):
						}
						continue
					}
					a.log(legInternal, "poll-error", 0, err.Error(), nil)
					select {
					case <-ctx.Done():
						return nil
					case <-time.After(3 * time.Second):
					}
					continue
				}
				for _, u := range updates {
					offset = u.UpdateID + 1
					h.handle(u)
				}
			}
			return nil
		})

		if err == nil || ctx.Err() != nil {
			return err
		}
		if !errors.Is(err, errReconnect) {
			a.log(legInternal, "provider-down", 0, err.Error(), map[string]string{
				"action": "retrying in 10s",
			})
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(10 * time.Second):
		}
	}
	return nil
}

// -------------------------------------------------------------- self test ---

func selfTest() error {
	if err := selfTestCatalog(); err != nil {
		return fmt.Errorf("catalogue: %w", err)
	}
	if err := selfTestWallet(); err != nil {
		return fmt.Errorf("wallet: %w", err)
	}
	if err := selfTestWithdrawTerms(); err != nil {
		return fmt.Errorf("withdraw terms: %w", err)
	}

	got, ok := parseTask("🌟2FA:Create FB (No mail) ($0.0500)")
	if !ok {
		return fmt.Errorf("a priced label must parse as a task")
	}
	if got.Name != "2FA:Create FB (No mail)" {
		return fmt.Errorf("name = %q", got.Name)
	}
	if got.Price != 0.05 {
		return fmt.Errorf("price = %v", got.Price)
	}
	// No price, so not a job. Otherwise the menu would offer Cancel as one.
	for _, label := range []string{"❌ Cancel", "💰 Balance", ""} {
		if _, bad := parseTask(label); bad {
			return fmt.Errorf("%q must not parse as a task", label)
		}
	}
	// Two decimal places must survive, and this label has two spaces before
	// the price, which is exactly how the bot sends it.
	top, ok := parseTask("📱 Create Inst (2FA)  ($0.0180)")
	if !ok || top.Price != 0.018 {
		return fmt.Errorf("top-level task must parse: %+v", top)
	}

	// The join must survive a restart, which is the whole reason state.json
	// exists: a redeploy must not drop a user out of their job.
	dir, err := os.MkdirTemp("", "store")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)

	s1, err := newStore(dir)
	if err != nil {
		return err
	}
	if err := s1.set(1772093705, Join{TaskName: "2FA:Create FB (No mail)", Price: 0.05}); err != nil {
		return fmt.Errorf("set: %w", err)
	}
	s2, err := newStore(dir)
	if err != nil {
		return err
	}
	j, ok := s2.get(1772093705)
	if !ok {
		return fmt.Errorf("a join must survive a restart")
	}
	if j.TaskName != "2FA:Create FB (No mail)" || j.Price != 0.05 {
		return fmt.Errorf("restored join is wrong: %+v", j)
	}
	if err := s2.clear(1772093705); err != nil {
		return err
	}
	if _, still := s2.get(1772093705); still {
		return fmt.Errorf("clear must remove the join")
	}
	if _, ghost := s2.get(999); ghost {
		return fmt.Errorf("a user with no join must not read one")
	}

	// The job filter is a security boundary, not a display preference: a hidden
	// job must not be startable by guessing a callback index.
	live := []Task{
		{Name: "Create Twitter", Price: 0.026},
		{Name: "Create Twitter (No follow)", Price: 0.027},
		{Name: "Create FB (2FA)", Price: 0.048},
		{Name: "2FA:Create FB (No mail)", Price: 0.05},
	}
	fbOnly := jobFilter{wants: []string{"Create FB"}}
	kept, hidden := fbOnly.apply(live)
	if len(kept) != 2 {
		return fmt.Errorf("expected the 2 Create FB variants, got %d: %+v", len(kept), kept)
	}
	for _, k := range kept {
		if strings.Contains(k.Name, "Twitter") {
			return fmt.Errorf("a Twitter job leaked through the filter: %+v", k)
		}
	}
	if len(hidden) != 2 {
		return fmt.Errorf("expected 2 hidden jobs, got %d", len(hidden))
	}
	// An empty configuration offers everything, so an unconfigured service
	// does not silently sell nothing.
	all, _ := (jobFilter{}).apply(live)
	if len(all) != len(live) {
		return fmt.Errorf("an empty filter must offer everything, got %d", len(all))
	}
	// A job that matches nothing yields an empty offer, which the caller
	// reports as "no jobs available" rather than an empty menu.
	none, _ := (jobFilter{wants: []string{"No Such Job"}}).apply(live)
	if len(none) != 0 {
		return fmt.Errorf("a non-matching filter must offer nothing, got %d", len(none))
	}
	// Parsing must tolerate spacing and ignore empties.
	parsed := jobFilterFromEnv(" Create FB , , Create FB (2FA) ")
	if len(parsed.wants) != 2 {
		return fmt.Errorf("JOBS parsing = %+v", parsed.wants)
	}

	// Price watching has three distinct outcomes, and conflating them would
	// either spam alerts or hide a real supply change.
	prev := map[string]float64{
		"2FA:Create FB (No mail)": 0.05,
		"Create FB (2FA)":         0.048,
		"Create Twitter":          0.026,
	}
	now := map[string]float64{
		"Create FB (2FA)": 0.051, // price moved
		"Create Twitter":  0.026, // unchanged
		"Brand New Job":   0.01,  // appeared
		// 2FA:Create FB (No mail) is gone
	}
	changes := compare(prev, now)
	byJob := map[string]change{}
	for _, c := range changes {
		byJob[c.Job] = c
	}
	if c, ok := byJob["2FA:Create FB (No mail)"]; !ok || c.Kind != "gone" {
		return fmt.Errorf("a missing job must report as gone, got %+v", changes)
	}
	if c, ok := byJob["Create FB (2FA)"]; !ok || c.Kind != "price" || c.Percent != "+6.25%" {
		return fmt.Errorf("a moved price must report the percentage, got %+v", c)
	}
	if c, ok := byJob["Brand New Job"]; !ok || c.Kind != "appeared" {
		return fmt.Errorf("a new job must report as appeared, got %+v", changes)
	}
	if _, bad := byJob["Create Twitter"]; bad {
		return fmt.Errorf("an unchanged price must not be reported: %+v", changes)
	}

	// The very first snapshot must not announce every job as newly appeared.
	if got := compare(nil, now); len(got) != 0 {
		return fmt.Errorf("first snapshot must be silent, got %+v", got)
	}
	// A zero base must not divide by zero.
	if percent(0, 0.05) != "n/a" {
		return fmt.Errorf("percent of a zero base must be n/a")
	}
	// The alert text has to name the job, or it is useless in a chat window.
	if msg := describe(change{Job: "X", Before: 0.05, After: 0.051, Kind: "price", Percent: "+2.00%"}); !strings.Contains(msg, "X") {
		return fmt.Errorf("alert text must name the job: %q", msg)
	}

	// A corrupt state file must fail loudly rather than silently dropping
	// every user's job.
	if err := os.WriteFile(filepath.Join(dir, "state.json"), []byte("{broken"), 0o600); err != nil {
		return err
	}
	if _, err := newStore(dir); err == nil {
		return fmt.Errorf("a corrupt state file must be reported, not ignored")
	}
	return nil
}
