/**
 * Short follow-ups for an email you know was opened.
 *
 * Deliberately casual and low-pressure: someone who opened your email and didn't reply is usually
 * busy, not hostile, and a breezy nudge reads better than a formal one. Each is a few lines at
 * most — a long follow-up to an unanswered email is a worse follow-up.
 *
 * Nothing here is ever sent on your behalf: picking one drops the text into a Gmail reply for you
 * to edit and send yourself.
 */

import type { Recipient } from "../../../shared/api";

export interface FollowUp {
  id: string;
  /** Shown on the button in the popup. */
  title: string;
  /** One line under the title, so you can tell them apart at a glance. */
  hint: string;
  body: (greeting: string) => string;
}

export const FOLLOW_UPS: FollowUp[] = [
  {
    id: "bump",
    title: "Bump it",
    hint: "Shortest and softest — just puts it back on top",
    body: (hi) => `${hi},\n\nJust bumping this to the top of your inbox in case it got buried.\n\nNo rush at all.\n`,
  },
  {
    id: "easy-no",
    title: "Make it easy to say no",
    hint: "Invites a one-word answer, so you stop guessing",
    body: (hi) =>
      `${hi},\n\nChecking back on this one. Even a "not right now" is genuinely helpful — that way I'm not sitting in your inbox.\n\nEither way, thanks for the read.\n`,
  },
  {
    id: "smaller-ask",
    title: "Shrink the ask",
    hint: "Same request, cheaper to say yes to",
    body: (hi) =>
      `${hi},\n\nStill really keen on this. Happy to keep it to 15 minutes, or just do it over email if that's easier for you.\n\nWhatever's least effort on your end.\n`,
  },
  {
    id: "last-one",
    title: "Last one",
    hint: "Closes the loop — often gets the fastest reply",
    body: (hi) =>
      `${hi},\n\nI'll leave it here so I'm not cluttering your inbox. If it's not the right fit or the right time, no hard feelings at all.\n\nIf that changes, you know where to find me.\n`,
  },
];

/**
 * A greeting for the first recipient. Gmail hands us names in several shapes ("Ada Lovelace",
 * "Lovelace, Ada"), and a wrong first name is worse than none, so anything we can't read
 * confidently becomes a plain "Hey".
 */
export function greeting(recipients: Recipient[]): string {
  const name = firstName(recipients[0]);
  return name ? `Hey ${name}` : "Hey";
}

function firstName(recipient: Recipient | undefined): string | null {
  if (!recipient) return null;
  const full = (recipient.name ?? "").trim();
  if (full && !full.includes("@")) {
    // "Lovelace, Ada" — the directory form some companies use.
    const parts = full.includes(",") ? full.split(",")[1] : full.split(/\s+/)[0];
    const candidate = (parts ?? "").trim().split(/\s+/)[0];
    if (isName(candidate)) return capitalize(candidate!);
  }
  const local = (recipient.email ?? "").split("@")[0] ?? "";
  // "ada.lovelace", "ada_lovelace", "ada+jobs" — the first chunk is usually the first name.
  const candidate = local.split(/[.\-_+]/)[0];
  return isName(candidate) ? capitalize(candidate!) : null;
}

/** Only letters, and long enough not to be an initial or a role address like "hr" or "info". */
function isName(value: string | undefined): value is string {
  return !!value && /^[a-zÀ-ɏ]{3,}$/i.test(value) && !GENERIC.has(value.toLowerCase());
}

const GENERIC = new Set([
  "info", "hello", "hey", "team", "jobs", "careers", "hiring", "support", "contact", "admin",
  "sales", "help", "office", "recruiting", "talent", "people", "press", "mail", "inbox", "noreply",
]);

function capitalize(value: string): string {
  return value[0]!.toUpperCase() + value.slice(1).toLowerCase();
}
