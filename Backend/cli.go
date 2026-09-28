package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The operator CLI. One place to drive the bridge, the database and Railway
// without remembering which command does what.
//
// Everything here reads or acts through the same code paths the service uses,
// so a CLI action cannot drift from what the app actually does. Destructive
// operations ask first, because this is the tool that can move money.

func cliUsage() string {
	return strings.TrimSpace(`
TasklyBridge CLI

  status                    show configuration, stores and the session file
  jobs                      read the provider's live job list
  check                     run every offline check

  db migrate                apply the schema to both stores
  db tables                 list the tables in both stores
  db psql                   open a SQL shell on the critical store
  db users                  list end users
  db accounts               list accounts
  db alerts                 list recent alerts
  db messages [n]           show the newest n logged messages
  db withdrawals            list withdrawal history
  db sessions               show which accounts have a stored session
  session status            show whether a session is stored (never its contents)
  session push [file]       copy a local session file into the critical store
  db sql "<query>"          run one read-only query on the critical store
  db export <file>          dump accounts, users and sessions to JSON

  task show                 show the catalogue
  task enable <name>        enable a job
  task disable <name>       hide a job without deleting it
  task price <name> <bdt>   set the static sell price

  deploy                    build and deploy the current commit
  deploy logs [n]           show recent service logs
  deploy status             show the current deployment state
  redeploy                  redeploy the last successful build
  vars                      list the service variable names (values hidden)
  vars set K=V              set a service variable

Examples
  cli db tables
  cli task price "Facebook 2fa" 6
  cli deploy logs 40
`)
}

func runCLI(args []string) error {
	if len(args) == 0 {
		fmt.Println(cliUsage())
		return nil
	}

	switch args[0] {
	case "help", "-h", "--help":
		fmt.Println(cliUsage())
		return nil
	case "status":
		return runStatus()
	case "jobs", "list":
		return runList()
	case "check":
		if err := selfTest(); err != nil {
			return err
		}
		fmt.Println("SELFTEST OK")
		return nil
	}

	if err := loadConfig(); err != nil {
		return err
	}

	switch args[0] {
	case "db":
		return cliDB(args[1:])
	case "session":
		return cliSession(args[1:])
	case "task":
		return cliTask(args[1:])
	case "deploy":
		return cliDeploy(args[1:])
	case "vars":
		return cliVars(args[1:])
	default:
		fmt.Println(cliUsage())
		return fmt.Errorf("unknown command %q", args[0])
	}
}

// ----------------------------------------------------------------- the CLI --

