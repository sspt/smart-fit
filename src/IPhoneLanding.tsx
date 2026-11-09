import { useState } from "react";
export function IPhoneLanding() {
  const [copied, setCopied] = useState(false),
    [failed, setFailed] = useState(false);
  return (
    <main className="iphone-landing">
      <header className="iphone-brand">
        <img src="/logo.svg" width="40" height="40" alt="" />
        <span>
          kwest<span>.fit</span>
        </span>
      </header>
      <section aria-labelledby="iphone-title" className="iphone-content">
        <p className="iphone-eyebrow">A WINDOW TO ELSEWHERE</p>
        <h1 id="iphone-title">Your journey needs a different device.</h1>
        <p>
          This iPhone browser doesn’t support Web Bluetooth, which kwest.fit
          needs to connect to your fitness equipment.
        </p>
        <div className="iphone-next">
          <h2>Continue on Android</h2>
          <p>
            Open <strong>kwest.fit</strong> in Chrome on an Android phone with
            Bluetooth enabled.
          </p>
          <p className="iphone-secondary">
            A computer with Web Bluetooth support in Chrome or Edge can also
            work with compatible equipment.
          </p>
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText("https://kwest.fit");
                setCopied(true);
                setFailed(false);
              } catch {
                setFailed(true);
              }
            }}
          >
            {copied ? "Link copied" : "Copy website link"}
          </button>
          <p className="iphone-link" role="status">
            {failed
              ? "Copy this address: https://kwest.fit"
              : copied
                ? "Open the link on your supported device."
                : "kwest.fit"}
          </p>
        </div>
      </section>
      <footer>Nature at your pace.</footer>
    </main>
  );
}
