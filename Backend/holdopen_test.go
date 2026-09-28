package main

// A connected MTProto callback must not return.
//
// client.Run reads a returned callback as a request to disconnect. The account
// supervisor registers an account and its callback returned nil, so the
// connection was torn down the instant it connected, the fleet was emptied by
// the supervisor immediately afterwards, and the bot was left pointing at a dead
// client. Nothing logged it: the supervisor only logs when a runner returns an
// ERROR, and this returned nil.
//
// The old single-account code never hit this because its callback was the poll
// loop, which blocks on its own. Moving the poll loop out - which is what
// supporting several accounts required - exposed it.

import (
	"context"
	"testing"
	"time"
)

func TestHoldOpenDoesNotReturnWhileTheContextIsLive(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	returned := make(chan error, 1)
	go func() { returned <- holdOpen(ctx) }()

	// It must still be blocked well after a connected client would have given up
	// on us. A short wait is enough: the failure was immediate.
	select {
	case err := <-returned:
		t.Fatalf("holdOpen returned %v while the context was still live; "+
			"client.Run would have disconnected the account", err)
	case <-time.After(250 * time.Millisecond):
		// Correct: still holding the connection open.
	}
}

func TestHoldOpenReturnsWhenTheContextEnds(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())

	returned := make(chan error, 1)
	go func() { returned <- holdOpen(ctx) }()
	cancel()

	select {
	case err := <-returned:
		if err != nil {
			t.Errorf("holdOpen returned %v, want nil so a clean shutdown is not logged as a failure", err)
		}
	case <-time.After(2 * time.Second):
		t.Error("holdOpen did not return after the context was cancelled; " +
			"the process would never shut down")
	}
}
