# Taskly Tool

Single-file submitter: takes accounts from xlsx, checks cookies, gets a bot password, changes the Facebook password, submits key + cookie. Why one file: the old 15-script split is archived in `archive/` and is not maintained.

## Setup

```
cd Tool
bun install
npx playwright install chromium
copy .env.example .env   # then fill in values
```

Put sheets in `data/` (gitignored, never committed).

## Run

```
bun index.js --xlsx data\a.xlsx --row 5 -p <phone> -o <currentPw>
bun index.js --xlsx data\a.xlsx data\b.xlsx --all -p <phone>
bun index.js --xlsx data\a.xlsx --all --plan -p <phone>   # grouping only, spends nothing
bun index.js -P <assignedPw> -o <current> --fa2 <key> --xlsx data\a.xlsx --row 5   # resume
bun index.js --login <phone>                              # one-time Telegram sign-in
bun index.js --codegen --xlsx data\a.xlsx --row 5        # open browser with that row's cookie, pause for inspector
```

Flags: `--row N`, `--force` (retry sent/gated), `--dry-run` (walk + Start, stop before Facebook), `--per-session N` (default 3), `--fa2` (override sheet key).

## Password reuse rule

One bot password covers max 3 cookies and retires after 1 success. A gated/dead cookie is recorded in `out/skipped.jsonl` and the same password carries to the next cookie with no new Start. Used passwords are hashed in `out/used-passwords.json`.

## Ledgers (`out/`)

`sent.jsonl` = done, `skipped.jsonl` = never retry, `audit-*.jsonl` = replay log. Only cookie fingerprints are stored, never cookies.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `cookie is dead (confirmed twice)` | Login wall on both probes | Replace cookie, or `--force` to try anyway |
| `gated: SMS confirmation code` | Facebook wants a phone code | Not retryable; row stays skipped |
| `no password after 3 Start attempts` | Bot issued no credentials | Retry later; nothing was sent |
| `no button matches` | Provider relabelled a button | Read `on screen:` list, update matcher |
| `not on the main menu` | Stuck modal state | Auto-clears with Cancel 3x, then aborts group |
| `button stayed disabled` | New equals current / too short | Page hint is printed; check password |
| `Telegram connection dropped` | Network/auth conflict | Group stops; re-run (done rows skip) |