// cliSession moves the Telegram session between the file and the critical
// store.
//
// This exists because the service has no volume, so the only way it can hold a
// session is if the session lives in the database. The file is the one the
// operator authenticated with; this copies it across without a second login.
func cliSession(args []string) error {
	db, err := cliStore("DATABASE_URL", "critical store")
	if err != nil {
		return err
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	switch {
	case len(args) == 0 || args[0] == "status":
		has, size, err := HasSession(ctx, db, sessionAccountID())
		if err != nil {
			return err
		}
		// Presence and size only. The blob is a live credential and is never
		// printed, not even truncated.
		if !has {
			fmt.Println("no session stored. run: cli session push")
			return nil
		}
		fmt.Printf("session stored for %q (%d bytes)\n", sessionAccountID(), size)
		return nil

	case args[0] == "push":
		path := sessionPath
		if len(args) > 1 {
			path = args[1]
		}
		if err := storeSessionBlob(ctx, db, sessionAccountID(), path); err != nil {
			return err
		}
		fmt.Printf("copied %s into the critical store for %q\n", path, sessionAccountID())
		return nil
	}
	return fmt.Errorf("unknown session command %q", args[0])
}

func cliDB(args []string) error {
	critical, err := cliStore("DATABASE_URL", "critical store")
	if err != nil {
		return err
	}
	defer critical.Close()

	switch {
	case len(args) == 0 || args[0] == "tables":
		logs, lerr := cliOptionalStore("LOGS_DATABASE_URL")
		if lerr == nil && logs != nil {
			defer logs.Close()
			printTables("critical", critical)
			printTables("logs", logs)
			return nil
		}
		printTables("critical", critical)
		return nil

	case args[0] == "migrate":
		return runMigrate()

	case args[0] == "psql":
		// A real shell, because "just let me look" is the most common need and
		// a hand-rolled REPL would be worse than psql.
		psql, err := exec.LookPath("psql")
		if err != nil {
			return fmt.Errorf("psql is not installed; install the Postgres client, " +
				"or use: cli db sql \"<query>\"")
		}
		dsn := getenv("DATABASE_URL")
		cmd := exec.Command(psql, dsn)
		cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
		return cmd.Run()

	case args[0] == "sql":
		if len(args) < 2 {
			return fmt.Errorf("usage: cli db sql \"<query>\"")
		}
		return cliQuery(critical, args[1])

	case args[0] == "users":
		return cliQuery(critical, "SELECT id, name, status, account_id, task_name, messages, "+
			"to_char(last_seen,'YYYY-MM-DD HH24:MI') AS last_seen FROM users ORDER BY id")

	case args[0] == "accounts":
		return cliQuery(critical, "SELECT id, phone, state, balance, messages_sent, "+
			"to_char(last_seen,'YYYY-MM-DD HH24:MI') AS last_seen FROM accounts ORDER BY id")

	case args[0] == "alerts":
		limit := 20
		if len(args) > 1 {
			if n, err := strconv.Atoi(args[1]); err == nil {
				limit = n
			}
		}
		return cliQuery(critical, fmt.Sprintf(
			"SELECT to_char(at,'MM-DD HH24:MI') AS at, level, kind, job, message "+
				"FROM alerts ORDER BY at DESC LIMIT %d", limit))

	case args[0] == "withdrawals":
		return cliQuery(critical, "SELECT to_char(at,'MM-DD HH24:MI') AS at, account_id, "+
			"amount, fee, net, status, left(wallet,10)||'...' AS wallet "+
			"FROM withdrawals ORDER BY at DESC LIMIT 30")

	case args[0] == "sessions":
		return cliQuery(critical, "SELECT s.account_id, a.phone, "+
			"pg_size_pretty(length(s.blob)) AS size, "+
			"to_char(s.updated_at,'YYYY-MM-DD HH24:MI') AS updated "+
			"FROM sessions s JOIN accounts a ON a.id = s.account_id ORDER BY s.account_id")

	case args[0] == "messages":
		// The log store if it is configured, because that is where the
		// high-volume writes go.
		db := critical
		if logs, err := cliOptionalStore("LOGS_DATABASE_URL"); err == nil && logs != nil {
			defer logs.Close()
			db = logs
		}
		limit := 20
		if len(args) > 1 {
			if n, err := strconv.Atoi(args[1]); err == nil {
				limit = n
			}
		}
		return cliQuery(db, fmt.Sprintf(
			"SELECT to_char(at,'MM-DD HH24:MI:SS') AS at, leg, left(text,90) AS text "+
				"FROM messages ORDER BY at DESC LIMIT %d", limit))

	case args[0] == "export":
		if len(args) < 2 {
			return fmt.Errorf("usage: cli db export <file.json>")
		}
		return cliExport(critical, args[1])
	}
	return fmt.Errorf("unknown db command %q", args[0])
}

func cliStore(key, label string) (*sql.DB, error) {
	dsn := strings.TrimSpace(getenv(key))
	if dsn == "" {
		return nil, fmt.Errorf("%s is not set, so there is no %s to talk to", key, label)
	}
	return openDB(dsn)
}

func cliOptionalStore(key string) (*sql.DB, error) {
	if strings.TrimSpace(getenv(key)) == "" {
		return nil, nil
	}
	return openDB(getenv(key))
}

func printTables(label string, db *sql.DB) {
	tables, err := verifySchema(context.Background(), db)
	if err != nil {
		fmt.Printf("%s: %v\n", label, err)
		return
	}
	fmt.Printf("%s (%d): %s\n", label, len(tables), strings.Join(tables, ", "))
}

// cliQuery runs one query and prints it as an aligned table.
//
// It refuses anything that is not a SELECT or WITH. A CLI that can run DELETE
// against the store holding session blobs is a foot-gun, and this one is
// operated by hand.
func cliQuery(db *sql.DB, query string) error {
	q := strings.TrimSpace(query)
	upper := strings.ToUpper(q)
	if !strings.HasPrefix(upper, "SELECT") && !strings.HasPrefix(upper, "WITH") {
		return fmt.Errorf("only SELECT and WITH are allowed here; the stores hold " +
			"session keys, so writes go through the service")
	}
	if contains(upper, "INSERT") || contains(upper, "UPDATE") ||
		contains(upper, "DELETE") || contains(upper, "DROP") || contains(upper, "TRUNCATE") {
		return fmt.Errorf("refusing a statement that writes")
	}

	rows, err := db.Query(q)
	if err != nil {
		return fmt.Errorf("query failed: %w", err)
	}
	defer rows.Close()

	cols, err := rows.Columns()
	if err != nil {
		return err
	}
	rowsOut := make([][]string, 0, 32)
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return err
		}
		row := make([]string, len(cols))
		for i, v := range vals {
			row[i] = fmt.Sprint(v)
			if row[i] == "<nil>" {
				row[i] = "-"
			}
			// A newline in a cell would wreck the column alignment.
			row[i] = strings.ReplaceAll(row[i], "\n", " ")
		}
		rowsOut = append(rowsOut, row)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(rowsOut) == 0 {
		fmt.Println("(no rows)")
		return nil
	}
	printTable(cols, rowsOut)
	return nil
}

