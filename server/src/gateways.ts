/**
 * Recipients behind an email security gateway (Proofpoint, Mimecast, …) often have their mail
 * opened by the gateway itself within moments of delivery. We spot those gateways from the
 * recipient domain's MX records, so early hits for those emails can be discounted.
 */

const GATEWAYS: [RegExp, string][] = [
  [/\.(pphosted|ppe-hosted)\.com$/i, "Proofpoint"],
  [/\.mimecast(-offshore)?\.(com|co\.za)$/i, "Mimecast"],
  [/\.(barracudanetworks\.com|ess\.barracuda\.com)$/i, "Barracuda"],
  [/\.iphmx\.com$/i, "Cisco"],
  [/\.messagelabs\.com$/i, "Symantec"],
  [/\.(trendmicro\.(com|eu)|tmes\.trendmicro\.com)$/i, "Trend Micro"],
  [/\.(sophos\.com|hydra\.sophos\.com)$/i, "Sophos"],
  [/\.fortimail\.com$/i, "Fortinet"],
  [/\.mailcontrol\.com$/i, "Forcepoint"],
  [/\.(hornetsecurity\.com|hornetdrive\.com)$/i, "Hornetsecurity"],
  [/\.(spamtitan\.com|titanhq\.com)$/i, "SpamTitan"],
  [/\.mxrecord\.(io|mx)$/i, "Cloudflare Area 1"],
  [/\.arsmtp\.com$/i, "AppRiver"],
  [/\.antispamcloud\.com$/i, "SpamExperts"],
  [/\.(vadesecure\.com|vade\.com)$/i, "Vade"],
  [/\.libraesva\.com$/i, "Libraesva"],
];

// Big consumer providers never sit behind a third-party gateway; skip the DNS round-trip.
const CONSUMER = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com",
  "ymail.com", "aol.com", "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com",
  "gmx.com", "gmx.de", "web.de", "mail.com", "yandex.ru", "zoho.com", "fastmail.com", "hey.com",
]);

export type MxResolver = (domain: string) => Promise<string[]>;

export function gatewayForHost(host: string): string | null {
  const h = host.replace(/\.$/, "");
  for (const [re, name] of GATEWAYS) if (re.test(h)) return name;
  return null;
}

/**
 * The gateway vendor in front of any of these recipients, or null. Never throws. `complete` is
 * false if a lookup failed, so the caller can try again later instead of trusting a partial answer.
 */
export async function detectGateway(
  emails: string[],
  resolveMx: MxResolver,
): Promise<{ gateway: string | null; complete: boolean }> {
  const domains = [
    ...new Set(
      emails
        .map((e) => e.split("@")[1]?.trim().toLowerCase())
        .filter((d): d is string => !!d && !CONSUMER.has(d)),
    ),
  ].slice(0, 10);
  let complete = true;
  const results = await Promise.all(
    domains.map((d) =>
      resolveMx(d).catch(() => {
        complete = false;
        return [] as string[];
      }),
    ),
  );
  for (const hosts of results) {
    for (const host of hosts) {
      const vendor = gatewayForHost(host);
      if (vendor) return { gateway: vendor, complete: true };
    }
  }
  return { gateway: null, complete };
}

const cache = new Map<string, { hosts: string[]; at: number }>();
const CACHE_MS = 24 * 3600_000;

/** MX lookup over DNS-over-HTTPS (Workers have no raw DNS). */
export const dohResolveMx: MxResolver = async (domain) => {
  const hit = cache.get(domain);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.hosts;
  const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`, {
    headers: { Accept: "application/dns-json" },
    signal: AbortSignal.timeout(2_000),
  });
  if (!res.ok) throw new Error(`DNS lookup failed (${res.status})`);
  const body = (await res.json()) as { Answer?: { type: number; data: string }[] };
  const hosts = (body.Answer ?? [])
    .filter((a) => a.type === 15)
    .map((a) => a.data.split(/\s+/).pop() ?? "")
    .filter(Boolean);
  cache.set(domain, { hosts, at: Date.now() });
  return hosts;
};
