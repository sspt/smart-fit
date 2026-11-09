export const draftText = (s: string) => s;
export const draftFormat = (s: string, v: Record<string, unknown>) =>
  s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));
export const adminError = (
  e: unknown,
  s: string = "Equipment operation failed",
) => (e instanceof Error ? e.message : s);
