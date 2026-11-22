import { t } from "./index";
export const draftText = (s: string) => t(s);
export const draftFormat = (s: string, v: Record<string, unknown>) =>
  t(s).replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));
export const adminError = (
  e: unknown,
  s: string = "Equipment operation failed",
) => t(e instanceof Error ? e.message : s);
