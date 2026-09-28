import { useEffect, useState } from "react";
import { ApiError, api, del, get, type Session, type SessionCreate, type SessionDelete, type SessionList } from "@/lib/api";
import { usd, when } from "@/lib/format";
import { invalidateOverview } from "@/lib/bus";
import { PageHeader } from "@/components/PageHeader";
import { StatGrid, StatTile } from "@/components/StatTile";
import { DataTable, Td } from "@/components/DataTable";
import { StatusChip, toneForState } from "@/components/StatusChip";
import { Field, FormCard, Section, inputCls } from "@/components/Field";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

// Sessions — the stored Telegram sessions, and the three-step sign-in that
// replaced the old file upload: phone number, login code, 2FA password.
//
// The code and the password live in the input element only: they are read on
// submit, sent to POST /api/sessions and cleared. They are never held in
// component state, never put in a URL or storage, and never rendered back.
// Only the attempt id is held, in state, because it has to survive the
// re-render between steps.

// Deleting logs the account out, so the second click has to be a deliberate
// one: a fast double-click lands inside this window and does nothing.
const ARM_DELAY = 750;

type Step = "phone" | "code" | "password" | "done";

const STEP: Record<Exclude<Step, "done">, { title: string; field: string; action: string }> = {
  phone: { title: "Step 1 of 3 · phone number", field: "Phone number (international)", action: "Send the code" },
  code: { title: "Step 2 of 3 · login code", field: "Login code", action: "Submit the code" },
  password: { title: "Step 3 of 3 · 2FA password", field: "2FA password", action: "Submit the password" },
};

