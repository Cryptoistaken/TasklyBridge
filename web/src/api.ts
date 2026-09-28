// Typed client for the admin API. Every type mirrors docs/api.md exactly.
// Nothing here invents a field the contract has not agreed on.

export type AccountState = "free" | "connected" | "degraded" | "banned" | "dead";

export interface Account {
  id: string;
  phone: string;
  state: AccountState;
  balance: number;
  assigned_user_id?: number | null;
  assigned_user_name?: string;
  messages_sent: number;
  flood_wait_seconds: number;
  last_seen: string;
  note: string;
}

export type UserStatus = "waiting" | "joined" | "stopped";

export interface User {
  id: number;
  name: string;
  username: string;
  status: UserStatus;
  account_id?: string;
  task_name?: string;
  messages: number;
  joined_at: string;
  last_seen: string;
}

export interface Task {
  id: string;
  require_all: string[];
  name: string;
  sell_bdt: number;
  enabled: boolean;
  available: boolean;
  provider_name: string;
  provider_price: number;
  margin_bdt: number;
  hidden: string[];
}

// A stored Telegram session. `bytes` is the size of the credential blob;
// the blob itself is never returned by the API, so it is never rendered.
export interface Session {
  id: string;
  phone: string;
  state: string;
  bytes: number;
  updated_at: string;
  in_use: boolean;
  // Last figure read from the provider. `balance_known` is false when the
  // balance is zero, because a zero is ambiguous: empty, or never read.
  balance: number;
  balance_known: boolean;
}

/** GET /api/sessions carries the count and total so no page recomputes them. */
export interface SessionList extends List<Session> {
  total_balance: number;
  balance_known: boolean;
}

/** POST /api/sessions answers one of three shapes; which fields are set says which. */
export interface SessionCreate {
  ok?: true;
  bytes?: number;
  phone?: string;
  attempt?: string;
  step?: "code" | "password";
  needs_password?: boolean;
  note?: string;
}

/** DELETE /api/sessions/{id}: the row is gone and the service needs a new session. */
export interface SessionDelete {
  ok: true;
  note: string;
}

export type Leg = "user->bot" | "bot->user" | "bot->taskly" | "taskly->bot" | "internal";

export interface Message {
  id: string;
  account_id: string;
  user_id: number;
  leg: Leg;
  direction: "in" | "out";
  text: string;
  buttons?: string[];
  at: string;
}

export type AlertLevel = "info" | "warning" | "critical";
export type AlertKind = "price" | "appeared" | "gone" | "unavailable" | "available" | "loss";

export interface Alert {
  id: string;
  level: AlertLevel;
  kind: AlertKind;
  job: string;
  message: string;
  read: boolean;
  at: string;
}

export type WithdrawalStatus = "created" | "failed";

export interface Withdrawal {
  id: string;
  account_id: string;
  wallet: string;
  amount: number;
  fee: number;
  net: number;
  dry_run: boolean;
  status: WithdrawalStatus;
  confirmation: string;
  at: string;
}

export interface Terms {
  fee: number;
  minimum: number;
  method: string;
  network: string;
  source: string;
}

export interface Preview {
  dry_run: boolean;
  fee: number;
  minimum: number;
  net: number;
  fee_heavy: boolean;
  balance: number;
  warnings: string[];
}

export interface Settings {
  bound_user_id: number;
  admin_ids: number[];
  withdraw_wallet: string;
  withdraw_dry_run: boolean;
  watch_interval_seconds: number;
  watch_job: string;
  catalog_path: string;
  audit_retained_days: number;
}

export interface OverviewAccounts {
  total: number;
  connected: number;
  degraded: number;
  banned: number;
  dead: number;
}

export interface OverviewUsers {
  total: number;
  joined: number;
  waiting: number;
}

export interface OverviewTask {
  available: boolean;
  name: string;
  sell_bdt: number;
  provider_cost: number;
  margin_bdt: number;
  selling_at_loss: boolean;
}

export interface Overview {
  accounts: OverviewAccounts;
  users: OverviewUsers;
  task: OverviewTask;
  balance_total: number;
  alerts_unread: number;
  withdraw_dry_run: boolean;
  last_checked: string;
}

export interface List<T> {
  items: T[];
  total: number;
}

export interface TaskList extends List<Task> {
  bdt_rate: number;
}

// SSE payloads, /api/events. Each is a partial record: the contract shows a
// subset of fields per event, so the dashboard fills the rest at render time.
export type SseMessage = Partial<Message> & Pick<Message, "account_id" | "leg" | "text" | "at">;
export type SseAccount = Partial<Account> & Pick<Account, "id" | "state">;
export type SseAlert = Partial<Alert> & Pick<Alert, "level" | "kind" | "message">;
export type SseWithdrawal = Partial<Withdrawal> & Pick<Withdrawal, "id" | "status">;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let onUnauthorized: (() => void) | null = null;

/** Called whenever any /api request answers 401, so one place owns the login swap. */
export function setUnauthorized(fn: () => void): void {
  onUnauthorized = fn;
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Explicit rather than relying on the same-origin default: every
      // authenticated call depends on the session cookie, and being implicit
      // about it is how it silently goes missing.
      credentials: "include",
    });
  } catch {
    throw new ApiError("Cannot reach the server. Is the Go backend running?", 0);
  }

  // 401 means exactly one thing in this API: not authenticated. A rejected
  // login code or 2FA password is 403 (docs/api.md), so this never fires for
  // those and there is no opt-out to remember.
  if (res.status === 401) {
    onUnauthorized?.();
    throw new ApiError("unauthorized", 401);
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const e = data && typeof data === "object" ? (data as { error?: string; field?: string }) : null;
    throw new ApiError(e?.error ?? `${method} ${path} failed with ${res.status}`, res.status, e?.field);
  }
  return data as T;
}

export const get = <T>(path: string): Promise<T> => api<T>("GET", path);
export const post = <T>(path: string, body?: unknown): Promise<T> => api<T>("POST", path, body);
export const put = <T>(path: string, body: unknown): Promise<T> => api<T>("PUT", path, body);

// The boot request doubles as the auth probe. Handing its result to the
// Overview page saves one round trip on every page load.
let pendingOverview: Overview | null = null;
export function stashOverview(o: Overview): void {
  pendingOverview = o;
}
export function takeOverview(): Overview | null {
  const o = pendingOverview;
  pendingOverview = null;
  return o;
}
