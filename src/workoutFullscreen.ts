let workoutFullscreen = false;

export function startWorkoutFullscreen() {
  const root = document.documentElement;
  if (
    workoutFullscreen ||
    document.fullscreenElement ||
    !root.requestFullscreen
  )
    return false;
  workoutFullscreen = true;
  void root.requestFullscreen({ navigationUI: "hide" }).catch(() => {
    workoutFullscreen = false;
  });
  return true;
}

export function isWorkoutFullscreen() {
  return (
    workoutFullscreen && document.fullscreenElement === document.documentElement
  );
}

export function exitWorkoutFullscreen() {
  if (isWorkoutFullscreen()) void document.exitFullscreen().catch(() => {});
  workoutFullscreen = false;
}