function fmtBytes(n: number): string {
  // An absent size would fail the < 1024 test, fall through to the division
  // and then throw on toFixed. The blob size is the one field here that is not
  // guaranteed, so it is checked rather than assumed.
  if (typeof n !== "number" || !Number.isFinite(n)) return "unknown";
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

export function SessionsPage(): React.JSX.Element {
  const [items, setItems] = useState<Session[] | null>(null);
  const [totalBalance, setTotalBalance] = useState(0);
  const [balanceKnown, setBalanceKnown] = useState(true);
  const [error, setError] = useState("");

  // Delete: first click arms a row, the second confirms it.
  const [armed, setArmed] = useState<string | null>(null);
  const [armedAt, setArmedAt] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [flash, setFlash] = useState("");
  const [flashBad, setFlashBad] = useState(false);

  // Create flow. The attempt id lives here and nowhere else — not in the DOM,
  // not in the URL, not in localStorage.
  const [step, setStep] = useState<Step>("phone");
  const [attempt, setAttempt] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [formErr, setFormErr] = useState("");
  const [limited, setLimited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [value, setValue] = useState("");
  // newAccount is the account this sign-in is for. Left blank the server uses
  // the default account, which is what an operator adding a second number does
  // NOT want: it would overwrite the session that is already there.
  const [newAccount, setNewAccount] = useState("");

  async function refresh(): Promise<void> {
    const l = await get<SessionList>("/api/sessions");
    setItems(l.items);
    setTotalBalance(l.total_balance);
    setBalanceKnown(l.balance_known);
  }

  useEffect(() => {
    let live = true;
    refresh().catch((e: unknown) => {
      if (live) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function remove(s: Session): Promise<void> {
    if (deleting) return;
    if (armed !== s.id) {
      setArmed(s.id); // first click arms
      setArmedAt(Date.now());
      return;
    }
    if (Date.now() - armedAt < ARM_DELAY) return; // a double-click is one gesture

    setDeleting(true);
    const wasInUse = s.in_use;
    try {
      const r = await del<SessionDelete>("/api/sessions/" + encodeURIComponent(s.id));
      setArmed(null);
      setFlash(`Deleted ${s.phone || s.id} — ${r.note}`);
      setFlashBad(false);
      if (wasInUse) {
        // The in-use session is gone, so the Overview's account count, its
        // balance and its total are all describing something that no longer
        // exists. The list refetch below fixes this page; the Overview holds a
        // separate boot snapshot and needs telling separately, or it keeps
        // showing the deleted account until a full page reload.
        invalidateOverview();
      }
      await refresh();
    } catch (e: unknown) {
      setArmed(null);
      setFlash(e instanceof Error ? e.message : String(e)); // 404 comes back as the server's own message
      setFlashBad(true);
    } finally {
      setDeleting(false);
    }
  }

  function restart(message: string): void {
    setAttempt(null);
    setPhone("");
    setNote("");
    setLimited(false);
    setValue("");
    setStep("phone");
    setFormErr(message);
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy || limited || step === "done") return;

    let body: Record<string, string>;
    if (step === "phone") {
      const p = value.trim();
      if (!p) {
        setFormErr("Enter the phone number in international form, for example +8801…");
        return;
      }
      setPhone(p);
      // The account is named on the first step, and rides with the attempt from
      // then on. Without it every sign-in landed on the one hardcoded account
      // and overwrote the session already there, which is why a second account
      // could not be created at all.
      body = { phone: p, account: newAccount.trim() };
    } else if (step === "code") {
      if (!attempt) {
        restart("That sign-in attempt is gone. Start again from the phone number.");
        return;
      }
      const code = value.trim();
      if (!code) {
        setFormErr("Enter the login code.");
        return;
      }
      body = { attempt, code };
    } else {
      if (!attempt) {
        restart("That sign-in attempt is gone. Start again from the phone number.");
        return;
      }
      if (!value) {
        setFormErr("Enter the account's 2FA password.");
        return;
      }
      body = { attempt, password: value };
    }

    setBusy(true);
    setFormErr("");
    try {
      // A 401 here can only mean the admin session is gone: a rejected code or
      // password is 403 (docs/api.md), so the default 401 handling is correct.
      const r = await api<SessionCreate>("POST", "/api/sessions", body);
      if (r.ok) {
        setAttempt(null);
        setNote(r.note || "");
        setValue(""); // the code/password does not outlive this submit
        setStep("done");
        await refresh();
        return;
      }
      if (r.attempt && (r.step === "code" || r.step === "password")) {
        setAttempt(r.attempt);
        setNote(r.note || "");
        setPhone(r.phone || phone);
        setValue("");
        setStep(r.step);
        return;
      }
      // Neither shape: show the payload as it came rather than guessing a step.
      setFormErr(r.note || "The server did not return a step.");
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 404) {
        // The attempt expired: clear it and send the admin back to the phone number.
        restart(err.message + " Start again from the phone number.");
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        // 403 is a rejected credential, which the step tells us apart. A 401
        // would mean the admin session is gone, so the two must never be confused.
        setFormErr((step === "password" ? "2FA password rejected. " : "Login code rejected. ") + err.message);
      } else if (err instanceof ApiError && err.status === 429) {
        setFormErr(err.message);
        setLimited(true);
      } else {
        setFormErr(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div>
        <PageHeader title="Sessions" />
        <Alert variant="destructive">{error}</Alert>
      </div>
    );
  }

  if (!items) {
    return (
      <div>
        <PageHeader title="Sessions" sub="stored Telegram sessions · created here, step by step, no file upload" />
        <StatGrid>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[118px]" />
          ))}
        </StatGrid>
      </div>
    );
  }

  const idle = items.filter((s) => !s.in_use).length;
  const meta = step === "done" ? null : STEP[step];

  return (
    <div>
      <PageHeader title="Sessions" sub="stored Telegram sessions · created here, step by step, no file upload" />
      <StatGrid>
        <StatTile label="Stored" value={String(items.length)} />
        <StatTile label="In use" value={String(items.length - idle)} />
        <StatTile label="Not in use" value={String(idle)} bad={idle > 0} sub="stored, but idle — a trap" />
        <StatTile
          label="Total balance"
          value={usd(balanceKnown ? totalBalance : null)}
          bad={!balanceKnown}
          sub={balanceKnown ? "as the server reported it" : "incomplete — at least one balance is unread"}
        />
      </StatGrid>

      <Section title="Create a session">
        <FormCard>
          {step === "done" ? (
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <StatusChip text="created" tone="ok" />
                <span className="text-xs text-muted-foreground">{note || "Session created."}</span>
              </div>
              <div className="mt-3.5">
                <Button onClick={() => restart("")}>Create another</Button>
              </div>
            </div>
          ) : (
            meta && (
              <div>
                <div className="text-[11px] tracking-[0.08em] text-muted-foreground uppercase">{meta.title}</div>
                {step !== "phone" && phone ? <p className="mt-1.5 font-mono text-xs text-muted-foreground">{phone}</p> : null}
                {step === "code" ? (
                  <p className="mt-2.5 rounded-[var(--radius)] border border-border bg-background px-3 py-2.5 text-[13px] text-muted-foreground">
                    {note || "The code also arrived in the Telegram app."}
                  </p>
                ) : null}
                {step === "password" ? (
                  <p className="mt-2.5 rounded-[var(--radius)] border border-border bg-background px-3 py-2.5 text-[13px] text-muted-foreground">
                    {note || "This account has 2FA."}
                  </p>
                ) : null}
                <form onSubmit={(e) => void submit(e)}>
                  <div className="mt-3.5 grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-[18px]">
                    <Field label={meta.field}>
                      <input
                        className={inputCls}
                        type={step === "code" ? "text" : step === "password" ? "password" : "tel"}
                        inputMode={step === "code" ? "numeric" : step === "phone" ? "tel" : undefined}
                        autoComplete={step === "code" ? "one-time-code" : step === "password" ? "off" : "tel"}
                        maxLength={step === "code" ? 8 : undefined}
                        placeholder={step === "code" ? "12345" : step === "phone" ? "+8801XXXXXXXXX" : undefined}
                        spellCheck={false}
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        disabled={limited || busy}
                      />
                    </Field>
                    {/* Only on the first step: the account is named once and
                        then carried by the attempt. Blank means the default
                        account, which is what an operator adding a SECOND
                        number must not do, because it would overwrite the
                        session already stored there. */}
                    {step === "phone" ? (
                      <Field
                        label="Account name (optional)"
                        hint="Leave blank for the default account. To add another account, name it so this session is stored separately."
                      >
                        <input
                          className={inputCls}
                          type="text"
                          placeholder="e.g. backup-1"
                          spellCheck={false}
                          value={newAccount}
                          onChange={(e) => setNewAccount(e.target.value)}
                          disabled={limited || busy}
                        />
                      </Field>
                    ) : null}
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <Button type="submit" variant="default" disabled={limited || busy}>
                      {busy ? "Working…" : meta.action}
                    </Button>
                  </div>
                </form>
              </div>
            )
          )}
          {formErr ? (
            <Alert variant="destructive" className="mt-3">
              {formErr}
            </Alert>
          ) : null}
        </FormCard>
      </Section>

      <Section title="Stored sessions">
        {flash ? (
          <Alert variant={flashBad ? "destructive" : "default"} className="mb-3">
            {flash}
          </Alert>
        ) : null}
        <DataTable
          columns={[
            { label: "Phone" },
            { label: "State" },
            { label: "Balance", num: true },
            { label: "Size", num: true },
            { label: "Updated" },
            { label: "In use" },
            { label: "Action" },
          ]}
          empty={items.length === 0 ? "No sessions stored yet — create the first one in the form above." : undefined}
        >
          {items.flatMap((s) => {
            const thisArmed = armed === s.id;
            const main = (
              <tr key={s.id}>
                <Td className="font-mono whitespace-nowrap">{s.phone || "—"}</Td>
                <Td>
                  <StatusChip text={s.state} tone={toneForState(s.state)} />
                </Td>
                <Td num>
                  {s.balance_known ? (
                    <span className="font-mono">{usd(s.balance)}</span>
                  ) : (
                    <span className="font-mono text-muted-foreground">unread</span>
                  )}
                </Td>
                <Td num className="font-mono">
                  {fmtBytes(s.bytes)}
                </Td>
                <Td className="font-mono whitespace-nowrap text-muted-foreground">{when(s.updated_at)}</Td>
                <Td>
                  {s.in_use ? (
                    <StatusChip text="in use" tone="ok" />
                  ) : (
                    <StatusChip text="not in use" tone="bad" />
                  )}
                </Td>
                <Td className="whitespace-nowrap">
                  <Button variant="destructive" size="sm" disabled={deleting} onClick={() => void remove(s)}>
                    {deleting && thisArmed ? "Deleting…" : thisArmed ? "Confirm delete" : "Delete"}
                  </Button>
                </Td>
              </tr>
            );
            // Armed wins over the idle note: one row, one message, and the
            // armed one is the message that must not be missed.
            if (thisArmed) {
              const cost =
                "The account will have to be signed in again, and the service will need a new session created.";
              const head = s.in_use
                ? "This is the session the service is using right now — deleting it leaves the service with none. "
                : "";
              return [
                main,
                <tr key={`${s.id}-warn`}>
                  <Td colSpan={7} className="bg-background pt-0 pb-3 text-xs text-destructive">
                    {`${head}Deleting signs the account out and cannot be undone. ${cost} Click Confirm delete to proceed.`}
                  </Td>
                </tr>,
              ];
            }
            // A stored session the service is not using is a trap, so it says
            // so under the row instead of relying on the chip alone.
            return s.in_use
              ? [main]
              : [
                  main,
                  <tr key={`${s.id}-idle`}>
                    <Td colSpan={7} className="bg-background pt-0 pb-3 text-xs text-muted-foreground">
                      Not connected — the service is not using this session, so it is a trap rather than a backup.
                    </Td>
                  </tr>,
                ];
          })}
        </DataTable>
      </Section>
    </div>
  );
}
