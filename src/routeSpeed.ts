export type SpeedSample = { video_time_s: number; speed_kmh: number };

export function readSpeedSamples(data: unknown): SpeedSample[] {
  const samples = (data as { samples?: SpeedSample[] } | null)?.samples;
  if (!Array.isArray(samples)) return [];
  const valid: SpeedSample[] = [];
  for (const point of samples) {
    if (
      point &&
      Number.isFinite(point.video_time_s) &&
      point.video_time_s >= 0 &&
      Number.isFinite(point.speed_kmh) &&
      point.speed_kmh >= 0 &&
      (!valid.length ||
        point.video_time_s > valid[valid.length - 1].video_time_s)
    )
      valid.push(point);
  }
  return valid;
}

export function routeSpeedAt(
  samples: SpeedSample[],
  seconds: number,
): number | undefined {
  if (
    !samples.length ||
    !Number.isFinite(seconds) ||
    seconds < samples[0].video_time_s ||
    seconds > samples[samples.length - 1].video_time_s
  )
    return;
  let left = 0;
  let right = samples.length - 1;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (samples[mid].video_time_s < seconds) left = mid + 1;
    else right = mid;
  }
  const end = samples[left];
  if (end.video_time_s === seconds) return end.speed_kmh;
  const start = samples[left - 1];
  const fraction =
    (seconds - start.video_time_s) / (end.video_time_s - start.video_time_s);
  return start.speed_kmh + fraction * (end.speed_kmh - start.speed_kmh);
}
