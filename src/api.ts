async function request<T>(path: string, data?: unknown): Promise<T> {
  const key = "activation:" + path + JSON.stringify(data ?? null);
  try {
    const r = await fetch("/ifit" + path.replace(/^\/ifit/, ""), {
      method: data === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    if (!r.ok) throw Error("Activation unavailable");
    const value = await r.json();
    if (path.includes("activation"))
      localStorage.setItem(key, JSON.stringify(value));
    return value as T;
  } catch (e) {
    const cached = localStorage.getItem(key);
    if (cached) return JSON.parse(cached);
    throw e;
  }
}
export const api = {
  get: <T>(p: string) => request<T>(p),
  post: <T>(p: string, d: unknown) => request<T>(p, d),
};
