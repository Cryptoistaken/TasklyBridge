#!/bin/sh
# Run submit.ts for a range of rows, one at a time, never stopping on failure.
#
#   sh run-rows.sh <xlsx> <first> <last> [phone]
#
# Each row is a separate process, so a Bail on one account does not cost the
# others. A row that fails may still be fine - a browser timeout is not a dead
# cookie - so re-running the same range retries only what never reached
# sent.jsonl. Per-row output is kept in out/logs/<tag>-row-N.log.
set -u

XLSX=${1:?usage: run-rows.sh <xlsx> <first> <last> [phone]}
FIRST=${2:?usage: run-rows.sh <xlsx> <first> <last> [phone]}
LAST=${3:?usage: run-rows.sh <xlsx> <first> <last> [phone]}
# Default session is the older one; pass a phone to override.
PHONE=${4:-8801924072634}

if [ ! -f "$XLSX" ]; then
  echo "no such file: $XLSX"
  exit 1
fi

# Log names must be unique per sheet or a second run overwrites the first.
TAG=$(echo "$XLSX" | tr -cd '[:alnum:]' | cut -c1-12)
LOGDIR="out/logs/$TAG"

mkdir -p "$LOGDIR"
echo "file:  $XLSX"
echo "rows:  $FIRST..$LAST"
echo "using: $PHONE"
echo ""

ok=0
fail=0
failed_rows=""

for row in $(seq "$FIRST" "$LAST"); do
  log="$LOGDIR/row-$row.log"
  start=$(date +%s)

  bun submit.ts -p "$PHONE" --xlsx "$XLSX" --row "$row" > "$log" 2>&1
  code=$?

  dur=$(( $(date +%s) - start ))
  creds=$(grep -m1 "Bot gave:" "$log" | sed 's/^SUCCESS *//')
  conf=$(grep -m1 "report received" "$log")
  err=$(grep -m1 -E "^ERROR|no password after" "$log" | sed 's/^ERROR *//' | cut -c1-60)

  if [ "$code" -eq 0 ] && [ -n "$conf" ]; then
    ok=$((ok + 1))
    printf 'row %-4s OK      %3ss  %s\n' "$row" "$dur" "${creds:-done}"
  else
    fail=$((fail + 1))
    failed_rows="$failed_rows $row"
    printf 'row %-4s FAIL(%s) %3ss  %s\n' "$row" "$code" "$dur" "${err:-${creds:-no output}}"
  fi
done

echo ""
echo "passed: $ok   failed: $fail"
[ -n "$failed_rows" ] && echo "retry with: sh run-rows.sh \"$XLSX\"$failed_rows $PHONE"
echo "sent.jsonl now holds $(wc -l < out/sent.jsonl) account(s)"
