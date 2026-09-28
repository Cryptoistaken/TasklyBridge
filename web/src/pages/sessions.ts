// Sessions — the stored Telegram sessions, and the three-step sign-in that
// replaced the old file upload: phone number, login code, 2FA password.
//
// The code and the password are read from the input, sent to
// POST /api/sessions and cleared on submit. They are never held in module
// state, never put in a URL or storage, and never rendered back. Only the
// attempt id is held, in memory, because it has to survive the re-render
// between steps.

import { ApiError, api, get, takeOverview, type Session, type SessionCreate, type SessionDelete, type SessionList } from "../api";
import {
  chip,
  dot,
  emptyRow,
  errorMessage,
  field,
  h,
  pageHead,
  section,
  statRow,
  subRow,
  table,
  td,
  usd,
  when,
  wrapTable,
  type Page,
} from "../ui";

const COLUMNS = 7;
// Deleting logs the account out, so the second click has to be a deliberate
// one: a fast double-click lands inside this window and does nothing.
const ARM_DELAY = 750;

type Step = "phone" | "code" | "password" | "done";

const STEP: Record<Step, { title: string; field: string; action: string }> = {
  phone: { title: "Step 1 of 3 · phone number", field: "Phone number (international)", action: "Send the code" },
  code: { title: "Step 2 of 3 · login code", field: "Login code", action: "Submit the code" },
  password: { title: "Step 3 of 3 · 2FA password", field: "2FA password", action: "Submit the password" },
  done: { title: "Done", field: "", action: "" },
};

// --- state ------------------------------------------------------------------

let statsSlot: HTMLElement | null = null;
let formSlot: HTMLElement | null = null;
let listSlot: HTMLElement | null = null;
let flashSlot: HTMLElement | null = null;
let errSlot: HTMLElement | null = null;
let input: HTMLInputElement | null = null;
let btn: HTMLButtonElement | null = null;

let items: Session[] = [];
// The server's own total, rendered as sent. A total built on an unread
// balance is never presented as complete.
let totalBalance = 0;
let balanceKnown = true;

// Delete: the first click arms a row, the second confirms it. Held here, in
// memory only, like everything else on this page.
let armed: string | null = null;
let armedAt = 0;
let deleting = false;
let flash = "";
let flashBad = false;

// The create flow. The attempt id lives here and nowhere else — not in the
// DOM, not in the URL, not in localStorage — so a re-render cannot lose it
// and nothing persistent ever holds it.
let step: Step = "phone";
let attempt: string | null = null;
let phone = "";
let note = "";
let err = "";
let limited = false;
let busy = false;

// --- list -------------------------------------------------------------------

function fmtBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

function stateChip(s: Session): HTMLElement {
  const tone = s.state === "banned" || s.state === "dead" ? "bad" : s.state === "degraded" ? "muted" : "ok";
  return h("span", { class: "chip " + (tone === "ok" ? "" : tone) }, dot(tone), s.state);
}

/** An unknown balance is "unread", never a confident $0.0000. */
function balanceCell(s: Session): HTMLElement {
  return s.balance_known ? h("span", { class: "mono" }, usd(s.balance)) : h("span", { class: "mono muted" }, "unread");
}

function deleteWarning(s: Session): string {
  const cost =
    "The account will have to be signed in again, and the service will need a new session created.";
  const head = s.in_use
    ? "This is the session the service is using right now — deleting it leaves the service with none. "
    : "";
  return `${head}Deleting signs the account out and cannot be undone. ${cost} Click Confirm delete to proceed.`;
}

function row(s: Session): HTMLTableRowElement[] {
  const idle = !s.in_use;
  const thisArmed = armed === s.id;
  const cells = h(
    "tr",
    { "data-id": s.id },
    td(s.phone || "—", "mono nowrap"),
    td(stateChip(s)),
    td(balanceCell(s), "num"),
    td(fmtBytes(s.bytes), "num mono"),
    td(when(s.updated_at), "mono nowrap muted"),
    td(idle ? chip("not in use", "bad") : h("span", { class: "chip" }, dot("ok"), "in use")),
    td(
      h("button", {
        class: "btn danger sm",
        type: "button",
        text: deleting && thisArmed ? "Deleting…" : thisArmed ? "Confirm delete" : "Delete",
        disabled: deleting,
        onclick: () => void remove(s),
      }),
      "nowrap",
    ),
  );
  // Armed wins over the idle note: one row, one message, and the armed one is
  // the message that must not be missed.
  if (thisArmed) return [cells, subRow(COLUMNS, h("span", { class: "warn", text: deleteWarning(s) }))];
  // A stored session the service is not using is a trap, so it says so under
  // the row instead of relying on the chip alone.
  return idle
    ? [cells, subRow(COLUMNS, "Not connected — the service is not using this session, so it is a trap rather than a backup.")]
    : [cells];
}

