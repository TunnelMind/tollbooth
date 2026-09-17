/**
 * Configuration errors are NOT fail-open.
 *
 * The middleware fails open on runtime errors (ADR-004: a thrown error serves
 * the site untolled). A missing outbound route is different: it is a
 * deployment mistake, and on 2026-09-14/15 the old behaviour — silently
 * falling back to global fetch — posted five real signed snapshots from a
 * test suite into the production Conduct Log Commons. So when a binding is
 * named and absent, or outbound reporting is configured with no route at
 * all, construction throws this named error before any request is issued,
 * and the middleware rethrows it instead of serving the site untolled.
 * A red suite is the point.
 */
export class TollboothBindingMissingError extends Error {
  override readonly name = "TollboothBindingMissingError";
  readonly binding: string | null;
  readonly presentKeys: string[];

  constructor(binding: string | null, presentKeys: string[]) {
    super(
      binding === null
        ? "tollbooth: outbound reporting is configured but no `binding` and no `fetch` was given — " +
            'there is no implicit global fetch. Pass `binding: "<service binding name>"` (Cloudflare) ' +
            "or `fetch` (an explicit fetcher, e.g. a recording stub in tests)."
        : `tollbooth: binding "${binding}" is not present in env or has no fetch(). ` +
            `Present env keys: [${presentKeys.join(", ")}]. There is no implicit global fetch — ` +
            `bind the service (wrangler.toml [[services]]) or stub it in tests.`,
    );
    this.binding = binding;
    this.presentKeys = presentKeys;
  }
}
