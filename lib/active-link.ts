interface ActiveLinkRouter {
  back: () => void;
  replace: (href: string) => void;
}

interface ActiveLinkClick {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function activeLinkAction(
  event: ActiveLinkClick,
  atDestination: boolean,
  historyLength: number,
): "back" | "fallback" | null {
  if (
    !atDestination ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return null;
  }
  return historyLength > 1 ? "back" : "fallback";
}

export function handleActiveLinkClick(
  event: ActiveLinkClick & { preventDefault: () => void },
  atDestination: boolean,
  router: ActiveLinkRouter,
  fallback = "/",
) {
  const action = activeLinkAction(event, atDestination, window.history.length);
  if (!action) return;

  event.preventDefault();
  if (action === "back") router.back();
  else router.replace(fallback);
}
