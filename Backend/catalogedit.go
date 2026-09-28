package main

import (
	"encoding/json"
	"fmt"
	"os"
)

// The CLI mutates the catalogue, so the write path lives here rather than being
// duplicated. Every edit re-reads the file, changes one job, and writes it back
// atomically, so a crash cannot leave a half-written task.json.

// setEnabled shows or hides a job. Jobs are matched on the display name, which
// is what the operator sees in the dashboard.
//
// The in-memory catalogue is updated too, and that is not a nicety. The
// dashboard endpoint answers from c.jobs, not from the file, so without this the
// toggle persisted correctly and then reported the old value back: the button
// flipped, the page disagreed with the server, and the row only corrected itself
// on the next reload. Anything else reading the catalogue in this process - the
// availability check especially - would keep offering a job the operator had
// just hidden.
func (c *catalog) setEnabled(name string, enabled bool) error {
	raw, err := readCatalogFile(c.path)
	if err != nil {
		return err
	}
	if err := mutateJob(raw, name, func(j *jobConfig) { j.Enabled = enabled }); err != nil {
		return err
	}
	if err := writeCatalogFile(c.path, raw); err != nil {
		return err
	}
	for i := range c.jobs {
		if matchesJobName(c.jobs[i], name) {
			c.jobs[i].Enabled = enabled
		}
	}
	state := "hidden"
	if enabled {
		state = "enabled"
	}
	fmt.Printf("%s is now %s\n", name, state)
	return nil
}

// setPrice changes the static Taka figure. The price is deliberately not
// derived from the provider's dollar cost: a computed price would move whenever
// the provider moved, and the operator's margin should be a decision rather
// than a side effect.
func (c *catalog) setPrice(name string, bdt float64) error {
	raw, err := readCatalogFile(c.path)
	if err != nil {
		return err
	}
	if err := mutateJob(raw, name, func(j *jobConfig) { j.SellBDT = bdt }); err != nil {
		return err
	}
	if err := writeCatalogFile(c.path, raw); err != nil {
		return err
	}
	fmt.Printf("%s now sells at %s\n", name, priceLabel(bdt))
	return nil
}

// readCatalogFile re-reads the file from disk rather than reusing the loaded
// copy, so a CLI edit does not write back a stale in-memory version over a
// change made elsewhere.
func readCatalogFile(path string) (*catalogFile, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	var file catalogFile
	if err := json.Unmarshal(raw, &file); err != nil {
		return nil, fmt.Errorf("%s is not valid JSON: %w", path, err)
	}
	return &file, nil
}

func mutateJob(file *catalogFile, name string, fn func(*jobConfig)) error {
	for i := range file.Jobs {
		if matchesJobName(file.Jobs[i], name) {
			fn(&file.Jobs[i])
			return nil
		}
	}
	names := make([]string, 0, len(file.Jobs))
	for _, j := range file.Jobs {
		names = append(names, j.Name)
	}
	return fmt.Errorf("no job named %q; the catalogue has: %v", name, names)
}

func matchesJobName(j jobConfig, query string) bool {
	if equalFold(j.Name, query) {
		return true
	}
	// Also allow the provider-side name, so the operator can use whichever
	// name they can actually see.
	for _, term := range j.RequireAll {
		if equalFold(term, query) {
			return true
		}
	}
	return false
}

func equalFold(a, b string) bool {
	return len(a) == len(b) && lower(a) == lower(b)
}

func lower(s string) string {
	out := []byte(s)
	for i := range out {
		if out[i] >= 'A' && out[i] <= 'Z' {
			out[i] += 'a' - 'A'
		}
	}
	return string(out)
}

func writeCatalogFile(path string, file *catalogFile) error {
	raw, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	// Atomic, because a truncated task.json means the bridge silently offers
	// nothing at all.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func jsonMarshalIndent(v any) ([]byte, error) { return json.MarshalIndent(v, "", "  ") }

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }
