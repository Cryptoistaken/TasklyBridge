package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// A user's joined job has to survive a restart, otherwise a redeploy would
// silently drop everyone out of the task they are midway through. A JSON file
// is enough for one account and one bound user; Neon takes over when the pool
// grows, behind the same three functions.

// Join is what a user is currently inside.
type Join struct {
	TaskName  string    `json:"task_name"`
	TaskLabel string    `json:"task_label"`
	Price     float64   `json:"price"`
	JoinedAt  time.Time `json:"joined_at"`
}

type store struct {
	mu   sync.Mutex
	path string
	data map[int64]Join
}

func newStore(dir string) (*store, error) {
	s := &store{
		path: filepath.Join(dir, "state.json"),
		data: map[int64]Join{},
	}
	raw, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return nil, err
	}
	if len(raw) == 0 {
		return s, nil
	}
	// Telegram user ids are int64, which JSON object keys cannot hold, so the
	// map is keyed by string and converted here.
	var raw2 map[string]Join
	if err := json.Unmarshal(raw, &raw2); err != nil {
		return nil, fmt.Errorf("state file is corrupt: %w", err)
	}
	for k, v := range raw2 {
		var id int64
		if _, err := fmt.Sscanf(k, "%d", &id); err != nil {
			return nil, fmt.Errorf("state file has a bad user id %q: %w", k, err)
		}
		s.data[id] = v
	}
	return s, nil
}

func (s *store) get(userID int64) (Join, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	j, ok := s.data[userID]
	return j, ok
}

func (s *store) set(userID int64, j Join) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data[userID] = j
	return s.saveLocked()
}

func (s *store) clear(userID int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.data, userID)
	return s.saveLocked()
}

func (s *store) all() []int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]int64, 0, len(s.data))
	for id := range s.data {
		out = append(out, id)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// saveLocked writes atomically. A half-written state file would drop every
// user's join on restart, which is exactly the thing this file exists to stop.
func (s *store) saveLocked() error {
	out := make(map[string]Join, len(s.data))
	for id, j := range s.data {
		out[fmt.Sprint(id)] = j
	}
	raw, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}
