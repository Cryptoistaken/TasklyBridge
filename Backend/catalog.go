package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// The catalogue is the bridge's own commercial layer. The provider lists many
// jobs at the provider's price; this file decides which of them we sell, what we
// call them, and what end users are charged, which is where our cut comes from.
//
// The provider price is never shown to a user. It is the cost, not the price.

// jobConfig is one sellable job.
type jobConfig struct {
	// RequireAll are case-insensitive substrings that must ALL appear in the
	// provider's job name for this entry to count as available.
	//
	// This is the whole point of the field. The provider lists several very
	// similar products at once, and they are not interchangeable:
	//
	//	2FA:Create FB (No mail)   <- the one we support
	//	Create FB (2FA)          <- a different product, must NOT be offered
	//
	// A single substring of "Create FB" would match both, and the wrong job
	// would be sold under the right name. Requiring every term means the
	// provider's own wording decides availability, and the price is free to
	// move because it is not part of the match.
	RequireAll []string `json:"require_all"`
	// Name is what end users see. Defaults to the provider's name.
	Name string `json:"name"`
	// SellBDT is the static price shown to end users, in Bangladeshi Taka.
	//
	// It is deliberately static rather than derived from the provider's dollar
	// price. There is no conversion rate configured, so a computed price would
	// be a guess dressed up as arithmetic, and it would change every time the
	// provider moved its price by a cent. A static figure is honest: it is the
	// price the operator decided to charge.
	//
	// Consequence: if the provider's cost rises above what this figure yields,
	// the bridge sells at a loss and nothing warns about it. See bdt_rate.
	SellBDT float64 `json:"sell_bdt"`
	// Enabled hides a job without deleting it.
	Enabled bool `json:"enabled"`
	// Group is the provider sub-menu holding this job, matched by substring.
	Group string `json:"group"`
}

// catalogFile is the on-disk shape of task.json.
type catalogFile struct {
	Jobs []jobConfig `json:"jobs"`
	// BdtRate optionally converts the provider's dollar price to Taka, and is
	// used for one purpose only: warning an admin when the provider's cost
	// exceeds what sell_bdt is charging. It is never shown to a user, and the
	// displayed price does not depend on it. Zero disables the check.
	BdtRate float64 `json:"bdt_rate"`
}

type catalog struct {
	jobs    []jobConfig
	bdtRate float64
	path    string
}

// offer is one job resolved against what the provider currently lists: the
// provider's own name and price, plus what we charge.
type offer struct {
	Provider Task   // what the provider calls it, and what it costs us
	Display  string // what we call it
	SellBDT  float64
	Config   jobConfig
}

func loadCatalog(path string) (*catalog, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	var file catalogFile
	if err := json.Unmarshal(raw, &file); err != nil {
		return nil, fmt.Errorf("%s is not valid JSON: %w", path, err)
	}
	if len(file.Jobs) == 0 {
		return nil, fmt.Errorf("%s lists no jobs", path)
	}
	for i, j := range file.Jobs {
		if len(j.RequireAll) == 0 {
			return nil, fmt.Errorf("%s job %d has no require_all, so it would match every job", path, i+1)
		}
		for k, term := range j.RequireAll {
			if strings.TrimSpace(term) == "" {
				return nil, fmt.Errorf("%s job %d has an empty require_all term at position %d", path, i+1, k+1)
			}
		}
		if j.SellBDT <= 0 {
			return nil, fmt.Errorf("%s job %d has no sell_bdt above zero, "+
				"so it would be offered as a free job", path, i+1)
		}
	}
	return &catalog{jobs: file.Jobs, bdtRate: file.BdtRate, path: path}, nil
}

// priceLabel is the static Taka figure, rendered without trailing zeros so
// "5" reads as "5tk" rather than "5.00tk".
func priceLabel(bdt float64) string {
	return strconv.FormatFloat(bdt, 'f', -1, 64) + "tk"
}

// costInBDT converts the provider's dollar cost using the optional rate. It
// returns false when no rate is configured, which is the normal case: the
// displayed price does not depend on it.
func (c *catalog) costInBDT(offer offer) (float64, bool) {
	if c.bdtRate <= 0 {
		return 0, false
	}
	return offer.Provider.Price * c.bdtRate, true
}

