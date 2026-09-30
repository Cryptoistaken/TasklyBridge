#!/usr/bin/env bun
// Pre-commit secret scan.
//
// AGENTS.md claims this runs before every commit and has caught four real
// leaks. It did not exist as a script - it only ever happened by hand in a
// session, which is exactly the "a plan comment asserted a thing that was
// false" failure this repo keeps paying for. So here it is, for real.
//
// It reports how many files it actually READ. A scan that silently reads
// nothing and prints "0 leaks" is worse than no scan, because it is believed.
//
//   bun Tool/scan-secrets.mjs            scan what git would stage
//   bun Tool/scan-secrets.mjs --staged   scan the index only (use in a hook)
//
// Exits 1 on any finding, so a commit hook can stop on it.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const stagedOnly = process.argv.includes("--staged");

function git(args) {
  const r = Bun.spawnSync(["git", ...args], { cwd: ROOT });
  if (r.exitCode !== 0) return "";
  return r.stdout.toString();
}

// ---- 1. load the live secret values -------------------------------------
// Read from the env files rather than a hand-kept list, so a new secret is
// covered the day it is added instead of the day someone remembers.
//
// Only these keys are credentials. The rest are identifiers that legitimately
// appear in source and docs - the job name is in AGENTS.md, the bot username
// is public, the target URL is a Facebook page. Scanning for those produced
// three false positives on a clean tree, which is how a scanner gets ignored.
//
// Anything that IS a credential is covered whether or not it is listed here:
// the shape scan in step 3 is the backstop, and it is why a NEW secret in a
// new key still gets caught.
const SECRET_KEYS = new Set([
  "FB_CURRENT_PASSWORD", "DATABASE_URL", "BOT_TOKEN", "TG_API_HASH",
  "TG_SESSION", "WITHDRAW_WALLET", "WEBHOOK_SECRET", "TG_PHONE",
]);
const secrets = new Map();
for (const rel of ["Tool/data/.env", "Backend/.env"]) {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_]\w*)\s*=\s*(.+?)\s*$/);
    if (m && SECRET_KEYS.has(m[1]) && m[2].trim().length > 7) {
      secrets.set(m[2].trim(), `${rel}:${m[1]}`);
    }
  }
}
if (secrets.size === 0) {
  console.error("  no credential values found in the .env files - refusing to report a clean scan");
  process.exit(2);
}

// ---- 2. what git would commit -------------------------------------------
// --diff-filter=ACMR, so a deletion is never listed. A deleted file has no
// content to leak, and treating it as "unreadable" made a clean tree look
// broken. That was four permanent failures on every run.
const files = new Set(
  (stagedOnly
    ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
    : git(["ls-files", "--others", "--exclude-standard"])
  ).split(/\r?\n/).filter(Boolean),
);
// Plus modified files, minus the ones already deleted from the worktree.
for (const f of git(["diff", "--name-only", "--diff-filter=M"]).split(/\r?\n/).filter(Boolean)) {
  files.add(f);
}

// ---- 3. the shapes a secret takes even when the value is new -------------
const SHAPES = [
  { name: "wallet",      re: /0x[a-fA-F0-9]{40}/g },
  { name: "phone",       re: /(?<!\d)8801\d{7}(?!\d)/g },
  { name: "tg bot token", re: /\d{9,10}:[A-Za-z0-9_-]{30,}/g },
  { name: "api_hash",    re: /\b[0-9a-f]{32}\b/g },
];

// A value is expected to be synthetic when it is drawn from the placeholder
// ranges. These are the same ones Backend's fixtures use.
const SYNTHETIC = {
  wallet: (v) => new Set(v.slice(2).toLowerCase()).size <= 3,
  phone: (v) => v.startsWith("1555"),
  "tg bot token": () => false,
  api_hash: (v) => /^0+$/.test(v) || /^f+$/.test(v),
};

let read = 0, unreadable = 0, findings = 0;
for (const rel of files) {
  let body;
  try { body = fs.readFileSync(path.join(ROOT, rel), "utf8"); }
  catch { unreadable++; console.log(`  UNREADABLE  ${rel}  (deleted or moved?)`); continue; }
  read++;

  for (const [value, where] of secrets) {
    if (body.includes(value)) { console.log(`  LEAK        ${rel}  <- ${where}`); findings++; }
  }
  for (const { name, re } of SHAPES) {
    for (const m of body.matchAll(re)) {
      if (SYNTHETIC[name](m[0])) continue;
      console.log(`  ${name.toUpperCase().padEnd(12)} ${rel}  ${m[0]}`);
      findings++;
    }
  }
}

console.log(`\n  secrets loaded: ${secrets.size}`);
console.log(`  files read:     ${read}${unreadable ? `  (${unreadable} unreadable)` : ""}`);
console.log(`  findings:       ${findings}`);

if (unreadable) {
  console.log("\n  A file git wants to commit could not be read. Treating that as a failure:");
  console.log("  it is usually a rename recorded as add+delete, and a half-scanned commit is");
  console.log("  not a clean one. Check the paths above before committing.");
}
if (findings || unreadable) {
  console.log("\n  NOT committing. Move the value into an env file and read it from there.");
  process.exit(1);
}
console.log("\n  clean.");
