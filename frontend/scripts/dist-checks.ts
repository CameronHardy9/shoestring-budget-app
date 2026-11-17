// Pure checks on the built dist/ (run by check-dist.ts after every build,
// unit-tested with fixtures in dist-checks.test.ts).
import { BOOT_ALLOWED_SOURCES } from "./boot-script.ts";

export interface DistReader {
  /** Text of a file under dist/ ("assets/x.js"), or null if missing. */
  read(path: string): string | null;
}

const SCRIPT_TAG = /<script\b([^>]*)>/gi;
const SRC_ATTR = /\bsrc=["']?([^"'\s>]*)/i;

/** `src` of every <script> in document order (null for inline ones). */
export function scriptsInOrder(
  html: string,
): { src: string | null; attrs: string }[] {
  return [...html.matchAll(SCRIPT_TAG)].map((m) => {
    const attrs = m[1] ?? "";
    return { src: SRC_ATTR.exec(attrs)?.[1] ?? null, attrs };
  });
}

/** Static or dynamic imports in a built chunk (ES module syntax, minified). */
export function hasImports(js: string): boolean {
  return /\bimport\s*[("'{*]|\bimport\s+[\w$]+\s+from|\bfrom\s*["']/.test(js);
}

/** Source paths of a hidden source map, normalised to "src/…". */
export function mapSources(map: string): string[] {
  const parsed = JSON.parse(map) as { sources?: unknown };
  const sources = Array.isArray(parsed.sources) ? parsed.sources : [];
  return sources.map((s) => String(s).replace(/^(\.\.\/)+/, ""));
}

/**
 * F-50: the link-token capture runs first. The first <script> in index.html is
 * a plain (not async, not nomodule) module script for the boot chunk; that
 * chunk imports nothing, and its source map lists only the link-token modules.
 */
export function checkBootFirst(html: string, dist: DistReader): string[] {
  const errors: string[] = [];
  const [first] = scriptsInOrder(html);
  if (!first) return ["F-50: index.html has no <script>"];
  if (!first.src || !/^\/assets\/boot-[0-9a-f]{8,}\.js$/.test(first.src))
    errors.push(
      `F-50: the first <script> must be the boot chunk, found ${first.src ?? "an inline script"}`,
    );
  if (!/\btype=["']?module\b/i.test(first.attrs))
    errors.push('F-50: the boot <script> must be type="module"');
  if (/\b(async|nomodule)\b/i.test(first.attrs))
    errors.push("F-50: the boot <script> must not be async or nomodule");
  if (!first.src || errors.length > 0) return errors;

  const file = first.src.slice(1);
  const js = dist.read(file);
  if (js === null) return [`F-50: ${file} is missing`];
  if (hasImports(js))
    errors.push(
      `F-50: ${file} imports other modules; it must be self-contained`,
    );
  const map = dist.read(`${file}.map`);
  if (map === null) {
    errors.push(`F-50: ${file}.map is missing (needed to prove its contents)`);
  } else {
    const extra = mapSources(map).filter(
      (s) => !BOOT_ALLOWED_SOURCES.includes(s),
    );
    if (extra.length > 0)
      errors.push(
        `F-50: ${file} contains more than the capture: ${extra.join(", ")}`,
      );
  }
  return errors;
}

/** The initial files (scripts and modulepreloads) carry no Sentry code. */
export function checkNoInitialSentry(
  initialFiles: readonly string[],
  dist: DistReader,
): string[] {
  return initialFiles
    .filter((f) => f.endsWith(".js"))
    .filter((f) => {
      const map = dist.read(`${f}.map`);
      return map !== null && mapSources(map).some((s) => s.includes("@sentry"));
    })
    .map(
      (f) =>
        `Sentry code in the initial bundle (${f}): it must stay a lazy chunk loaded after the first render`,
    );
}