func printTable(cols []string, rows [][]string) {
	widths := make([]int, len(cols))
	for i, c := range cols {
		widths[i] = len(c)
	}
	for _, r := range rows {
		for i, cell := range r {
			if i < len(widths) && len(cell) > widths[i] {
				widths[i] = len(cell)
			}
		}
	}
	var head strings.Builder
	for i, c := range cols {
		if i > 0 {
			head.WriteString("  ")
		}
		head.WriteString(fmt.Sprintf("%-*s", widths[i], c))
	}
	fmt.Println(head.String())

	var rule strings.Builder
	for i := range cols {
		if i > 0 {
			rule.WriteString("  ")
		}
		rule.WriteString(strings.Repeat("-", widths[i]))
	}
	fmt.Println(rule.String())

	var sb strings.Builder
	for _, r := range rows {
		for i := range cols {
			if i > 0 {
				sb.WriteString("  ")
			}
			cell := ""
			if i < len(r) {
				cell = r[i]
			}
			sb.WriteString(fmt.Sprintf("%-*s", widths[i], cell))
		}
		fmt.Println(sb.String())
	}
}

func contains(haystack, needle string) bool { return strings.Contains(haystack, needle) }

// cliExport dumps the critical rows to a file, so state can be backed up or
// moved without opening a SQL client.
func cliExport(db *sql.DB, path string) error {
	out := map[string]any{}
	for name, q := range map[string]string{
		"accounts":    "SELECT id, phone, state, balance, messages_sent, last_seen, note FROM accounts",
		"users":       "SELECT id, name, username, status, account_id, task_name, messages, joined_at, last_seen FROM users",
		"sessions":    "SELECT account_id, encode(blob,'base64') AS blob FROM sessions",
		"withdrawals": "SELECT id, account_id, wallet, amount, fee, net, dry_run, status, at FROM withdrawals",
	} {
		rows, err := db.Query(q)
		if err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		cols, _ := rows.Columns()
		list := make([]map[string]any, 0, 16)
		for rows.Next() {
			vals := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				rows.Close()
				return err
			}
			rec := map[string]any{}
			for i, c := range cols {
				rec[c] = vals[i]
			}
			list = append(list, rec)
		}
		rows.Close()
		out[name] = list
	}

	raw, err := jsonMarshalIndent(out)
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		return err
	}
	st, _ := os.Stat(path)
	fmt.Printf("exported to %s (%d bytes)\n", path, st.Size())
	return nil
}

