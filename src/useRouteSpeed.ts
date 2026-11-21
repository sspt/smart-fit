import { useState, useEffect } from "react";
import { readSpeedSamples, routeSpeedAt, type SpeedSample } from "./routeSpeed";
export function useRouteSpeed(profileUrl: string | undefined, fallbackReference: number) {
  const [profile, setProfile] = useState<{
    url: string;
    samples: SpeedSample[];
  }>();
  const [videoTime, setVideoTime] = useState(0);
  useEffect(() => {
    if (!profileUrl) return;
    const controller = new AbortController();
    fetch(profileUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw Error("Route profile unavailable");
        const samples = readSpeedSamples(await response.json());
        if (!controller.signal.aborted)
          setProfile({ url: profileUrl, samples });
      })
      .catch(() => {
        if (!controller.signal.aborted) setProfile(undefined);
      });
    return () => controller.abort();
  }, [profileUrl]);
  const profileActive =
    !!profile && profile.url === profileUrl && profile.samples.length > 0;
  const recordedSpeed = profileActive
    ? routeSpeedAt(profile.samples, videoTime)
    : undefined;
  const reference =
    recordedSpeed != null && recordedSpeed > 0
      ? recordedSpeed
      : fallbackReference;
  return { reference, profileActive, setVideoTime };
}
