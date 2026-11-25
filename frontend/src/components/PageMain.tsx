// The <main> of every page. While the page loader covers the page it is inert,
// so the held page can't be tapped, focused or read. It also tells the page
// loader that a page is mounted: the opening (no navigation, page-loader.ts)
// ends with the first one that has finished loading.
import type { ComponentProps } from "react";
import { usePageCovered, usePageMounted } from "./page-loader.ts";

export interface PageMainProps extends Omit<ComponentProps<"main">, "inert"> {
  /**
   * Only on the way to a page (boot, the lazy-route fallback, "/" choosing a
   * budget), with no navigation of its own: even its error or offline message
   * doesn't end the opening, so after "Try again" the page still comes at once.
   */
  interstitial?: boolean;
}

export function PageMain({ interstitial = false, ...props }: PageMainProps) {
  const covered = usePageCovered();
  usePageMounted(!interstitial);
  return <main {...props} inert={covered} />;
}
