export type CardioType = "Treadmill" | "Bike" | "Rower" | "Other";
export interface CardioBleSummary {
  deviceName: string;
  cardioType: CardioType;
  avgSpeedKmh: number | null;
  maxSpeedKmh: number | null;
  avgCadenceRpm: number | null;
  avgPowerW: number | null;
  maxPowerW: number | null;
  distanceKm: number | null;
  distanceEstimated: boolean;
  avgInclinePct?: number | null;
  maxInclinePct?: number | null;
  caloriesKcal: number | null;
  strokeCount?: number | null;
  [key: string]: unknown;
}
