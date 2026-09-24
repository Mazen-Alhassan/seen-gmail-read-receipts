import { DEFAULT_SERVER_URL, decodeConnectionCode, type NotifyMode } from "../lib/config";
import { send, type State } from "../lib/protocol";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const connectCard = $("connect-card");
const connectedCard = $("connected-card");
const form = $<HTMLFormElement>("connect-form");
const server = $<HTMLInputElement>("server");
const invite = $<HTMLInputElement>("invite");
const connectBtn = $<HTMLButtonElement>("connect");
const connectError = $("connect-error");
const trackByDefault = $<HTMLInputElement>("trackByDefault");
const notify = $<HTMLSelectElement>("notify");
const inGmailToasts = $<HTMLInputElement>("inGmailToasts");

async function refresh(): Promise<void> {
  const state: State = await send({ type: "state" });
  connectCard.hidden = state.connected;
  connectedCard.hidden = !state.connected;
  $("auth-lost").hidden = state.problem !== "auth";
  if (state.connected) {
    $("server-host").textContent = state.serverHost ?? "";
    $("pending").textContent = state.pending ? `${state.pending} update(s) waiting to sync` : "";
  } else if (!server.value && DEFAULT_SERVER_URL) {
    server.value = DEFAULT_SERVER_URL;
  }
  trackByDefault.checked = state.prefs.trackByDefault;
  notify.value = state.prefs.notify;
  inGmailToasts.checked = state.prefs.inGmailToasts;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  connectError.textContent = "";
  connectBtn.disabled = true;
  connectBtn.textContent = "Connecting…";
  try {
    const res = await send({ type: "connect", serverUrl: server.value, inviteCode: invite.value });
    if (!res.ok) connectError.textContent = res.error;
    else invite.value = "";
  } catch (err) {
    connectError.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    connectBtn.disabled = false;
    connectBtn.textContent = "Connect";
    await refresh();
  }
});

$("disconnect").addEventListener("click", async () => {
  await send({ type: "disconnect", deleteData: false });
  await refresh();
});

$("delete").addEventListener("click", async () => {
  const sure = window.confirm(
    "Delete every tracked email and its open history from your server? This can't be undone.\n\nAny other browser connected to this account will stop tracking too.",
  );
  if (!sure) return;
  $("disconnect-error").textContent = "";
  const res = await send({ type: "disconnect", deleteData: true });
  if (!res.ok) $("disconnect-error").textContent = res.error;
  await refresh();
});

const linkCode = $<HTMLInputElement>("link-code");
const linkBtn = $<HTMLButtonElement>("link");
const linkError = $("link-error");
linkBtn.addEventListener("click", async () => {
  linkError.textContent = "";
  linkBtn.disabled = true;
  linkBtn.textContent = "Connecting…";
  // A connection code decides where your emails' subjects and recipients get sent: show it first.
  const decoded = decodeConnectionCode(linkCode.value);
  if (decoded && !window.confirm(`Connect this browser to the Seen server at ${new URL(decoded.serverUrl).host}?`)) {
    linkBtn.disabled = false;
    linkBtn.textContent = "Connect with code";
    return;
  }
  try {
    const res = await send({ type: "importConnection", code: linkCode.value });
    if (!res.ok) linkError.textContent = res.error;
    else linkCode.value = "";
  } catch (err) {
    linkError.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    linkBtn.disabled = false;
    linkBtn.textContent = "Connect with code";
    await refresh();
  }
});

const copyBtn = $<HTMLButtonElement>("copy-code");
copyBtn.addEventListener("click", async () => {
  try {
    const { code } = await send({ type: "exportConnection" });
    await navigator.clipboard.writeText(code);
    copyBtn.textContent = "Copied ✓";
  } catch {
    copyBtn.textContent = "Couldn't copy";
  }
  setTimeout(() => (copyBtn.textContent = "Copy connection code"), 2_500);
});

trackByDefault.addEventListener("change", () => void send({ type: "setPrefs", prefs: { trackByDefault: trackByDefault.checked } }));
notify.addEventListener("change", () => void send({ type: "setPrefs", prefs: { notify: notify.value as NotifyMode } }));
inGmailToasts.addEventListener("change", () => void send({ type: "setPrefs", prefs: { inGmailToasts: inGmailToasts.checked } }));

void refresh();
