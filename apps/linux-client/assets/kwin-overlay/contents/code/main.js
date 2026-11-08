// Wayland apps cannot position their own windows, so KWin places the Sotto
// status pill: bottom centre of the usable area (above panels), always on top,
// hidden from the taskbar, pager and Alt+Tab. Matches the window title set in
// src/main/status-overlay.ts.
const title = "Sotto Status";
const gap = 12;

function place(window) {
  if (window.caption !== title) return;
  window.keepAbove = true;
  window.skipTaskbar = true;
  window.skipPager = true;
  window.skipSwitcher = true;
  const area = workspace.clientArea(KWin.PlacementArea, window);
  const { width, height } = window.frameGeometry;
  window.frameGeometry = {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + area.height - height - gap),
    width,
    height,
  };
}

workspace.windowAdded.connect(place);
workspace.windowList().forEach(place);
