// Side-effect module, imported FIRST by main.tsx. ES modules evaluate in import
// order, so this runs before any other app module (error tracking included)
// is evaluated and before anything renders (auth.md §4, F-06).
import { captureLinkToken } from "../lib/link-token.ts";

captureLinkToken(window.location, window.history);
