// auth.md §15 "Notification emails" as data, parsed from the contract at test
// time: the closed `kind` vocabulary, the priority (P) column and the link path
// of each kind. support/setup.ts checks every captured email of every test
// against it, so a new, renamed or mis-prioritised mail fails the test that
// sent it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { env } from "./env.ts";
import type { CapturedEmail } from "./hooks.ts";
import { templateRegex } from "./regex.ts";

export interface NotificationRule {
  kind: string;
  priority: boolean;
  /** Allowed link path patterns (anchored, without APP_ORIGIN). */
  links: RegExp[];
  /** True when the table allows a mail of this kind without a link ("none"). */
  linkOptional: boolean;
}

const authMd = readFileSync(
  fileURLToPath(new URL("../../docs/contracts/auth.md", import.meta.url)),
  "utf8",
);

function pathPattern(p: string): RegExp {
  return templateRegex(p, {
    "{budgetId}": "[0-9a-f-]{36}",
    "#token=…": "#token=[A-Za-z0-9_-]{43,64}",
  });
}

export const NOTIFICATIONS: ReadonlyMap<string, NotificationRule> = (() => {
  const start = authMd.indexOf("**Notification emails**");
  const end = authMd.indexOf("**Email link routes", start);
  if (start < 0 || end < 0)
    throw new Error("auth.md §15 notification table not found");
  const map = new Map<string, NotificationRule>();
  for (const line of authMd.slice(start, end).split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    const kind = /^`([a-z_]+)`$/.exec(cells[1] ?? "")?.[1];
    if (!kind || kind === "kind" || cells.length < 6) continue; // skip the header row
    const linkCell = cells[5]!;
    const paths = [...linkCell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    map.set(kind, {
      kind,
      priority: cells[2] === "P",
      links: paths.map(pathPattern),
      linkOptional: /\bnone\b/.test(linkCell),
    });
  }
  if (map.size < 20)
    throw new Error(`auth.md §15: parsed only ${map.size} notification kinds`);
  return map;
})();

/** The §15 "Email link routes" paths (frontend contract). */
export const LINK_ROUTES: readonly string[] = (() => {
  const start = authMd.indexOf("**Email link routes");
  const end = authMd.indexOf("- **Return after sign-in", start);
  return [...authMd.slice(start, end).matchAll(/^\| `([^`]+)` \|/gm)].map(
    (m) => m[1]!,
  );
})();

/** Problems with one captured email against auth.md §15; [] when it conforms. */
export function emailProblems(e: CapturedEmail): string[] {
  const rule = NOTIFICATIONS.get(e.kind);
  if (!rule) return [`kind "${e.kind}" is not in the auth.md §15 vocabulary`];
  const out: string[] = [];
  if (e.priority !== rule.priority)
    out.push(
      `${e.kind}: priority ${String(e.priority)}, auth.md §15 P column says ${String(rule.priority)}`,
    );
  if (e.links.length === 0 && !rule.linkOptional)
    out.push(`${e.kind}: no link, auth.md §15 requires one`);
  if (e.links.length > 1)
    out.push(`${e.kind}: ${e.links.length} links, expected at most one`);
  for (const link of e.links) {
    if (!link.startsWith(`${env.appOrigin}/`)) {
      out.push(`${e.kind}: link not built from APP_ORIGIN`);
      continue;
    }
    const rel = link.slice(env.appOrigin.length);
    const bare = rel.replace(/#.*$/, "");
    if (!rule.links.some((r) => r.test(rel)))
      out.push(
        `${e.kind}: link path ${bare}${rel.includes("#") ? "#…" : ""} is not the auth.md §15 path for this kind`,
      );
    if (
      !LINK_ROUTES.some((p) =>
        pathPattern(p.replace(/#token=…$/, "")).test(bare),
      )
    )
      out.push(
        `${e.kind}: link path ${bare} is not an auth.md §15 email link route`,
      );
  }
  return out;
}
