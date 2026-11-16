import type { Session } from "./store";
import { workoutEnding, currentSegment } from "./workout";
export function WorkoutContinuation({
  session,
  busy,
  onContinue,
}: {
  session: Session | null;
  busy: boolean;
  onContinue: () => void;
}) {
  const ending = workoutEnding(session);
  if (!ending)
    return session &&
      (session.extensionSeconds ?? 0) > 0 &&
      !currentSegment(session)?.extension ? (
      <p className="workout-extension-added" role="status">
        {(session.extensionSeconds ?? 0) / 60} min extra time added.
      </p>
    ) : null;
  return (
    <section className="workout-continuation" aria-label="Continue workout">
      <div role="status">
        <strong>Keep going?</strong>
        <p>
          Workout ends in {Math.ceil(ending.remaining)}{" "}
          {ending.block.distance ? "m" : "sec"}.
        </p>
      </div>
      <button disabled={busy} onClick={onContinue}>
        Continue for 10 min
      </button>
    </section>
  );
}