function renderList(): void {
  if (!listSlot) return;
  listSlot.replaceChildren(
    wrapTable(
      table(
        [
          { label: "Phone" },
          { label: "State" },
          { label: "Balance", num: true },
          { label: "Size", num: true },
          { label: "Updated" },
          { label: "In use" },
          { label: "Action" },
        ],
        items.length
          ? items.flatMap(row)
          : [emptyRow(COLUMNS, "No sessions stored yet — create the first one in the form above.")],
      ),
    ),
  );
}

function renderStats(): void {
  const idle = items.filter((s) => !s.in_use).length;
  statsSlot?.replaceChildren(
    statRow([
      { label: "Stored", value: String(items.length) },
      { label: "In use", value: String(items.length - idle) },
      { label: "Not in use", value: String(idle), bad: idle > 0, sub: "stored, but idle — a trap" },
      {
        label: "Total balance",
        value: usd(totalBalance),
        bad: !balanceKnown,
        sub: balanceKnown ? "as the server reported it" : "incomplete — at least one balance is unread",
      },
    ]),
  );
}

async function refresh(): Promise<void> {
  const list = await get<SessionList>("/api/sessions");
  items = list.items;
  totalBalance = list.total_balance;
  balanceKnown = list.balance_known;
  renderStats();
  renderList();
}

// --- delete -----------------------------------------------------------------

function paintFlash(): void {
  if (!flashSlot) return;
  flashSlot.replaceChildren();
  if (flash) {
    flashSlot.appendChild(h("p", { class: flashBad ? "notice bad" : "notice", style: "margin-bottom:12px", text: flash }));
  }
}

async function remove(s: Session): Promise<void> {
  if (deleting) return;
  if (armed !== s.id) {
    armed = s.id; // first click arms
    armedAt = Date.now();
    renderList();
    return;
  }
  if (Date.now() - armedAt < ARM_DELAY) return; // a double-click is one gesture

  deleting = true;
  renderList();
  const wasInUse = s.in_use;

  let note = "";
  try {
    const r = await api<SessionDelete>("DELETE", "/api/sessions/" + encodeURIComponent(s.id));
    note = r.note;
  } catch (e) {
    deleting = false;
    armed = null;
    flash = errorMessage(e); // 404 comes back as the server's own message
    flashBad = true;
    renderList();
    paintFlash();
    return;
  }

  deleting = false;
  armed = null;
  flash = `Deleted ${s.phone || s.id} — ${note}`;
  flashBad = false;
  if (wasInUse) {
    // The boot-time Overview snapshot predates this delete. Dropping it makes
    // the next visit refetch instead of implying the service is still up.
    takeOverview();
  }
  try {
    await refresh();
  } catch (e) {
    flashBad = true;
    flash += ` · list refresh failed: ${errorMessage(e)}`;
  }
  paintFlash();
}

// --- create form ------------------------------------------------------------

function paintErr(): void {
  if (!errSlot) return;
  errSlot.replaceChildren();
  if (err) errSlot.appendChild(h("p", { class: "notice bad", style: "margin-top:12px", text: err }));
}

function makeInput(s: Exclude<Step, "done">): HTMLInputElement {
  if (s === "code") {
    return h("input", {
      class: "input",
      type: "text",
      inputmode: "numeric",
      autocomplete: "one-time-code",
      maxlength: "8",
      placeholder: "12345",
    });
  }
  if (s === "password") {
    // autocomplete off: the browser must never offer to save this either.
    return h("input", { class: "input", type: "password", autocomplete: "off" });
  }
  return h("input", {
    class: "input",
    type: "tel",
    inputmode: "tel",
    autocomplete: "tel",
    spellcheck: "false",
    placeholder: "+8801XXXXXXXXX",
  });
}

