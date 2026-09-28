# Withdraw flow — verified against @TasklyBux_bot

Established by observation on 2026-09-28, not inferred. This is the reference
for the admin sweep feature. Facts first, then what it means for the build.

---

## The flow, end to end

```
📤 Withdraw
    │  reply keyboard: "📤 Withdraw"
    ↓
📤 Choose withdraw method:
    │  reply keyboard: "USDT (BEP-20)" / "❌ Cancel"
    ↓
You selected USDT (BEP-20).
📉 Fee: $0.025
🔢 Minimum withdrawal amount: $0.20
    │  reply keyboard: "❌ Cancel"   ← only Cancel. No amount field yet.
    ↓
📤 Enter your USDT (BEP-20) address:
    │  reply keyboard: "❌ Cancel"
    │  ► THIS IS A FREE-TEXT INPUT, NOT A BUTTON
    ↓
You selected USDT (BEP-20).
📉 Fee: $0.025
Enter amount:
    │  reply keyboard: "❌ Cancel"
    │  ► ALSO FREE TEXT
    ↓
✅ Withdrawal request created!

💳 Method: USDT (BEP-20)
👛 Wallet: <withdraw-wallet>
💵 Debit amount: $0.3750
📉 Fee: $0.0250
💰 You will receive: $0.3500
    │
    └─► money moves. NO CONFIRMATION ANYWHERE.
```

**Step count:** 3 button presses, 2 free-text inputs, 0 confirmations.

---

## Verified values

| | |
|---|---|
| Method | **USDT (BEP-20) only.** No bKash, Nagad, or bank transfer |
| Network | **BSC**, not Ethereum and not Tron (TRC-20) |
| Fee | **$0.025 flat**, per withdrawal |
| Minimum | **$0.20** |
| Fee direction | **deducted from the amount**, not added on top |
| Example | debit $0.3750 → fee $0.0250 → **receive $0.3500** |
| Confirmation step | **none** |

The fee is 12.5% of the smallest possible payout, so a minimum-amount
withdrawal delivers noticeably less than the user typed.

---

## The four things that make this dangerous to automate

### 1. No confirmation step exists

Method → address → amount → done. Sending the amount **is** the irreversible
action. There is no last chance to catch a mistake.

### 2. The address is accepted unvalidated

`<withdraw-wallet>` was accepted without complaint.
A truncated, mistyped, or wrong-network address is unrecoverable — on-chain
transfers do not reverse.

### 3. A stray message can become an amount

The provider holds conversational state. If the bridge is left mid-flow and a
user sends an ordinary message, the bot may read it as an amount and pay out.
This is the single most dangerous property of the flow.

**Required guard:** only forward text as an amount while the bridge itself
initiated the flow and is still awaiting that specific reply. Never re-enter
withdraw on a bare user message, and abandon the flow if the expected screen
does not appear.

### 4. Network mismatch is the likely way users lose money

BEP-20 is **BSC**. Most people holding USDT have it on **Tron (TRC-20)**,
where addresses start with `T`. A user expecting Tron who is sent a BSC
address loses access to the funds even though the transfer "succeeded".

**Required guard:** state the network in plain words every time, and validate
the `0x` + 40 hex shape before forwarding. Consider refusing a `T…` address
outright with an explanation.

---

## What the admin sweep needs

The flow is per-account, so a sweep is the same sequence repeated across the
account pool, **one account at a time**. Per account:

1. Knock `/start`, confirm the main menu, clear any stale state
2. `📤 Withdraw` → verify `Choose withdraw method` appeared
3. `USDT (BEP-20)` → verify fee and minimum appeared, **read them, do not
   assume**. They may change.
4. Send the address → verify `Enter amount:` appeared
5. Send the amount → **this is the irreversible step**
6. Record the confirmation: debit, fee, receive, wallet

### Rules the sweep must follow

- **One account at a time.** Each has its own provider state; concurrent
  flows interleave and corrupt each other. Reuse the `opMu` whole-operation
  lock.
- **Verify every screen before typing the next field.** A missing screen means
  abort that account, not press on blindly.
- **Abort on anything unexpected** and log it. Never guess past a mismatch.
- **Re-read fee and minimum every time.** They are the provider's to change.
- **Compute the net before sending** and refuse if it is below a floor the
  operator sets, so the fee cannot eat the payout.
- **A dry-run mode is not optional here.** Walk the flow, read the screens,
  send nothing. That validates the sweep against every account without
  spending anything.

### State to record per withdrawal

Account, wallet address, amount requested, fee charged, amount received,
provider confirmation message, timestamp, and outcome. A withdrawal that the
provider accepted but that never arrived on-chain is exactly the dispute the
admin dashboard will need to answer.

---

## Decisions taken (2026-09-28)

| Question | Decision |
|---|---|
| Where does the money go? | **One fixed wallet**, `<withdraw-wallet>`, used every time for now. Configurable later, not hardcoded |
| Which accounts get swept? | **The admin picks.** No automatic sweep of the whole pool |
| When does it run? | **On demand, from the admin website.** No scheduled job |
| How are failed payouts detected? | **Not at all, for now.** The provider says "created", never "received". A chain lookup is a later addition |

### What those decisions mean

**The admin chooses the account, so the sweep is really a single-account
action.** That is the safer design and it matches the flow: the admin picks an
account in the dashboard, sees its balance, enters an amount, and the bridge
walks that one account through the flow. There is no loop over the pool, so the
interleaving risk in "one at a time" mostly disappears — one flow, one account,
one lock.

**A dry-run preview is still worth having**, even with manual selection, because
the provider flow has no confirmation. The dashboard should show the fee, the
minimum, the debit and the net **before** the admin presses the final button.
That is the only place a mistake gets caught.

**No failed-payout detection means a silent loss is possible.** The provider
confirms creation and says nothing about arrival. If the transfer fails, is
stuck, or goes to an address that cannot use BEP-20, the provider will still
have debited the account and the balance will look spent. For now this is
accepted, but the dashboard should at least **record** every withdrawal's
confirmation verbatim so a discrepancy can be investigated later.

**Recording is not detection.** The withdrawal log makes a failure *findable*
after the fact. It does not tell you at the time.

---

## Configuration

The default wallet lives in configuration, not in code:

```
Backend/.env
  WITHDRAW_WALLET=<withdraw-wallet>
  WITHDRAW_FEE=0.0250        # for display only; re-read from the screen at runtime
  WITHDRAW_MINIMUM=0.2000    # ditto
  WITHDRAW_DRY_RUN=true      # walk the flow and send nothing
```

Fee and minimum are **re-read from the provider's screen on every run** and the
configured values are only for showing an estimate in the dashboard. The
provider is free to change them, and the displayed estimate must never be
trusted over the live screen.
