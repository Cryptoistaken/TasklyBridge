package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Two copies of the bridge must never run at once, and this is not a
// theoretical concern: it happened. Two processes sharing one MTProto session
// and one provider chat stepped on each other, one consumed the other's
// replies, the provider read the stray message as a cancel, and the visible
// symptom was an unhelpful "could not read the job list".
//
// Two separate failures share that cause, so both are closed here:
//   - a lock file, so a second copy refuses to start at all
//   - a backoff on Telegram's "Conflict: terminated by other getUpdates
//     request", so even if the lock is bypassed the loser backs off loudly
//     instead of hammering the API every three seconds for twenty minutes

const lockName = "bridge.lock"

// acquireLock takes an exclusive lock for the life of the process. The returned
// release function removes it, so a clean shutdown leaves nothing behind.
func acquireLock(dir string) (release func(), err error) {
	path := filepath.Join(dir, lockName)

	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		if !os.IsExist(err) {
			return nil, fmt.Errorf("lock file %s: %w", path, err)
		}
		who := readLockPID(path)
		return nil, fmt.Errorf(
			"another bridge is already running (pid %s, lock %s).\n"+
				"Two copies break the provider: they share one session and one chat.\n"+
				"Stop that process first. If you are sure nothing is running, delete %s.",
			who, path, path)
	}
	fmt.Fprintf(f, "%d\n", os.Getpid())
	f.Close()

	return func() { _ = os.Remove(path) }, nil
}

func readLockPID(path string) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "unknown"
	}
	pid := strings.TrimSpace(string(raw))
	if _, err := strconv.Atoi(pid); err != nil {
		return "unknown"
	}
	return pid
}

// isDuplicateInstance reports whether an error is Telegram telling us another
// getUpdates is in flight. It is a fatal condition, not a transient one, so it
// is logged once and then backed off hard rather than retried every few seconds.
func isDuplicateInstance(err error) bool {
	return err != nil && strings.Contains(err.Error(), "terminated by other getUpdates request")
}