function renderForm(): void {
  if (!formSlot) return;
  busy = false;
  input = null;
  btn = null;
  errSlot = h("div", {});

  if (step === "done") {
    formSlot.replaceChildren(
      h(
        "div",
        { class: "row" },
        chip("created", "ok"),
        h("span", { class: "muted small", text: note || "Session created." }),
      ),
      h(
        "div",
        { class: "row", style: "margin-top:14px" },
        h("button", { class: "btn", type: "button", text: "Create another", onclick: () => restart("") }),
      ),
      errSlot,
    );
    paintErr();
    return;
  }

  const meta = STEP[step];
  const ctl = makeInput(step);
  input = ctl;
  btn = h("button", { class: "btn primary", type: "submit", text: meta.action, disabled: limited });

  const head: Node[] = [h("div", { class: "label", text: meta.title })];
  if (step !== "phone" && phone) {
    head.push(h("p", { class: "mono muted small", style: "margin-top:6px", text: phone }));
  }
  if (step === "code") {
    head.push(h("p", { class: "notice", style: "margin-top:10px", text: note || "The code also arrived in the Telegram app." }));
  }
  if (step === "password") {
    head.push(h("p", { class: "notice", style: "margin-top:10px", text: note || "This account has 2FA." }));
  }

  formSlot.replaceChildren(
    ...head,
    h(
      "form",
      {
        onsubmit: (e: Event) => {
          e.preventDefault();
          void submit();
        },
      },
      h("div", { class: "form-grid", style: "margin-top:14px" }, field(meta.field, ctl)),
      h("div", { class: "row", style: "margin-top:16px" }, btn),
    ),
    errSlot,
  );
  paintErr();
}

/** Back to step 1, dropping the attempt. Used by a 404 and by "Create another". */
function restart(message: string): void {
  attempt = null;
  phone = "";
  note = "";
  limited = false;
  step = "phone";
  err = message;
  renderForm();
}

function invalid(message: string): void {
  err = message;
  paintErr();
}

function restore(): void {
  busy = false;
  if (btn) {
    btn.disabled = limited;
    btn.textContent = STEP[step].action;
  }
}

function fail(e: unknown): void {
  const msg = errorMessage(e);
  if (e instanceof ApiError && e.status === 404) {
    // The attempt expired: clear it and send the admin back to the phone number.
    restart(msg + " Start again from the phone number.");
    return;
  }
  if (e instanceof ApiError && e.status === 403) {
    // 403 is a rejected credential, which the step tells us apart. A 401 would
    // mean the admin session is gone, so the two must never be confused.
    err = (step === "password" ? "2FA password rejected. " : "Login code rejected. ") + msg;
  } else if (e instanceof ApiError && e.status === 429) {
    err = msg;
    limited = true;
  } else {
    err = msg;
  }
  restore();
  paintErr();
}

async function submit(): Promise<void> {
  if (busy || limited || !input || step === "done") return;
  const value = input.value;

  let body: Record<string, string>;
  if (step === "phone") {
    const p = value.trim();
    if (!p) return invalid("Enter the phone number in international form, for example +8801…");
    phone = p;
    body = { phone: p };
  } else if (step === "code") {
    if (!attempt) return restart("That sign-in attempt is gone. Start again from the phone number.");
    const code = value.trim();
    if (!code) return invalid("Enter the login code.");
    body = { attempt, code };
  } else {
    if (!attempt) return restart("That sign-in attempt is gone. Start again from the phone number.");
    if (!value) return invalid("Enter the account's 2FA password.");
    body = { attempt, password: value };
  }

  busy = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Working…";
  }
  err = "";
  paintErr();

  try {
    // A 401 here can only mean the admin session is gone: a rejected code or
    // password is 403 (docs/api.md), so the default 401 handling is correct.
    const r = await api<SessionCreate>("POST", "/api/sessions", body);

    if (r.ok) {
      attempt = null;
      note = r.note || "";
      if (input) input.value = ""; // the code/password does not outlive this submit
      step = "done";
      renderForm();
      await refresh();
      return;
    }

    if (r.attempt && (r.step === "code" || r.step === "password")) {
      attempt = r.attempt;
      note = r.note || "";
      phone = r.phone || phone;
      if (input) input.value = "";
      step = r.step;
      renderForm();
      return;
    }

    // Neither shape: show the payload as it came rather than guessing a step.
    restore();
    invalid(r.note || "The server did not return a step.");
  } catch (e) {
    fail(e);
  }
}

// --- page -------------------------------------------------------------------

export const sessions: Page = {
  async mount(el) {
    statsSlot = h("div", {});
    formSlot = h("div", {});
    listSlot = h("div", {});
    flashSlot = h("div", {});
    el.replaceChildren(
      pageHead("Sessions", "stored Telegram sessions · created here, step by step, no file upload"),
      statsSlot,
      section("Create a session", formSlot),
      section("Stored sessions", flashSlot, listSlot),
    );
    renderForm();
    await refresh();
  },

  dispose() {
    statsSlot = null;
    formSlot = null;
    listSlot = null;
    flashSlot = null;
    errSlot = null;
    input = null;
    btn = null;
    items = [];
    totalBalance = 0;
    balanceKnown = true;
    armed = null;
    armedAt = 0;
    deleting = false;
    flash = "";
    flashBad = false;
    step = "phone";
    attempt = null;
    phone = "";
    note = "";
    err = "";
    limited = false;
    busy = false;
  },
};
