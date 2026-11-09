import { sessionStats, previousAttempt, weeklyStats } from "./feedbackStats";
import type { Session } from "./store";
const duration = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
export function WorkoutRecap({
  session,
  history,
  units = "km",
  onDismiss,
}: {
  session: Session | null;
  history: Session[];
  units?: string;
  onDismiss: () => void;
}) {
  if (!session) return null;
  const stats = sessionStats(session),
    previous = previousAttempt(session, history),
    before = previous ? sessionStats(previous) : null,
    factor = units === "mi" ? 0.621371 : 1;
  return (
    <section className="panel workout-recap" aria-label="Workout recap">
      <div className="section-head">
        <h2>
          {session.status === "completed" ? "Workout saved" : "Tracking saved"}
          {session.demo ? " · Demo" : ""}
        </h2>
        <button onClick={onDismiss} aria-label="Dismiss workout recap">
          Done
        </button>
      </div>
      <p>{session.programme.name}</p>
      <p>
        <strong>{duration(stats.seconds)}</strong> training
        {stats.distance !== null && (
          <>
            {" "}
            ·{" "}
            <strong>
              {((stats.distance / 1000) * factor).toFixed(2)} {units}
            </strong>
          </>
        )}
        {stats.average !== null && (
          <>
            {" "}
            · Average{" "}
            <strong>
              {(stats.average * (stats.key === "speed" ? factor : 1)).toFixed(
                1,
              )}{" "}
              {stats.key === "power" ? "W" : `${units}/h`}
            </strong>
          </>
        )}
      </p>
      {before?.distance != null && stats.distance != null && (
        <p>
          Previous attempt: {((before.distance / 1000) * factor).toFixed(2)}{" "}
          {units} in {duration(before.seconds)}.
        </p>
      )}
    </section>
  );
}
export function WeeklyProgress({ history }: { history: Session[] }) {
  const stats = weeklyStats(history);
  return (
    <p className="weekly-progress">
      This week:{" "}
      <strong>
        {stats.count} {stats.count === 1 ? "session" : "sessions"} ·{" "}
        {stats.minutes} minutes
      </strong>
    </p>
  );
}
export function IntervalCue({ text }: { text: string }) {
  return text ? (
    <div className="interval-cue" role="status">
      {text}
    </div>
  ) : null;
}
