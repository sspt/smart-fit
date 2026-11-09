import { useEffect, useState } from "react";
import { useMediaServer } from "./VideoCatalog";
export function MediaServerSettings({ disabled }: { disabled: boolean }) {
  const server = useMediaServer();
  const [url, setUrl] = useState(server.config.baseUrl),
    [credentials, setCredentials] = useState(server.config.credentials),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    setUrl(server.config.baseUrl);
    setCredentials(server.config.credentials);
  }, [server.config.baseUrl, server.config.credentials]);
  return (
    <details className="settings-media">
      <summary>
        Video server · {server.config.baseUrl ? "My NAS" : "Starter library"}
      </summary>
      <p>
        Stream directly from your NAS over HTTPS. The app reads catalog.json
        from this folder; videos stay on your NAS.
      </p>
      <label>
        Media folder URL
        <input
          type="url"
          value={url}
          disabled={disabled || busy}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://media.silvio.cloud"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={credentials}
          disabled={disabled || busy}
          onChange={(e) => setCredentials(e.target.checked)}
        />
        Use the server’s existing login session
      </label>
      <p className="subtle">
        For a protected server, sign in there first. Cookie access requires the
        NAS to allow this app’s origin. Passwords are never embedded in the app.
      </p>
      <button
        className="primary"
        disabled={disabled || busy}
        onClick={async () => {
          setBusy(true);
          setMessage("");
          try {
            await server.configure({ baseUrl: url, credentials });
            setMessage(
              url.trim()
                ? "Connected. Your NAS scenes are now available."
                : "Using the starter library.",
            );
          } catch (e) {
            setMessage(e instanceof Error ? e.message : "Could not connect.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Testing…" : "Save & test"}
      </button>
      {(message || server.error) && (
        <p role="status">{message || server.error}</p>
      )}
      {server.config.baseUrl && !server.error && !server.loading && (
        <p>
          {server.count} NAS scenes · Starter clips remain available as a
          fallback.
        </p>
      )}
      {disabled && (
        <p>Finish the current session before changing video servers.</p>
      )}
    </details>
  );
}
