import { t, uiText } from "./i18n";
import type { Programme, Session } from "./store";
import type { VideoRoute } from "./videoRoutes";

export function programmeDisplayName(programme: Programme) {
  const translated = uiText(programme.name, [], true);
  return translated.replace(/^\d+\s*min\s*·\s*/iu, "") || translated;
}

export function programmeDurationLabel(programme: Programme, fallback: string) {
  const seconds =
    programme.blocks.reduce((total, block) => total + block.duration, 0) *
    programme.repeat;
  return seconds > 0 &&
    seconds % 60 === 0 &&
    !programme.blocks.some((block) => block.distance)
    ? new Intl.NumberFormat(document.documentElement.lang, {
        style: "unit",
        unit: "minute",
        unitDisplay: "short",
      }).format(seconds / 60)
    : fallback;
}

export function routeCardTitle(route: VideoRoute) {
  return (
    route.location?.name ||
    uiText(route.name.replace(" · scenic loop", ""), [], true)
  );
}

export function routeCardActivity(route: VideoRoute) {
  const activities = {
    walk: "Walking",
    run: "Running",
    ride: "Cycling",
    row: "Rowing",
  };
  return t(route.activityType ? activities[route.activityType] : route.kind);
}

export function routeCardDuration(route: VideoRoute) {
  if (route.seconds <= 0) return t("Full-length");
  const minutes = Math.round(route.seconds / 60);
  return new Intl.NumberFormat(document.documentElement.lang, {
    style: "unit",
    unit: minutes ? "minute" : "second",
    unitDisplay: "short",
  }).format(minutes || Math.round(route.seconds));
}

export function workoutDistanceLabel(workout: Session, units: string) {
  if (
    workout.distance == null ||
    !Number.isFinite(workout.distance) ||
    workout.distance <= 0
  )
    return [];
  const miles = units === "mi";
  const distance = new Intl.NumberFormat(document.documentElement.lang, {
    maximumFractionDigits: 2,
    style: "unit",
    unit: miles ? "mile" : "kilometer",
  }).format((workout.distance / 1000) * (miles ? 0.621371 : 1));
  return [" · ", distance];
}

export function workoutStatus(status: string) {
  return t(status === "completed" ? "Completed" : "Recording ended");
}
