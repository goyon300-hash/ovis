### Changed
- Phones keep a full-width tab row below the header, with workspace and machine context in the
  header's drawer toggle. The second tab remains readable instead of being crowded out by a fixed
  workspace cell and tab menu. Touch targets stay 44px on short screens too.
- The header's scoped menu reuses pane and tab actions, permission guards and close confirmations,
  with application commands in a separate group. Its secondary tab list exposes full names.
- A numeric tab's fallback name follows its first visible pane, not browser-local pane selection;
  custom and learned names keep priority. No Herdr layout label is written.
- A split tab's header picker shows the selected pane's position and lists its sibling panes.
