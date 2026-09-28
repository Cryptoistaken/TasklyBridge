// Settings — the editable subset only. Secrets are never in the payload and
// are never rendered.

import { get, put, type Settings } from "../api";
import { chip, field, h, pageHead, section, type Page } from "../ui";

const SECRET_NAMES = ["BOT_TOKEN", "TG_API_HASH", "ADMIN_PASSWORD", "ADMIN_SESSION_SECRET"];
const MIN_WATCH_SECONDS = 300; // the bridge floor: 5 minutes

let view: HTMLElement | null = null;
let s: Settings | null = null;
let bound: HTMLInputElement | null = null;
let adminIds: HTMLInputElement | null = null;
let walletIn: HTMLInputElement | null = null;
let dryRunIn: HTMLInputElement | null = null;
let watchInterval: HTMLInputElement | null = null;
let watchJob: HTMLInputElement | null = null;
let dryWarn: HTMLElement | null = null;
let saveErr: HTMLElement | null = null;
let saveOk: HTMLElement | null = null;

function paint(): void {
  if (!view || !s) return;

  bound = h("input", { class: "input", type: "number", value: String(s.bound_user_id) });
  adminIds = h("input", { class: "input", type: "text", value: s.admin_ids.join(", "), placeholder: "1772093705" });
  walletIn = h("input", { class: "input", type: "text", value: s.withdraw_wallet, spellcheck: "false" });
  dryRunIn = h("input", { type: "checkbox", checked: s.withdraw_dry_run, onchange: toggleDryWarn });
  watchInterval = h("input", {
    class: "input",
    type: "number",
    min: String(MIN_WATCH_SECONDS),
    step: "60",
    value: String(s.watch_interval_seconds),
  });
  watchJob = h("input", { class: "input", type: "text", value: s.watch_job });

  dryWarn = h("p", { class: "notice bad", hidden: s.withdraw_dry_run, text: "Turning this off enables real payouts. The provider has no confirmation step." });
  saveErr = h("p", { class: "notice bad", hidden: true });
  saveOk = h("p", { class: "notice", hidden: true, text: "Saved." });

  view.replaceChildren(
    pageHead("Settings", "editable configuration · secrets are never sent by the API"),
    section(
      "Editable",
      h(
        "div",
        { class: "card" },
        h(
          "div",
          { class: "form-grid" },
          field("Bound user id", bound),
          field("Admin ids (comma separated)", adminIds),
          field("Withdrawal wallet (BEP-20 · BSC)", walletIn),
          field("Watch interval (seconds)", watchInterval),
          field("Watch job", watchJob),
          h("div", { class: "field" }, h("span", { text: "Withdraw dry run" }), h("div", { class: "row" }, dryRunIn, h("span", { class: "muted small", text: "walk the flow, send nothing" }))),
        ),
        dryWarn,
        h("div", { class: "row", style: "margin-top:16px" }, h("button", { class: "btn primary", type: "button", text: "Save", onclick: () => void save() })),
        saveErr,
        saveOk,
      ),
    ),
    section(
      "Read only",
      h(
        "div",
        { class: "card" },
        h(
          "div",
          { class: "form-grid" },
          readOnly("Catalog path", s.catalog_path),
          readOnly("Audit retained days", String(s.audit_retained_days)),
        ),
      ),
    ),
    section(
      "Secrets",
      h("p", { class: "muted small", style: "margin-bottom:10px" }, "Present / not set cannot be shown: the API never returns whether a secret exists, so nothing sensitive can be rendered. All four live in ", h("span", { class: "mono", text: "Backend/.env" }), "."),
      h(
        "div",
        { class: "card stack" },
        ...SECRET_NAMES.map((n) => h("div", { class: "row" }, h("span", { class: "mono", text: n }), chip("not exposed", "muted"))),
      ),
    ),
  );
}

function readOnly(label: string, value: string): HTMLElement {
  return h(
    "div",
    {},
    h("div", { class: "label", text: label }),
    h("div", { class: "mono", style: "margin-top:6px", text: value }),
  );
}

function toggleDryWarn(): void {
  if (!dryRunIn || !dryWarn) return;
  dryWarn.hidden = dryRunIn.checked;
  if (saveOk) saveOk.hidden = true;
}

async function save(): Promise<void> {
  if (!bound || !adminIds || !walletIn || !dryRunIn || !watchInterval || !watchJob) return;
  if (saveErr) saveErr.hidden = true;
  if (saveOk) saveOk.hidden = true;

  const ids = adminIds.value
    .split(/[,\s]+/)
    .filter((x) => x.length > 0)
    .map(Number)
    .filter((n) => Number.isFinite(n));

  const body = {
    bound_user_id: Number(bound.value),
    admin_ids: ids,
    withdraw_wallet: walletIn.value.trim(),
    withdraw_dry_run: dryRunIn.checked,
    watch_interval_seconds: Number(watchInterval.value),
    watch_job: watchJob.value.trim(),
  };

  if (body.watch_interval_seconds < MIN_WATCH_SECONDS) {
    if (saveErr) {
      saveErr.textContent = `Watch interval must be at least ${MIN_WATCH_SECONDS} seconds — every provider poll sends three automated messages.`;
      saveErr.hidden = false;
    }
    return;
  }

  try {
    s = await put<Settings>("/api/settings", body);
    paint();
    if (saveOk) saveOk.hidden = false;
  } catch (e) {
    if (saveErr) {
      saveErr.textContent = e instanceof Error ? e.message : String(e);
      saveErr.hidden = false;
    }
  }
}

export const settings: Page = {
  async mount(el) {
    view = el;
    s = await get<Settings>("/api/settings");
    paint();
  },
  dispose() {
    view = null;
    s = null;
    bound = null;
    adminIds = null;
    walletIn = null;
    dryRunIn = null;
    watchInterval = null;
    watchJob = null;
    dryWarn = null;
    saveErr = null;
    saveOk = null;
  },
};
