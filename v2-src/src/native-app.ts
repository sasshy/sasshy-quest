/**
 * True inside the SASSHY iPhone app (WKWebView with the native bridge).
 * The app's page has no https origin, so browser-only endpoints that rely on
 * CORS (the schedule-history Edge Function) cannot be reached from it.
 */
export function isNativeApp(): boolean {
  return typeof window !== 'undefined'
    && Boolean((window as unknown as { webkit?: { messageHandlers?: { sasshyAlarm?: unknown } } })
      .webkit?.messageHandlers?.sasshyAlarm);
}
