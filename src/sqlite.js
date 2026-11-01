// node:sqlite wrapper with a TARGETED ExperimentalWarning suppression.
// Older Node releases (22.5–25) emit an ExperimentalWarning on first import of
// node:sqlite; hosts (e.g. LM Studio's log viewer) render any stderr line as
// "Error:", so a scary warning on first run is a real first-impression cost.
// We suppress ONLY that warning, never blanket --no-warnings.
const origEmit = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  const kind = typeof args[0] === "string" ? args[0] : (warning?.name ?? "");
  const code = warning?.code ?? "";
  const msg = String(warning?.message ?? warning ?? "");
  // Node's message is "SQLite is an experimental feature…" (no "node:sqlite" substring).
  if ((kind === "ExperimentalWarning" || code === "ExperimentalWarning") && msg.toLowerCase().includes("sqlite")) return;
  return origEmit(warning, ...args);
};

const { DatabaseSync } = await import("node:sqlite");
export { DatabaseSync };