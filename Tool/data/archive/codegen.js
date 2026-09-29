import { chromium } from "playwright";
import { config } from "dotenv";
import chalk from "chalk";
import path from "path";
import { fileURLToPath } from "url";
import * as XLSX from "xlsx";

config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// One account per row from the 2FA sheet: column A cookie, column B 2FA key.
function readAccounts(file) {
  const wb = XLSX.readFile(file);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error(`${file} has no sheets`);
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false });
  const out = [];
  rows.forEach((r, i) => {
    const cookie = String(r?.[0] ?? "").trim();
    const fa2Key = String(r?.[1] ?? "").trim();
    if (cookie && fa2Key) out.push({ row: i + 1, cookie, fa2Key });
  });
  if (!out.length) throw new Error(`${file} had no usable rows (need cookie + 2FA key)`);
  return out;
}

function argValue(args, names) {
  for (const a of args) {
    for (const n of names) {
      if (a.startsWith(n + "=")) return a.slice(n.length + 1);
    }
  }
  for (const n of names) {
    const i = args.indexOf(n);
    if (i !== -1 && args[i + 1] && !args[i + 1].startsWith("-")) return args[i + 1];
  }
  return undefined;
}

const log = {
  info: (msg) => console.log(chalk.blue("INFO"), chalk.white(msg)),
  success: (msg) => console.log(chalk.green("SUCCESS"), chalk.white(msg)),
  error: (msg) => console.log(chalk.red("ERROR"), chalk.white(msg)),
  debug: (msg) => console.log(chalk.gray("DEBUG"), chalk.gray(msg)),
};

