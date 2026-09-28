package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"
)

// runStatus prints what the process is configured with and whether the pieces
// it depends on are actually reachable. It is the first thing to run when a
// deploy looks wrong, because it answers "is it configured" and "can it reach
// anything" without starting the bridge and risking the account.
func runStatus() error {
	if err := loadConfig(); err != nil {
		return err
	}

	fmt.Println("TasklyBridge status")
	fmt.Println()
	fmt.Println("Provider")
	fmt.Printf("  target          : @%s\n", targetBot)
	fmt.Printf("  session file    : %s\n", sessionPath)
	if _, err := sessionFileExists(sessionPath); err == nil {
		fmt.Println("  session present : yes")
	} else {
		fmt.Println("  session present : NO - run: go run ./Test -login")
	}
	fmt.Println()

	fmt.Println("Our bot")
	if botToken == "" {
		fmt.Println("  token           : NOT SET")
	} else {
		// Never print the token, not even masked: it is a full credential and
		// a partial one still narrows nothing useful for the reader.
		fmt.Println("  token           : set")
	}
	fmt.Printf("  bound user      : %d\n", boundUserID)
	fmt.Printf("  login client id : %s\n", orDash(telegramLoginClientID))
	fmt.Printf("  admins          : %s\n", joinInts(adminIDs))
	fmt.Println()

	fmt.Println("Withdraw")
	fmt.Printf("  wallet          : %s\n", orDash(withdrawWallet))
	if withdrawWallet != "" {
		if err := validateWallet(withdrawWallet); err != nil {
			fmt.Printf("  wallet valid    : NO - %v\n", err)
		} else {
			fmt.Println("  wallet valid    : yes")
		}
	}
	fmt.Printf("  dry run         : %v\n", withdrawDryRun)
	fmt.Println()

	fmt.Println("Catalogue")
	if cat, err := loadCatalog(defaultCatalogPath()); err != nil {
		fmt.Printf("  task.json       : PROBLEM - %v\n", err)
	} else {
		fmt.Printf("  task.json       : %s (%d job(s), %s)\n",
			cat.path, len(cat.jobs), catalogSubject(cat))
		for _, j := range cat.jobs {
			fmt.Printf("    - %-22s %s  require_all=%v enabled=%v\n",
				j.Name, priceLabel(j.SellBDT), j.RequireAll, j.Enabled)
		}
	}
	fmt.Println()

	fmt.Println("Watcher")
	fmt.Printf("  interval        : %s (floor 5m)\n", watchEvery)
	fmt.Printf("  watching job    : %s\n", orDash(watchForJob))
	fmt.Println()

	fmt.Println("Database")
	dsn := strings.TrimSpace(getenv("DATABASE_URL"))
	if dsn == "" {
		fmt.Println("  DATABASE_URL    : NOT SET - state will stay in local files")
		return nil
	}
	fmt.Printf("  url             : %s\n", redactDSN(dsn))
	db, err := openDB(dsn)
	if err != nil {
		fmt.Printf("  reachable       : NO - %v\n", err)
		return nil
	}
	defer db.Close()
	fmt.Println("  reachable       : yes")

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	tables, err := verifySchema(ctx, db)
	if err != nil {
		fmt.Printf("  schema          : PROBLEM - %v\n", err)
		return nil
	}
	if len(tables) == 0 {
		fmt.Println("  schema          : EMPTY - run: go run ./Backend -migrate")
		return nil
	}
	fmt.Printf("  schema          : %d table(s) - %s\n", len(tables), strings.Join(tables, ", "))
	return nil
}

func orDash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "(not set)"
	}
	return s
}

func joinInts(v []int64) string {
	if len(v) == 0 {
		return "(none - nobody can log in)"
	}
	parts := make([]string, 0, len(v))
	for _, n := range v {
		parts = append(parts, fmt.Sprint(n))
	}
	return strings.Join(parts, ", ")
}

// sessionFileExists reports whether the MTProto session is on disk. Losing it
// means logging the account in again by hand, so it is worth checking.
func sessionFileExists(path string) (int64, error) {
	st, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	return st.Size(), nil
}
