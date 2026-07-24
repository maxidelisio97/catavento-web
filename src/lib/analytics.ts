/*
 * Helper central para eventos custom de GA4 (gtag). El script de gtag.js
 * se carga en index.html y expone window.dataLayer / window.gtag.
 */

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

export function trackEvent(name: string, params?: Record<string, unknown>) {
  if (typeof window === "undefined" || typeof window.gtag !== "function") return;
  window.gtag("event", name, params);
}
