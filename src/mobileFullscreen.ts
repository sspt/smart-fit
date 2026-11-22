/** Ask at launch and retry on the first tap when the browser requires activation. */
export function startMobileFullscreen() {
  const mobile =
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
    matchMedia("(pointer: coarse)").matches;
  const root = document.documentElement;
  if (
    !mobile ||
    !document.fullscreenEnabled ||
    !root.requestFullscreen ||
    document.fullscreenElement ||
    matchMedia("(display-mode: fullscreen)").matches
  )
    return;

  function request() {
    return root.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
  }

  function onFirstClick(event: MouseEvent) {
    if (!event.isTrusted) return;
    document.removeEventListener("click", onFirstClick);
    if (!document.fullscreenElement) void request();
  }

  document.addEventListener("click", onFirstClick);
  void request().then(() => {
    if (document.fullscreenElement)
      document.removeEventListener("click", onFirstClick);
  });
}
