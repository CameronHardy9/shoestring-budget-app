// F-50: the emailed-link token capture must run before ANY other code of the
// production build (shared chunks, libraries, error tracking). Inside one
// entry chunk that can't be guaranteed: an entry's static imports (shared
// chunks) evaluate before the entry's own body, and rolldown doesn't keep
// strict cross-chunk order. So the capture is a separate rolldown entry,
// injected as the FIRST <script type="module"> in index.html. Module scripts
// that are neither async nor inline run in document order, and each one's
// whole module graph finishes before the next begins (HTML spec), so the
// capture has run before main's graph starts. scripts/check-dist.ts (with
// dist-checks.ts) proves the result on every build.
import type { Plugin } from "vite";

export const BOOT_ENTRY_NAME = "boot";
export const BOOT_SOURCE = "src/boot/capture-link-token.ts";
/** Every source the boot chunk may contain (and nothing it may import). */
export const BOOT_ALLOWED_SOURCES = [BOOT_SOURCE, "src/lib/link-token.ts"];

interface ChunkLike {
  type: string;
  isEntry?: boolean;
  name?: string;
  fileName: string;
}

/** The emitted boot entry chunk's file name, or throws. */
export function bootChunkFile(bundle: Record<string, ChunkLike>): string {
  const chunk = Object.values(bundle).find(
    (c) => c.type === "chunk" && c.isEntry && c.name === BOOT_ENTRY_NAME,
  );
  if (!chunk) throw new Error(`F-50: no "${BOOT_ENTRY_NAME}" entry chunk`);
  return chunk.fileName;
}

export function bootScriptPlugin(): Plugin {
  return {
    name: "shoestring-boot-script",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        if (!ctx.bundle) return [];
        return [
          {
            tag: "script",
            attrs: {
              type: "module",
              crossorigin: true,
              src: `/${bootChunkFile(ctx.bundle)}`,
            },
            injectTo: "head-prepend",
          },
        ];
      },
    },
  };
}
