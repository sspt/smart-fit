import { AppIcon } from "./AppIcon";
import type { VideoRoute } from "./videoRoutes";

/** A decorative opening scene; never starts a workout or controls equipment. */
export function CinematicEntrance({
  route,
  onStart,
  hasSession,
}: {
  route: VideoRoute;
  onStart: () => void;
  hasSession: boolean;
}) {
  return (
    <section className="cinema-entrance" aria-labelledby="entrance-title">
      <div className="entrance-shade" />
      <div className="opening-credit">
        <span className="credit-line" /> A KWEST.FIT EXPERIENCE
      </div>
      <div className="entrance-story">
        <p className="eyebrow">SOMEWHERE BEYOND THE EVERYDAY</p>
        <h1 id="entrance-title">
          The world
          <br />
          can wait.
        </h1>
        <p className="entrance-description">
          Step into the quiet. Follow the light.
          <br />
          Let the next scene unfold at your pace.
        </p>
        <div className="entrance-actions">
          <button className="primary entrance-start" onClick={onStart}>
            <AppIcon name="play" size={20} />{" "}
            {hasSession ? "Resume journey" : "Start"}
          </button>
        </div>
      </div>
      <div className="entrance-bottom">
        <span>
          <i /> NOW SHOWING{" "}
          <strong>{route.name.replace(" · scenic loop", "")}</strong>
        </span>
      </div>
    </section>
  );
}
