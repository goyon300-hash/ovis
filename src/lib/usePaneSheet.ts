import { useCallback, useState } from "react";

/**
 * A phone's pane picker: the header's 1/2 chip while the open tab holds more than one pane. The
 * chip is the anchor the list opens from. The list belongs to the tab it was opened on (`owner`,
 * the PC and tab, null where no pane area draws it: no pane, or the setup guide in its place), so
 * it goes when that changes, and a pick never lands on another tab's pane.
 */
export function usePaneSheet(owner: string | null): { anchor: HTMLElement | null; toggle: (anchor: HTMLElement) => void; close: () => void } {
  const [open, setOpen] = useState<{ anchor: HTMLElement; owner: string } | null>(null);
  if (open !== null && open.owner !== owner) setOpen(null);
  const close = useCallback(() => setOpen(null), []);
  const toggle = useCallback((anchor: HTMLElement) => {
    if (owner !== null) setOpen((was) => was ? null : { anchor, owner });
  }, [owner]);
  return { anchor: open?.anchor ?? null, toggle, close };
}
