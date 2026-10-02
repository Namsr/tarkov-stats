"use client";

import { useRouter } from "next/navigation";
import { markNavigationPending } from "@/lib/active-link";

/**
 * `useRouter()` that marks the pending-navigation flag before it navigates.
 *
 * The document-level tracker only sees anchor clicks, so a navigation the app
 * starts from a button or a form submit — a search result, a saved nickname —
 * leaves the back affordance live while it loads, and the next nav-tab click is
 * hijacked into `router.back()`. Marking here closes that window for every
 * caller without each one having to remember.
 *
 * Use it for navigation the user asked for. URL-state sync (a `replace` that
 * only rewrites the query) is not that: it fires on ordinary interaction and
 * commits a route the user is already on.
 */
export function useTrackedRouter() {
  const router = useRouter();
  return {
    ...router,
    push: (href: string, options?: Parameters<typeof router.push>[1]) => {
      markNavigationPending();
      router.push(href, options);
    },
    replace: (href: string, options?: Parameters<typeof router.replace>[1]) => {
      markNavigationPending();
      router.replace(href, options);
    },
  };
}
