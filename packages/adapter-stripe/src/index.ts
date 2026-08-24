// @tollbooth/adapter-stripe: webhook handling and voucher minting, mounted on
// the operator's own app with the operator's own keys - we host nothing
// (Article I.3). No Stripe SDK: webhook signatures are HMAC-SHA256 over
// `t.payload`, done with WebCrypto, so the adapter stays platform-free.
//
// Delivery per D-8: the webhook's OWN response goes to Stripe's servers and
// reaches no buyer, so the voucher is minted into a TTL'd in-memory session
// map and the Payment Link's success URL points at the redemption route,
// which renders it exactly once. Expired unredeemed -> the buyer contacts the
// operator, who re-mints (`cli voucher mint`); Stripe is the record of
// purchase. No customer table, ever (Article I.2).
import { mintVoucher, type TollboothConfig } from "@tollbooth/core";

const encoder = new TextEncoder();

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex))
    throw new Error("bad hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Stripe-Signature verification: HMAC-SHA256 of `${t}.${payload}` with the
 * operator's whsec, any v1 entry may match, timestamp within tolerance.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | undefined,
  secret: string,
  opts: { nowS: number; toleranceS?: number },
): Promise<boolean> {
  if (header === undefined) return false;
  let t = Number.NaN;
  const v1s: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") t = Number(value);
    else if (key === "v1") v1s.push(value);
  }
  if (!Number.isFinite(t) || v1s.length === 0) return false;
  if (Math.abs(opts.nowS - t) > (opts.toleranceS ?? 300)) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const data = encoder.encode(`${t}.${payload}`);
  for (const v1 of v1s) {
    try {
      if (await crypto.subtle.verify("HMAC", key, hexToBytes(v1), data))
        return true;
    } catch {
      // malformed hex entry: try the next one
    }
  }
  return false;
}

/** TTL'd, size-capped session -> voucher map. Read is destructive: render once. */
class SessionVoucherStore {
  private readonly map = new Map<
    string,
    { voucher: string; expiresAtMs: number }
  >();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 10_000,
  ) {}

  put(sessionId: string, voucher: string, nowMs: number): void {
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(sessionId, { voucher, expiresAtMs: nowMs + this.ttlMs });
  }

  take(sessionId: string, nowMs: number): string | undefined {
    const entry = this.map.get(sessionId);
    if (!entry) return undefined;
    this.map.delete(sessionId);
    return entry.expiresAtMs >= nowMs ? entry.voucher : undefined;
  }
}

interface CheckoutSession {
  id?: string;
  custom_fields?: Array<{ key?: string; text?: { value?: string | null } }>;
}

const PAGE_FOUND = (voucher: string) => `<!doctype html>
<title>Your tollbooth voucher</title>
<h1>Voucher &mdash; shown once</h1>
<p>Send this on every request in the <code>Tollbooth-Voucher</code> header.
It is stored nowhere else; save it now.</p>
<p><code id="voucher">${voucher}</code></p>`;

const PAGE_GONE = `<!doctype html>
<title>No voucher here</title>
<h1>No voucher here</h1>
<p>This link has expired or was already used. Your Stripe receipt is the
record of purchase &mdash; contact the site operator to re-mint.</p>`;

export interface StripeAdapter {
  /** POST handler for the webhook route. Verify against the RAW request body. */
  handleWebhook(
    rawBody: string,
    stripeSignature: string | undefined,
  ): Promise<{ status: number; body: string }>;
  /** GET handler for /_tollbooth/voucher/{CHECKOUT_SESSION_ID}. */
  redeem(sessionId: string): {
    status: number;
    body: string;
    contentType: "text/html";
  };
}

export function makeStripeAdapter(deps: {
  cfg: TollboothConfig;
  siteSecret: Uint8Array;
  nowS?: () => number;
}): StripeAdapter {
  const { cfg, siteSecret } = deps;
  const nowS = () => deps.nowS?.() ?? Math.floor(Date.now() / 1000);
  const store = new SessionVoucherStore(cfg.toll.stripe.redeem_ttl);

  return {
    async handleWebhook(rawBody, stripeSignature) {
      const valid = await verifyStripeSignature(
        rawBody,
        stripeSignature,
        cfg.toll.stripe.webhook_secret,
        {
          nowS: nowS(),
        },
      );
      if (!valid)
        return {
          status: 400,
          body: JSON.stringify({ error: "bad signature" }),
        };

      let event: { type?: string; data?: { object?: CheckoutSession } };
      try {
        event = JSON.parse(rawBody) as typeof event;
      } catch {
        return { status: 400, body: JSON.stringify({ error: "bad payload" }) };
      }
      const session = event.data?.object;
      if (
        event.type !== "checkout.session.completed" ||
        typeof session?.id !== "string"
      )
        return {
          status: 200,
          body: JSON.stringify({ received: true, minted: false }),
        };

      const agentKey =
        session.custom_fields?.find((f) => f?.key === "agent_pubkey")?.text
          ?.value ?? null;
      // A missing pubkey mints nothing unless bearer mode is on - but always
      // ack with 200: Stripe retrying forever cannot fix a buyer's typo, and
      // the operator can re-mint from the Stripe record.
      if (agentKey === null && !cfg.toll.stripe.bearer)
        return {
          status: 200,
          body: JSON.stringify({ received: true, minted: false }),
        };

      const now = nowS();
      const voucher = await mintVoucher(
        {
          agentKey,
          credits: cfg.toll.stripe.credits_per_purchase,
          expiresS: now + Math.floor(cfg.toll.stripe.voucher_ttl / 1000),
          nowS: now,
        },
        siteSecret,
      );
      store.put(session.id, voucher, now * 1000);
      return {
        status: 200,
        body: JSON.stringify({ received: true, minted: true }),
      };
    },

    redeem(sessionId) {
      const voucher = store.take(sessionId, nowS() * 1000);
      return voucher === undefined
        ? { status: 404, body: PAGE_GONE, contentType: "text/html" }
        : { status: 200, body: PAGE_FOUND(voucher), contentType: "text/html" };
    },
  };
}
