// A single centred card: wordmark, password field, button. Nothing else.

import { h } from "./ui";

export function mountLogin(root: HTMLElement, onOk: () => void): void {
  const input = h("input", { class: "input", type: "password", name: "password", autocomplete: "current-password" });
  const err = h("p", { class: "warn small", role: "alert" });
  err.hidden = true;

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    err.hidden = true;
    const password = input.value;
    if (!password) {
      err.textContent = "Enter the admin password.";
      err.hidden = false;
      return;
    }
    const button = root.querySelector<HTMLButtonElement>("button[type=submit]");
    if (button) button.disabled = true;
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const text = await res.text();
        let msg = "Wrong password.";
        try {
          msg = (JSON.parse(text) as { error?: string }).error ?? msg;
        } catch {
          // non-JSON error body, keep the generic message
        }
        err.textContent = msg;
        err.hidden = false;
        return;
      }
      input.value = "";
      onOk();
    } catch {
      err.textContent = "Cannot reach the server.";
      err.hidden = false;
    } finally {
      if (button) button.disabled = false;
    }
  }

  root.replaceChildren(
    h(
      "div",
      { class: "login" },
      h(
        "form",
        { class: "card login-card", onSubmit: submit },
        h("div", { class: "wordmark" }, "Taskly", h("span", { text: "Bridge" })),
        h("p", { class: "muted small", text: "Admin password" }),
        input,
        err,
        h("button", { class: "btn primary", type: "submit", text: "Sign in" }),
      ),
    ),
  );
  input.focus();
}
