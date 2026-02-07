export type AppLocale = "en" | "zh-CN";

export const APP_LOCALE_STORAGE_KEY = "codexmonitor.locale";

export function normalizeAppLocale(value: string | null | undefined): AppLocale {
  if (!value) {
    return "en";
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "zh" || normalized === "zh-cn" || normalized.startsWith("zh-")) {
    return "zh-CN";
  }
  return "en";
}

export function detectDefaultAppLocale(): AppLocale {
  if (typeof navigator === "undefined") {
    return "en";
  }
  return normalizeAppLocale(navigator.language);
}

export function getStoredAppLocale(): AppLocale {
  if (typeof window === "undefined") {
    return "en";
  }
  const stored = window.localStorage.getItem(APP_LOCALE_STORAGE_KEY);
  if (stored) {
    return normalizeAppLocale(stored);
  }
  return detectDefaultAppLocale();
}

export function setStoredAppLocale(locale: AppLocale) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(APP_LOCALE_STORAGE_KEY, locale);
}

export function isChineseLocale(locale: AppLocale) {
  return locale === "zh-CN";
}
