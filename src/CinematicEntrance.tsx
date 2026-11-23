import { AppIcon } from "./AppIcon";
import { t, uiText } from "./i18n";
import type { VideoRoute } from "./videoRoutes";

export function CinematicEntrance({
  route,
  onStart,
  onDiscover,
  hasSession,
  connected,
  ready,
}: {
  route: VideoRoute;
  onStart: () => void;
  onDiscover: () => void;
  hasSession: boolean;
  connected: boolean;
  ready: boolean;
}) {
  return (
    <section className="cinema-entrance" aria-labelledby="entrance-title">
      <div className="entrance-shade" />
      <div className="entrance-story">
        <h1 id="entrance-title">
          {t(hasSession ? "Back to your workout" : "Train at your own pace")}
        </h1>
        <p className="entrance-description">
          {t(
            hasSession
              ? "Your session and controls are ready."
              : connected
                ? "Your equipment is connected. Review your programme and scenery."
                : "Choose a programme and train along scenic routes.",
          )}
        </p>
        <div className="entrance-actions">
          <button
            type="button"
            className="primary entrance-start"
            onClick={onStart}
            disabled={!ready}
          >
            <AppIcon
              name={hasSession || connected ? "play" : "Train"}
              size={20}
            />
            {t(
              hasSession
                ? "Open workout"
                : connected
                  ? "Review workout"
                  : "Set up workout",
            )}
          </button>
          <button type="button" className="home-discover" onClick={onDiscover}>
            <AppIcon name="Explore" size={19} />
            {t("Discover routes")}
          </button>
        </div>
      </div>
      {!hasSession && (
        <div className="home-route">
          <span className="home-route-icon">
            <AppIcon name={route.kind} size={22} />
          </span>
          <div>
            <small>{t(route.kind)}</small>
            <strong>
              {uiText(route.name.replace(" · scenic loop", ""), [], true)}
            </strong>
          </div>
        </div>
      )}
    </section>
  );
}
