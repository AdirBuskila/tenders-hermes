/**
 * Dump the production site configs to JSON so the JS harness can probe every
 * site with its *real* URL and selectors.
 *
 * Hand-copying URLs out of 24 TypeScript files is how you end up diagnosing a
 * site against a stale URL and concluding it is broken. Read the source of
 * truth instead — it is mounted read-only, and this only reads it.
 *
 * Runs on the Windows host, not in the container: the repo's node_modules were
 * installed on Windows, so esbuild (which tsx needs) is a win32 binary and
 * cannot execute under Linux. The probe itself still runs in the container —
 * only this config dump is host-side, and it touches nothing but the configs.
 *
 *   cd tenders-search-automation
 *   npx tsx ../tenders-hermes/harness/dump-configs.ts > ../tenders-hermes/state/configs.json
 *
 * Override the location with CONFIGS_PATH if the repo lives elsewhere.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const target =
  process.env.CONFIGS_PATH ??
  resolve(process.cwd(), 'src/lib/scraper/configs/index.ts');

// Wrapped in main() rather than using top-level await: this file lives outside
// the repo, so tsx transforms it as CJS and top-level await is a build error.
async function main() {
  // Dynamic import via a file:// URL: a bare Windows path like C:\... is parsed
  // as a URL scheme by the ESM loader and fails.
  const { configs } = await import(pathToFileURL(target).href);

  const dumped = configs.map((c: any) => ({
    site: c.site,
    url: c.url,
    fetcher: c.fetcher ?? 'static',
    row: c.selectors?.row ?? 'tr',
    selectors: Object.fromEntries(
      Object.entries(c.selectors ?? {}).filter(([k]) => k !== 'row'),
    ),
  }));

  console.log(JSON.stringify(dumped, null, 2));
}

main().catch((err) => {
  console.error(`dump-configs failed: ${err?.message ?? err}`);
  process.exit(1);
});
