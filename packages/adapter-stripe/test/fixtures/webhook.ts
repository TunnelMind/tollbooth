// Shared Stripe webhook fixtures: signing mocked events the way Stripe does.
// Used by the adapter suite and the hono US-3 integration.

const encoder = new TextEncoder();

export async function stripeSign(
  payload: string,
  secret: string,
  t: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${t}.${payload}`)),
  );
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${t},v1=${hex}`;
}

export function checkoutEvent(
  sessionId: string,
  agentPubkey: string | null,
): string {
  return JSON.stringify({
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        custom_fields:
          agentPubkey === null
            ? []
            : [
                {
                  key: "agent_pubkey",
                  type: "text",
                  text: { value: agentPubkey },
                },
              ],
      },
    },
  });
}

export function extractVoucher(page: string): string {
  const match = /<code id="voucher">([^<]+)<\/code>/.exec(page);
  if (!match?.[1]) throw new Error("no voucher in page");
  return match[1];
}
