package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Self-tests for the sellable catalogue: which jobs we offer, what we call
// them, and what an end user is charged. This is the bridge's margin logic, so
// the static price and the "cost must never leak" rule are checked explicitly.

// priceLabel renders the static Taka figure without trailing zeros, so 5 reads
// as "5tk" rather than "5.0000tk".
func selfTestPriceLabel() error {
	for _, c := range []struct {
		in   float64
		want string
	}{
		{5, "5tk"},
		{5.5, "5.5tk"},
		{7.25, "7.25tk"},
		{120, "120tk"},
	} {
		if got := priceLabel(c.in); got != c.want {
			return fmt.Errorf("priceLabel(%v) = %q, want %q", c.in, got, c.want)
		}
	}
	return nil
}

func selfTestCatalog() error {
	if err := selfTestPriceLabel(); err != nil {
		return err
	}

	// The live list as the provider actually presents it. The job we sell is
	// "2FA:Create FB (No mail)"; the other Facebook entry is a different
	// product and must never be substituted for it.
	live := []Task{
		{Name: "2FA:Create FB (No mail)", Price: 0.050},
		{Name: "Create FB (2FA)", Price: 0.048},
		{Name: "Create Twitter", Price: 0.026},
	}

	// The shipped task.json must load and match a job the provider is listing.
	shipped, err := loadCatalog(defaultCatalogPath())
	if err != nil {
		return fmt.Errorf("the shipped task.json must load: %w", err)
	}
	offers := shipped.resolve(live)
	if len(offers) == 0 {
		return fmt.Errorf("the shipped catalogue matched none of the live jobs")
	}

	for _, o := range offers {
		// A zero or negative sell price would be offered as a free job.
		if o.SellBDT <= 0 {
			return fmt.Errorf("sell price must be above zero: %+v", o)
		}
		// The provider's dollar price is our cost. It must never reach a user.
		// The button must contain the Taka figure and no dollar sign at all.
		label := o.label()
		if strings.Contains(label, "$") || strings.Contains(label, "0.048") {
			return fmt.Errorf("the provider cost leaked into the button: %q", label)
		}
		if !strings.HasSuffix(label, "tk") {
			return fmt.Errorf("the button must end in tk: %q", label)
		}
		// Format the operator asked for: "Facebook 2fa 5tk". Name, one space,
		// static price. No separator.
		if label != o.Display+" "+priceLabel(o.SellBDT) {
			return fmt.Errorf("button format changed: %q", label)
		}
		if strings.Contains(label, "--") {
			return fmt.Errorf("the button must not contain a separator: %q", label)
		}
	}

	// THE decisive test. The provider lists several near-identical products and
	// they are not interchangeable:
	//
	//	2FA:Create FB (No mail)   <- the one we support
	//	Create FB (2FA)          <- a different product
	//
	// A naive substring of "Create FB" matches both, and the wrong job would be
	// sold under the right name. Every term in require_all must be present.
	bothJobs := []Task{
		{Name: "2FA:Create FB (No mail)", Price: 0.050},
		{Name: "Create FB (2FA)", Price: 0.048},
		{Name: "Create Twitter", Price: 0.026},
	}
	strict := &catalog{jobs: []jobConfig{{
		RequireAll: []string{"2FA:Create FB", "No mail"},
		Name:       "Facebook 2fa", SellBDT: 5, Enabled: true,
	}}}
	picked := strict.resolve(bothJobs)
	if len(picked) != 1 {
		return fmt.Errorf("require_all must select exactly one job, got %d: %+v", len(picked), picked)
	}
	if picked[0].Provider.Name != "2FA:Create FB (No mail)" {
		return fmt.Errorf("selected the wrong job: %q", picked[0].Provider.Name)
	}
	if picked[0].Provider.Price != 0.050 {
		return fmt.Errorf("must carry the matched job's real price, got %v", picked[0].Provider.Price)
	}

	// The wrong variant alone must resolve to nothing, not to a near miss.
	onlyWrong := strict.resolve([]Task{{Name: "Create FB (2FA)", Price: 0.048}})
	if len(onlyWrong) != 0 {
		return fmt.Errorf(`"Create FB (2FA)" must not match a catalogue entry requiring "No mail", got %+v`, onlyWrong)
	}
	// And when the real job is withdrawn, availability is false rather than
	// silently falling through to the wrong product.
	onlyWrongLive := []Task{{Name: "Create FB (2FA)", Price: 0.048}}
	if len(strict.resolve(onlyWrongLive)) != 0 {
		return fmt.Errorf("with the supported job gone, no job may be offered")
	}

	// A loose entry would match both, which is the bug this field prevents.
	loose := &catalog{jobs: []jobConfig{{
		RequireAll: []string{"Create FB"}, Name: "wrong", SellBDT: 5, Enabled: true,
	}}}
	if got := loose.resolve(bothJobs); len(got) != 1 {
		return fmt.Errorf("a loose match should still take the first, got %+v", got)
	}
	if loose.resolve(bothJobs)[0].Provider.Name != "2FA:Create FB (No mail)" {
		return fmt.Errorf("sanity: loose match ordering")
	}

	// Price is NOT part of the match, so it may move freely.
	for _, price := range []float64{0.050, 0.055, 0.030, 0.120} {
		probe := strict.resolve([]Task{{Name: "2FA:Create FB (No mail)", Price: price}})
		if len(probe) != 1 {
			return fmt.Errorf("a price change to %.4f must not stop the job matching", price)
		}
		if probe[0].SellBDT != 5 {
			return fmt.Errorf("the static sell price must not follow the provider, got %v", probe[0].SellBDT)
		}
	}
	// Case and spacing are not the provider's exact wording, so require_all is
	// case-insensitive on purpose.
	for _, variant := range []string{
		"2fa:create fb (no mail)",
		"2FA:Create FB (No mail)  ",
		"🌟 2FA:Create FB (No mail)",
	} {
		if len(strict.resolve([]Task{{Name: variant, Price: 0.05}})) != 1 {
			return fmt.Errorf("require_all must tolerate %q", variant)
		}
	}

	// The display name is ours, not the provider's, so the catalogue controls
	// what a user is called. An empty name falls back rather than showing blank.
	named := (&catalog{jobs: []jobConfig{
		{RequireAll: []string{"2FA:Create FB", "No mail"}, Name: "Facebook 2fa", SellBDT: 5, Enabled: true},
	}}).resolve([]Task{{Name: "2FA:Create FB (No mail)", Price: 0.05}})
	if len(named) != 1 || named[0].Display != "Facebook 2fa" {
		return fmt.Errorf("the display name must come from the catalogue: %+v", named)
	}
	if got := named[0].label(); got != "Facebook 2fa 5tk" {
		return fmt.Errorf("expected \"Facebook 2fa 5tk\", got %q", got)
	}
	fallback := (&catalog{jobs: []jobConfig{
		{RequireAll: []string{"2FA:Create FB", "No mail"}, SellBDT: 5, Enabled: true},
	}}).resolve([]Task{{Name: "2FA:Create FB (No mail)", Price: 0.05}})
	if len(fallback) != 1 || fallback[0].Display != "2FA:Create FB (No mail)" {
		return fmt.Errorf("an empty name must fall back to the provider name: %+v", fallback)
	}

	// A job we do not sell is hidden, not offered.
	hidden := hiddenFrom(live, offers)
	foundTwitter := false
	for _, h := range hidden {
		if strings.Contains(h.Name, "Twitter") {
			foundTwitter = true
		}
	}
	if !foundTwitter {
		return fmt.Errorf("an unsold job must be hidden, got %+v", hidden)
	}

	// A configured job the provider is not listing resolves to nothing. It must
	// not become a free job.
	absent := (&catalog{jobs: []jobConfig{
		{RequireAll: []string{"No Such Job"}, SellBDT: 5, Enabled: true},
	}}).resolve(live)
	if len(absent) != 0 {
		return fmt.Errorf("an absent provider job must resolve to nothing, got %+v", absent)
	}

	// A disabled job is hidden even when the provider lists it.
	disabled := (&catalog{jobs: []jobConfig{
		{RequireAll: []string{"2FA:Create FB", "No mail"}, SellBDT: 5, Enabled: false},
	}}).resolve(live)
	if len(disabled) != 0 {
		return fmt.Errorf("a disabled job must not be offered, got %+v", disabled)
	}

	// An out-of-range or negative tap is refused, so a job we do not sell
	// cannot be started by guessing a callback value.
	if _, ok := shipped.find(offers, len(offers)); ok {
		return fmt.Errorf("an out-of-range index must not resolve")
	}
	if _, ok := shipped.find(offers, -1); ok {
		return fmt.Errorf("a negative index must not resolve")
	}
	if _, ok := shipped.find(offers, 0); !ok {
		return fmt.Errorf("index 0 must resolve when a job is offered")
	}

	// The cost check is a safety net for a static price. With no rate
	// configured it must stay silent rather than inventing a conversion.
	noRate := &catalog{jobs: []jobConfig{
		{RequireAll: []string{"2FA:Create FB", "No mail"}, SellBDT: 5, Enabled: true},
	}}
	if _, losing := noRate.sellingAtLoss(named[0]); losing {
		return fmt.Errorf("with no rate configured the cost check must not fire")
	}
	// The cost check is the safety net for a static price: it cannot follow the
	// market, so it must be able to say "this is now a loss".
	// At the provider's real $0.050, a 104tk/$ rate gives 5.20tk, which is OVER
	// 5tk, so that combination is a loss and must be reported.
	overRate := &catalog{
		jobs:    []jobConfig{{RequireAll: []string{"2FA:Create FB", "No mail"}, SellBDT: 5, Enabled: true}},
		bdtRate: 104,
	}
	overCost, overLosing := overRate.sellingAtLoss(named[0])
	if overCost < 5.15 || overCost > 5.25 {
		return fmt.Errorf("cost conversion looks wrong: %.4f, want about 5.20", overCost)
	}
	if !overLosing {
		return fmt.Errorf("$0.050 at 104tk/$ is %.2ftk, over 5tk, so a loss must be reported", overCost)
	}

	// A lower rate puts the cost under 5tk, and then it must stay silent.
	cheapRate := &catalog{
		jobs:    []jobConfig{{RequireAll: []string{"2FA:Create FB", "No mail"}, SellBDT: 5, Enabled: true}},
		bdtRate: 90,
	}
	cheapCost, cheapLosing := cheapRate.sellingAtLoss(named[0])
	if cheapCost < 4.45 || cheapCost > 4.55 {
		return fmt.Errorf("cost conversion looks wrong: %.4f, want about 4.50", cheapCost)
	}
	if cheapLosing {
		return fmt.Errorf("$0.050 at 90tk/$ is %.2ftk, under 5tk, so must not report a loss", cheapCost)
	}

	// A malformed or unusable catalogue must be rejected loudly rather than
	// quietly selling nothing, which looks identical to no stock.
	tmp, err := os.MkdirTemp("", "cat")
	if err != nil {
		return fmt.Errorf("temp dir: %w", err)
	}
	defer os.RemoveAll(tmp)

	bad := map[string]string{
		"notjson.json": "{not json",
		"nojobs.json":  `{"jobs":[]}`,
		"nomatch.json": `{"jobs":[{"match":"  ","name":"x","sell_bdt":5}]}`,
		"nosell.json":  `{"jobs":[{"match":"Create FB","sell_bdt":0}]}`,
		"negsell.json": `{"jobs":[{"match":"Create FB","sell_bdt":-5}]}`,
		"missingsell":  `{"jobs":[{"match":"Create FB"}]}`,
	}
	for name, body := range bad {
		path := filepath.Join(tmp, name)
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			return err
		}
		if _, err := loadCatalog(path); err == nil {
			return fmt.Errorf("%s must be rejected", name)
		}
	}

	// Alerts must never be delivered with no admin, because that would silently
	// drop a price change. A temp dir keeps the check from writing a real log.
	n := &botNotifier{a: newAudit(tmp)}
	if err := n.notify("test"); err == nil {
		return fmt.Errorf("an alert with no admins must report failure, not succeed")
	}
	return nil
}
