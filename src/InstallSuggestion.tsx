import { useEffect, useState } from "react";
import { t } from "./i18n";

export interface InstallPrompt extends Event {
  prompt(): Promise<unknown>;
}

function isInstalled() {
  return (
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    ["standalone", "fullscreen", "minimal-ui"].some(
      (mode) => matchMedia(`(display-mode: ${mode})`).matches,
    )
  );
}

export function InstallSuggestion({
  prompt,
}: {
  prompt: InstallPrompt | null;
}) {
  const [installed, setInstalled] = useState(isInstalled);
  const [showHelp, setShowHelp] = useState(false);
  useEffect(() => {
    const markInstalled = () => setInstalled(true);
    window.addEventListener("appinstalled", markInstalled);
    return () => window.removeEventListener("appinstalled", markInstalled);
  }, []);
  if (installed || isInstalled()) return null;
  const appleMobile =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return (
    <aside className="home-install">
      <button
        type="button"
        className="primary"
        onClick={() =>
          prompt
            ? void prompt.prompt().catch(() => setShowHelp(true))
            : setShowHelp(!showHelp)
        }
      >
        {t("Install kwest.fit ›")}
      </button>
      {showHelp && (
        <p role="status">
          {t(
            appleMobile
              ? "Open Share and choose Add to Home Screen."
              : "Open the browser menu and choose Install app or Add to Home Screen.",
          )}
        </p>
      )}
    </aside>
  );
}
