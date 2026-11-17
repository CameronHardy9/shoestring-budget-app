// Side-effect module: moves an emailed link's #token=… into memory and strips
// the fragment (auth.md §4, F-06). In the production build this is its own
// entry, the FIRST <script type="module"> in index.html (vite.config.ts,
// scripts/boot-script.ts), so it runs before any other code: shared chunks,
// libraries and error tracking (F-50). check-dist proves that on every build:
// first script, no imports, only this module and lib/link-token.ts inside.
// main.tsx also imports it first, which orders it in dev (unbundled modules)
// and is a no-op in the build (the same, already evaluated module).
//
// Keep it tiny and import-free apart from lib/link-token.ts.
import { captureLinkToken } from "../lib/link-token.ts";

captureLinkToken(window.location, window.history);