const DEVICES = {
  desktop: {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
  phone: {
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
};

// Only record URLs that look like API/data calls — excludes all static assets
const HAR_FILTER =
  /^(?!.*\.(jpg|jpeg|png|gif|webp|svg|ico|mp4|mp3|wav|ogg|webm|css|js|html|htm|woff|woff2|ttf|eot)(\?|$))/i;

function parseCookies(cookieString, domain) {
  return cookieString.split(";").map((pair) => {
    const [name, ...rest] = pair.trim().split("=");
    return { name, value: rest.join("="), domain, path: "/" };
  });
}

function resolveUrl() {
  const url = process.env.TARGET_URL;
  if (!url) {
    log.error("TARGET_URL is not set in .env");
    process.exit(1);
  }
  return url;
}

function resolveCookies(args = []) {
  // --xlsx <file> --row <n> takes the cookie from the 2FA sheet instead, so a
  // specific account can be driven without pasting a credential on the command
  // line.
  const file = argValue(args, ["--xlsx"]);
  if (file) {
    const accounts = readAccounts(file);
    const want = Number(argValue(args, ["--row"]) ?? "1");
    const pick = accounts.find((a) => a.row === want);
    if (!pick) {
      log.error(
        `row ${want} not found. Usable rows: ${accounts.map((a) => a.row).join(", ")}`,
      );
      process.exit(1);
    }
    log.info(`Row ${pick.row} of ${path.basename(file)} (${accounts.length} accounts)`);
    return parseCookies(pick.cookie, process.env.COOKIE_DOMAIN ?? "facebook.com");
  }

  const raw = process.env.COOKIE_STRING;
  if (!raw) {
    log.error("COOKIE_STRING is not set in .env");
    process.exit(1);
  }
  const domain = process.env.COOKIE_DOMAIN ?? new URL(resolveUrl()).hostname;
  return parseCookies(raw.trim(), domain);
}

function resolveExtensions() {
  const raw = process.env.EXTENSIONS_DIR;
  if (!raw) return [];
  return raw.split(",").map((p) => path.resolve(p.trim()));
}

function harPath() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(__dirname, `session-${ts}.har`);
}

async function main() {
  const args = process.argv.slice(2);
  const useCookies = args.includes("-c");
  // Flags, spelled out so they cannot collide again:
  //   -c            load cookies from .env or --xlsx
  //   --dev         open DevTools with the browser
  //   --desktop     desktop UA + viewport (default is the iPhone UA)
  //   --phone       phone UA (the default, so it needs no flag)
  //   --xlsx F      take the cookie from row of sheet F, with --row N
  //   --debug[=P]   expose a CDP endpoint on P (default 9222) and stay alive
  //   -h            this list
  // NOTE: -d used to mean BOTH devtools and desktop, so one flag silently did
  // two unrelated things. -d is now devtools; --desktop is desktop.
  const useDevtools = args.includes("-d") || args.includes("--dev");
  const useHar = args.includes("-h");
  const useExtensions = args.includes("-e");
  const useDesktop = args.includes("--desktop");
  const usePhone = args.includes("--phone");

  // --debug[=port] opens a TCP CDP endpoint (default 9222) so an external
  // Playwright client (e.g. an MCP/agent) can attach to this live browser.
  const debugArg = args.find((a) => a.startsWith("--debug"));
  const debugPort = parseInt(
    (debugArg?.split("=")[1] ?? process.env.DEBUG_PORT ?? "9222"),
    10,
  );
  const useDebug = !!debugArg;

  const url = resolveUrl();
  const device = useDesktop ? DEVICES.desktop : DEVICES.phone;
  const profileDir = path.join(__dirname, "profile");
  const extensions = useExtensions ? resolveExtensions() : [];
  const hasExtensions = extensions.length > 0;

  if (useExtensions && !hasExtensions) {
    log.error("EXTENSIONS_DIR is not set in .env");
    process.exit(1);
  }

  const recordPath = useHar ? harPath() : undefined;

  const launchArgs = [
    "--disable-blink-features=AutomationControlled",
    ...(useDevtools ? ["--auto-open-devtools-for-tabs"] : []),
    ...(useDebug ? [`--remote-debugging-port=${debugPort}`] : []),
    ...(hasExtensions
      ? [
          `--disable-extensions-except=${extensions.join(",")}`,
          `--load-extension=${extensions.join(",")}`,
        ]
      : []),
  ];

  const context = await chromium.launchPersistentContext(profileDir, {
    ...device,
    locale: "en-US",
    headless: false,
    channel: "chrome",
    args: launchArgs,
    ...(useHar && {
      recordHar: {
        path: recordPath,
        content: "embed",
        mode: "minimal",
        urlFilter: HAR_FILTER,
      },
    }),
  });

  log.info(`Device: ${useDesktop ? "Desktop" : "Phone (default)"}`);
  log.info(`Profile: ${profileDir}`);

  if (hasExtensions) {
    log.success(`Loaded ${extensions.length} extension(s)`);
    extensions.forEach((e) => log.info(`Extension: ${e}`));
  }

  if (useCookies) {
    await context.addCookies(resolveCookies(args));
    log.success("Cookies loaded");
  }

  if (useHar) {
    log.info(`HAR recording enabled, will save to ${recordPath}`);
    log.info("HAR filter active: API calls only, static assets excluded");
  }

  if (useDevtools) {
    log.info("Network logging enabled");
  }

  const page = context.pages()[0] ?? (await context.newPage());

  if (useDevtools) {
    page.on("request", (req) => log.debug(`REQ  ${req.method()} ${req.url()}`));
    page.on("response", (res) =>
      log.debug(`RES  ${res.status()} ${res.url()}`),
    );
  }

  // Step 1: Visit facebook.com first to establish the session cookies in the browser
  // business.facebook.com uses the same parent-domain cookies (.facebook.com)
  // Use "load" not "networkidle" — Facebook keeps polling endlessly
  const homeUrl = "https://www.facebook.com/";
  await page.goto(homeUrl, { waitUntil: "load" });
  log.success(`Established session on ${homeUrl}`);

  // Step 2: Navigate to the actual target URL
  await page.goto(url, { waitUntil: "load" });
  log.success(`Opened ${url}`);

  await page.pause();

  // With --debug, keep the browser alive until the user closes it — the CDP
  // endpoint stays available for external attach (Playwright Inspector pause
  // would otherwise resume/close on SIGINT).
  if (useDebug) {
    log.info(
      chalk.green(`CDP endpoint: http://localhost:${debugPort} — attach with`),
    );
    log.info(chalk.gray("  chromium.connectOverCDP(`http://localhost:" + debugPort + "`)"));
    log.info(chalk.gray("Press Ctrl+C in this terminal to close the browser."));
    await new Promise((resolve) => process.on("SIGINT", resolve));
  }

  await context.close();

  if (useHar) {
    log.success(`HAR file saved to ${recordPath}`);
  }
}

main().catch((err) => {
  log.error(err.message);
  process.exit(1);
});
