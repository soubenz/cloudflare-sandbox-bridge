import { parseOnboarding, type Onboarding } from './learn';

/**
 * The platform onboarding quiz lives in packages/catalogue/onboarding.json,
 * which the Worker bundles. The file is optional: a checkout without it must
 * still build, type-check and run, and `GET /learn/onboarding` then answers
 * 404. A static `import ... from '...onboarding.json'` cannot do that (a
 * missing file fails the build), so the file is pulled in with a glob-style
 * dynamic import. esbuild (wrangler) resolves it at build time to whichever
 * files match, and to an empty set, with an `empty-glob` warning, when there
 * is no file; Vite (vitest) does the same at run time. Either way a missing
 * file rejects the import, which is read here as "no quiz".
 */
export type OnboardingLoader = () => Promise<unknown>;

/** Messages the bundler / test runner produce for "that file is not there". Anything else is a real failure and is rethrown. */
const ABSENT = /Unknown variable dynamic import|Module not found in bundle|Failed to load url|Cannot find module|does not exist/i;

const defaultLoader: OnboardingLoader = async () => {
  const variant = ''; // keeps the specifier dynamic, so the file stays optional
  const mod = await import(`../../packages/catalogue/onboarding${variant}.json`);
  return (mod as { default: unknown }).default;
};

let cached: Onboarding | null | undefined;

/**
 * The parsed onboarding quiz, or null when the file is absent. A file that is
 * present but invalid throws (a publish-time defect, so it is a 500 rather
 * than a quiz that silently disappears). The default loader's result is
 * cached for the life of the isolate: the file is baked into the bundle.
 */
export async function loadOnboarding(loader?: OnboardingLoader): Promise<Onboarding | null> {
  if (loader === undefined && cached !== undefined) return cached;
  let raw: unknown;
  try {
    raw = await (loader ?? defaultLoader)();
  } catch (err) {
    if (!ABSENT.test(err instanceof Error ? err.message : String(err))) throw err;
    if (loader === undefined) cached = null;
    return null;
  }
  const parsed = parseOnboarding(raw);
  if (loader === undefined) cached = parsed;
  return parsed;
}
