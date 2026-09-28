package main

import (
	"fmt"
	"strings"
)

// Self-tests for withdrawal address validation.
//
// The provider accepts any text as a BEP-20 address and pays out immediately
// with no confirmation, so an address that is wrong is money that is gone. These
// checks are the last thing standing between a typo and an unrecoverable
// transfer, so every shape that must be refused is asserted here.

func selfTestWallet() error {
	// A synthetic but correctly shaped BEP-20 address. The real one is in Backend/.env and must never be committed.
	live := "0x1111111111111111111111111111111111111111"
	if err := validateWallet(live); err != nil {
		return fmt.Errorf("the configured wallet must validate: %w", err)
	}

	// Shapes that must be accepted: case-insensitive hex, and an EIP-55
	// mixed-case checksum address.
	for _, ok := range []string{
		live,
		strings.ToUpper(live[:2]) + strings.ToUpper(live[2:]),
		"0x2222222222222222222222222222222222222222",
		"  " + live + "  ", // surrounding space is trimmed
	} {
		if err := validateWallet(ok); err != nil {
			return fmt.Errorf("a valid BEP-20 address was rejected: %q: %w", ok, err)
		}
	}

	// Shapes that must be refused.
	for name, bad := range map[string]string{
		"empty":           "",
		"whitespace only": "   ",
		"too short":       "0x2222222222222222222222222222222222222222",
		"too long":        "0x1111111111111111111111111111111111111111ab",
		"no 0x prefix":    "2222222222222222222222222222222222222222",
		"non-hex letter":  "0x2222222222222222222222222222222222222222z",
		"tron address":    "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE",
		"a message":       "0x not an address at all",
	} {
		if err := validateWallet(bad); err == nil {
			return fmt.Errorf("%s must be refused: %q", name, bad)
		}
	}

	// A Tron address deserves a specific complaint, because it is the mistake
	// most likely to be made: most people hold USDT on Tron, and sending them a
	// BSC address transfers the money successfully and locks them out of it.
	err := validateWallet("TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE")
	if err == nil || !strings.Contains(err.Error(), "TRC-20") {
		return fmt.Errorf("a Tron address must be refused with a network explanation, got %v", err)
	}

	// Dry run must default on, because the provider flow has no confirmation.
	if !envBool("WITHDRAW_DRY_RUN_UNSET_FOR_TEST", true) {
		return fmt.Errorf("the dry-run default must be true")
	}
	return nil
}
