import type React from "react";
import { JobCommandBar } from "./JobCommandBar";
import { useCommandBarSearch } from "./useCommandBarSearch";

// `open` is required here: the search runs only while the dialog is open, so
// an uncontrolled mount (the bar opening itself on its hotkey) would never
// search.
type ConnectedJobCommandBarProps = Omit<
  React.ComponentProps<typeof JobCommandBar>,
  "results" | "searchFailed" | "searchPending" | "onSearchChange" | "open"
> & { open: boolean };

/**
 * The bar wired to the server search. The search state lives here, not in the
 * page, so a keystroke re-renders the dialog alone rather than the whole jobs
 * page beneath it.
 */
export const ConnectedJobCommandBar: React.FC<ConnectedJobCommandBarProps> = (
  props,
) => {
  const search = useCommandBarSearch(props.open);
  return <JobCommandBar {...props} {...search} />;
};