// ---------------------------------------------------------------- tasks ----

func cliTask(args []string) error {
	cat, err := loadCatalog(defaultCatalogPath())
	if err != nil {
		return err
	}
	switch {
	case len(args) == 0 || args[0] == "show":
		fmt.Printf("%s  (%d job(s), subject %s)\n\n", cat.path, len(cat.jobs), catalogSubject(cat))
		for i, j := range cat.jobs {
			fmt.Printf("  %d. %-26s %-8s require_all=%v enabled=%v\n",
				i+1, j.Name, priceLabel(j.SellBDT), j.RequireAll, j.Enabled)
		}
		return nil

	case args[0] == "enable" || args[0] == "disable":
		if len(args) < 2 {
			return fmt.Errorf("usage: cli task %s <name>", args[0])
		}
		return cat.setEnabled(args[1], args[0] == "enable")

	case args[0] == "price":
		if len(args) < 3 {
			return fmt.Errorf("usage: cli task price <name> <bdt>")
		}
		v, err := strconv.ParseFloat(args[2], 64)
		if err != nil || v <= 0 {
			return fmt.Errorf("%q is not a positive number", args[2])
		}
		return cat.setPrice(args[1], v)
	}
	return fmt.Errorf("unknown task command %q", args[0])
}

// ------------------------------------------------------- railway plumbing --

func railway(args ...string) (string, error) {
	exe, err := exec.LookPath("railway")
	if err != nil {
		return "", fmt.Errorf("the railway CLI is not on PATH; see docs/railway.md")
	}
	cmd := exec.Command(exe, args...)
	cmd.Dir = projectRoot()
	out, err := cmd.CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("railway %s: %w", strings.Join(args, " "), err)
	}
	return string(out), nil
}

func cliDeploy(args []string) error {
	switch {
	case len(args) == 0 || args[0] == "up":
		out, err := railway("up", "--detach")
		fmt.Print(out)
		return err
	case args[0] == "logs":
		lines := 40
		if len(args) > 1 {
			if n, err := strconv.Atoi(args[1]); err == nil {
				lines = n
			}
		}
		out, err := railway("logs", "--lines", strconv.Itoa(lines))
		fmt.Print(out)
		return err
	case args[0] == "status":
		out, err := railway("status")
		fmt.Print(out)
		return err
	case args[0] == "redeploy":
		out, err := railway("up", "--detach")
		fmt.Print(out)
		return err
	}
	return fmt.Errorf("unknown deploy command %q", args[0])
}

func cliVars(args []string) error {
	switch {
	case len(args) == 0 || args[0] == "list":
		// Names only. Values are credentials and some are financial.
		out, err := railway("variable", "list", "--json")
		if err != nil {
			return err
		}
		var vars map[string]any
		if err := jsonUnmarshal([]byte(out), &vars); err != nil {
			// Fall back to printing the raw output rather than failing: the
			// point is to see the names.
			fmt.Println(out)
			return nil
		}
		names := make([]string, 0, len(vars))
		for k := range vars {
			names = append(names, k)
		}
		sort.Strings(names)
		for _, n := range names {
			fmt.Printf("  %-28s %s\n", n, "<set>")
		}
		return nil

	case args[0] == "set":
		if len(args) < 2 || !strings.Contains(args[1], "=") {
			return fmt.Errorf("usage: cli vars set KEY=value")
		}
		kv := strings.SplitN(args[1], "=", 2)
		out, err := railway("variable", "set", kv[0]+"="+kv[1], "--skip-deploys")
		fmt.Print(out)
		return err
	}
	return fmt.Errorf("unknown vars command %q", args[0])
}

// projectRoot is where the repository root is, for commands that must run from
// it regardless of the current directory.
func projectRoot() string {
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	for dir := wd; dir != "" && dir != string(os.PathSeparator); {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return wd
}
