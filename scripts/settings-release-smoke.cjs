// Compatibility entry point for the current compact Settings layout.
import("./settings-clean-smoke.mjs").catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
