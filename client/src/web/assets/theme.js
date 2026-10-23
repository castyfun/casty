// Runs before the page paints, so a saved light or dark choice never flashes the other theme.
try {
  const theme = JSON.parse(localStorage.getItem("casty.theme") ?? '"auto"');
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {
  // No storage: the page follows the system.
}
