/**
 * Capture the network traffic Facebook generates for a good and a bad cookie,
 * then diff them to find a cheap request that reveals session state.
 *
 *   bun CaptureNet.ts 30 13
 *
 * Writes out/net-<row>.json with {url, method, status, type} per request.
 */
import { chromium } from "playwright";
import fs from "fs";
import os from "os";
import path from "path";
import { config } from "dotenv";
import { readAccounts, parseCookies, DEVICES_PHONE } from "./PC.ts";

config();

const rows = process.argv.slice(2).map(Number);
if (rows.length !== 2) {
  console.error("usage: bun CaptureNet.ts <goodRow> <badRow>");
  process.exit(1);
}

const file = fs.readdirSync(".").find((n) => n.includes("ffpp"))!;
const accounts = readAccounts(file);

for (const row of rows) {
  const acct = accounts.find((a) => a.row === row)!;
  const dir = path.join(os.tmpdir(), `netcap-${row}-${Date.now()}`);
  const ctx = await chromium.launchPersistentContext(dir, {
    ...DEVICES_PHONE,
    locale: "en-GB",
    headless: true,
    channel: "chrome",
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const seen: any[] = [];
  ctx.on("response", async (res) => {
    const req = res.request();
    const url = res.url();
    // Keep only Facebook API-ish traffic; drop static assets.
    if (!/facebook\.com|fbcdn\.net/.test(url)) return;
    if (/\.(js|css|png|jpg|jpeg|gif|svg|woff2?|ttf|ico|webp|mp4)(\?|$)/i.test(url)) return;
    seen.push({
      method: req.method(),
      url: url.slice(0, 220),
      status: res.status(),
      type: req.resourceType(),
    });
  });

  try {
    await ctx.addCookies(parseCookies(acct.cookie.trim(), "www.facebook.com"));
    const page = await ctx.newPage();
    await page.goto("https://www.facebook.com/", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page.waitForTimeout(6_000);
    const body = (await page.evaluate(() => document.body?.innerText ?? "")).replace(
      /\s+/g,
      " ",
    );
    console.log(`\nrow ${row}: ${body.slice(0, 100)}`);
  } catch (e) {
    console.log(`row ${row}: ERROR ${(e as Error).message.slice(0, 90)}`);
  } finally {
    fs.writeFileSync(`out/net-${row}.json`, JSON.stringify(seen, null, 1));
    console.log(`  captured ${seen.length} requests -> out/net-${row}.json`);
    await ctx.close().catch(() => {});
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {}
  }
}
