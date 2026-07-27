/**
 * Run the production scrapers locally and emit tenders as JSON. No database.
 *
 * WHY. The agent's data access was designed to read the production Supabase
 * table, but the anon key returns 200-with-zero-rows (RLS enabled, no policy),
 * and the project belongs to the client. Waiting on that blocks everything.
 *
 * This routes around it entirely by calling the production engine's own
 * `runAdapter` — the exact function the nightly job calls — and stopping before
 * the database. Same configs, same fetchers, same mappers, same tender objects.
 * It also runs `applyKeywordFilter`, which is production's *current* relevance
 * verdict, so the agent's criteria can be compared against the live rules
 * without reading the live table.
 *
 * Strictly read-only with respect to the client's systems: it reads /repo, hits
 * the same public portals the scraper already hits, and writes only to stdout.
 *
 * Runs inside the container, which is the point — the whole pipeline must be
 * deployable to a Linux VPS with no host-side steps:
 *
 *   docker run --rm -v <repo>:/repo:ro -v <workspace>:/workspace -w /workspace \
 *     -e REPO_PATH=/repo tenders-agent:1.0 \
 *     node_modules/.bin/tsx harness/scrape-local.ts --open-only --out state/tenders-local.json
 *
 * tsx is resolved from /workspace/node_modules, not /repo's: the production
 * repo's node_modules is installed on whatever machine develops it (win32
 * esbuild here), and esbuild ships a platform-specific native binary that will
 * not run under Linux. cheerio and playwright still resolve from /repo so the
 * versions match production exactly.
 *
 * Also runs on a host with `npx tsx` if REPO_PATH points at the repo.
 *
 *   --sites a,b,c   only these sites
 *   --open-only     drop tenders whose status is not 'open'
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
}
const has = (name: string) => process.argv.includes(`--${name}`);

const REPO = process.env.REPO_PATH ?? process.cwd();
const load = (rel: string) => import(pathToFileURL(resolve(REPO, rel)).href);

async function main() {
  const { configs } = await load('src/lib/scraper/configs/index.ts');
  const { runAdapter } = await load('src/lib/scraper/engine.ts');
  const { applyKeywordFilter } = await load('src/lib/relevance.ts');

  const only = arg('sites');
  const selected = only
    ? configs.filter((c: any) => only.split(',').map((s) => s.trim()).includes(c.site))
    : configs;

  if (!selected.length) {
    console.error(`[scrape-local] no sites matched --sites ${only}`);
    process.exit(1);
  }

  console.error(`[scrape-local] running ${selected.length} adapters`);
  const started = Date.now();

  // Promise.allSettled, exactly as scrape.ts does: one dead portal must not
  // abort the other 33. A rejected adapter is a reported failure, not a crash.
  const results = await Promise.allSettled(selected.map((c: any) => runAdapter(c)));

  const tenders: any[] = [];
  const failures: Array<{ site: string; error: string }> = [];

  results.forEach((r, i) => {
    const site = selected[i].site;
    if (r.status === 'fulfilled') {
      console.error(`  ✓ ${site.padEnd(16)} ${r.value.length}`);
      tenders.push(...r.value);
    } else {
      const error = r.reason?.message ?? String(r.reason);
      console.error(`  ✗ ${site.padEnd(16)} ${error.slice(0, 70)}`);
      failures.push({ site, error });
    }
  });

  const openOnly = has('open-only');
  const filtered = openOnly ? tenders.filter((t) => t.status === 'open') : tenders;

  // Production's live verdict, for shadow comparison. Recorded under a distinct
  // key so it can never be confused with the agent's own classification.
  const scored = applyKeywordFilter(filtered).map((t: any) => ({
    ...t,
    production_relevant: t.relevant ?? false,
    production_reason: t.relevance_reason ?? null,
  }));

  const payload = {
    ok: true,
    source: 'scrape-local',
    sitesRun: selected.length,
    sitesFailed: failures.length,
    failures,
    total: tenders.length,
    afterStatusFilter: filtered.length,
    productionRelevant: scored.filter((t: any) => t.production_relevant).length,
    elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    tenders: scored,
  };

  const out = arg('out');
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');
    console.error(`[scrape-local] wrote ${out}`);
  } else {
    console.log(JSON.stringify(payload, null, 2));
  }

  console.error(
    `[scrape-local] ${payload.total} tenders from ${selected.length - failures.length}/${selected.length} sites, ` +
      `${payload.productionRelevant} flagged relevant by production rules, ${payload.elapsedSeconds}s`,
  );
}

main().catch((err) => {
  console.error(`[scrape-local] failed: ${err?.stack ?? err}`);
  process.exit(1);
});
