// Wayland apps cannot position their own windows, so KWin places the Sotto
// status pill: always on top, hidden from the taskbar, pager and Alt+Tab.
// The client puts the chosen position in the window title,
// "Sotto Status: <position>" (see src/main/status-overlay.ts):
//   center         middle of the usable area
//   above-taskbar  bottom centre, just above panels
//   over-taskbar   bottom centre, on top of the bottom panel
const prefix = "Sotto Status";
const gap = 4;
const connected = new Set();

function place(window) {
  if (!window.caption.startsWith(prefix)) return;
  window.keepAbove = true;
  window.skipTaskbar = true;
  window.skipPager = true;
  window.skipSwitcher = true;
  // Re-place when the user picks another position while the pill is shown.
  if (!connected.has(window)) {
    connected.add(window);
    window.captionChanged.connect(() => place(window));
    window.closed.connect(() => connected.delete(window));
  }

  const position = window.caption.slice(prefix.length + 2) || "above-taskbar";
  const usable = workspace.clientArea(KWin.PlacementArea, window);
  const screen = workspace.clientArea(KWin.ScreenArea, window);
  const { width, height } = window.frameGeometry;
  const x = Math.round(usable.x + (usable.width - width) / 2);
  let y = usable.y + usable.height - height - gap;
  if (position === "center") {
    y = usable.y + (usable.height - height) / 2;
  } else if (position === "over-taskbar") {
    // Centre the pill in the strip a bottom panel reserves; with no bottom
    // panel the strip is empty and the pill sits at the screen edge.
    const strip = screen.y + screen.height - (usable.y + usable.height);
    y = screen.y + screen.height - (strip >= height ? (strip + height) / 2 : height + gap);
  }
  window.frameGeometry = { x, y: Math.round(y), width, height };
}

workspace.windowAdded.connect(place);
workspace.windowList().forEach(place);
