// Preload for the --domain tests: sockets stay dead (killnet), and fetch is a
// stub that serves TB_SITE_JSON as tollbooth-site.json. Each call is logged
// to stderr so tests can see exactly what was fetched, and how.
import "./killnet.mjs";

globalThis.fetch = async (url, init) => {
  console.error(`fetch: ${url} redirect=${init?.redirect}`);
  return new Response(process.env.TB_SITE_JSON ?? "", {
    status: Number(process.env.TB_SITE_STATUS ?? 200),
  });
};
