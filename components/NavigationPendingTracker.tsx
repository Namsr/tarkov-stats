"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { clearNavigationPending, markNavigationPending, startsInAppNavigation } from "@/lib/active-link";

/**
 * Owns the pending-navigation flag for the whole app.
 *
 * The nav bar is not the only entry point for a navigation: the footer, the FAQ
 * widget and in-page links all start one from a plain `Link`, and a flag set
 * only by the nav-bar handler never saw them. A committed route clears the
 * flag, so a link for the current page may act as the back affordance again.
 */
export default function NavigationPendingTracker() {
  const pathname = usePathname();

  useEffect(() => {
    clearNavigationPending();
  }, [pathname]);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      // The bubble phase on `document` runs after React's own handlers, so a
      // nav link reads the flag before this marks it and cannot suppress
      // itself.
      const clicked = event.target;
      const found = clicked instanceof Element ? clicked.closest("a[href]") : null;
      const link = found instanceof HTMLAnchorElement ? found : null;
      const current = window.location;
      const navigates = startsInAppNavigation(
        {
          button: event.button,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          defaultPrevented: event.defaultPrevented,
          href: link?.href ?? null,
          target: link?.target ?? null,
          download: link?.hasAttribute("download") ?? false,
        },
        { origin: current.origin, pathname: current.pathname, search: current.search },
      );
      if (navigates) markNavigationPending();
    }

    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  return null;
}