// sellingAtLoss reports whether the provider's cost exceeds what we charge.
// Without a configured rate this cannot be judged, and it returns false rather
// than guessing a conversion.
func (c *catalog) sellingAtLoss(offer offer) (float64, bool) {
	cost, ok := c.costInBDT(offer)
	if !ok {
		return 0, false
	}
	return cost, cost > offer.SellBDT
}

// matches reports whether a provider job name satisfies every require_all
// term. Matching is case-insensitive and on the name only, so the provider is
// free to change the price in the label.
func matches(job jobConfig, providerName string) bool {
	low := strings.ToLower(providerName)
	for _, term := range job.RequireAll {
		if !strings.Contains(low, strings.ToLower(strings.TrimSpace(term))) {
			return false
		}
	}
	return true
}

// resolve pairs the provider's live job list with the catalogue. A configured
// job that the provider is not currently offering is simply absent, which the
// caller reports as unavailable rather than as a price of zero.
func (c *catalog) resolve(live []Task) []offer {
	var out []offer
	for _, job := range c.jobs {
		if !job.Enabled {
			continue
		}
		for _, t := range live {
			if !matches(job, t.Name) {
				continue
			}
			name := job.Name
			if strings.TrimSpace(name) == "" {
				name = t.Name
			}
			out = append(out, offer{
				Provider: t,
				Display:  name,
				SellBDT:  job.SellBDT,
				Config:   job,
			})
			break // one provider job per catalogue entry
		}
	}
	return out
}

// catalogSubject names the job we sell, for availability alerts. The first
// enabled entry is the one being offered, so that is what alerts talk about.
func catalogSubject(c *catalog) string {
	if c == nil {
		return "the job"
	}
	for _, j := range c.jobs {
		if j.Enabled {
			if strings.TrimSpace(j.Name) != "" {
				return j.Name
			}
			return strings.Join(j.RequireAll, " + ")
		}
	}
	return "the job"
}

// hiddenFrom lists provider jobs the catalogue does not sell, so the audit log
// can show what end users are not being offered.
func hiddenFrom(live []Task, offers []offer) []Task {
	sold := map[string]bool{}
	for _, o := range offers {
		sold[strings.ToLower(o.Provider.Name)] = true
	}
	var out []Task
	for _, t := range live {
		if !sold[strings.ToLower(t.Name)] {
			out = append(out, t)
		}
	}
	return out
}

// describeMiss explains, to an operator, why nothing is being offered.
//
// This matters because the two causes look identical from outside: a job the
// provider has withdrawn, and a job whose name no longer matches the
// catalogue. The first is normal and self-healing. The second is a
// configuration problem that will silently sell nothing until someone notices,
// so it is worth saying which one happened.
func (c *catalog) describeMiss(live []Task) string {
	if len(live) == 0 {
		return "the provider returned no jobs at all, so the menu could not be read"
	}
	names := make([]string, 0, len(live))
	for _, t := range live {
		names = append(names, fmt.Sprintf("%q ($%.4f)", t.Name, t.Price))
	}
	var wanted []string
	for _, j := range c.jobs {
		if j.Enabled {
			wanted = append(wanted, strings.Join(j.RequireAll, " + "))
		}
	}
	return fmt.Sprintf(
		"the provider offers %s, but no catalogue entry matches %v. "+
			"This is a configuration problem, not an outage: the bot will show no jobs until "+
			"require_all in task.json is updated to a name the provider is actually using.",
		strings.Join(names, ", "), wanted)
}

// find returns the offer a callback index refers to. The index is validated
// against the resolved list, so a hidden job cannot be joined by guessing.
func (c *catalog) find(offers []offer, idx int) (offer, bool) {
	if idx < 0 || idx >= len(offers) {
		return offer{}, false
	}
	return offers[idx], true
}

// label is the inline button text: our name, then the static Taka price.
// No separator and no dollar sign, because the provider's dollar price is our
// cost and must never be shown to a user.
func (o offer) label() string {
	return fmt.Sprintf("%s %s", o.Display, priceLabel(o.SellBDT))
}

// formatJob renders a provider job for the audit log, in dollars, because that
// is the currency the provider quotes in.
func formatJob(name string, price float64) string {
	return fmt.Sprintf("%s $%.4f", name, price)
}

func defaultCatalogPath() string {
	return envOr("TASK_JSON", filepath.Join("Backend", "task.json"))
}
