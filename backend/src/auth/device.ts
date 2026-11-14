// Fixed device vocabulary from the User-Agent at sign-in (auth.md §2, F-20).
// The raw User-Agent is never stored or logged.
import type { DeviceBrowser, DeviceOs } from "@shoestring/db";

export function parseDevice(userAgent: string | undefined): {
  browser: DeviceBrowser;
  os: DeviceOs;
} {
  const ua = (userAgent ?? "").slice(0, 512);
  if (ua.trim() === "") return { browser: "unknown", os: "unknown" };

  let browser: DeviceBrowser = "other";
  if (/\bEdg(e|A|iOS)?\//.test(ua)) browser = "edge";
  else if (/\bSamsungBrowser\//.test(ua)) browser = "samsung_internet";
  else if (/\b(Firefox|FxiOS)\//.test(ua)) browser = "firefox";
  else if (/\b(Chrome|CriOS|Chromium)\//.test(ua)) browser = "chrome";
  else if (
    /\bVersion\/[\d.]+.*\bSafari\//.test(ua) ||
    /\b(iPhone|iPad).*AppleWebKit/.test(ua)
  )
    browser = "safari";

  let os: DeviceOs = "other";
  if (/\biPad\b/.test(ua)) os = "ipados";
  else if (/\b(iPhone|iPod)\b/.test(ua)) os = "ios";
  else if (/\bAndroid\b/.test(ua)) os = "android";
  else if (/\bCrOS\b/.test(ua)) os = "chromeos";
  else if (/\b(Macintosh|Mac OS X)\b/.test(ua)) os = "macos";
  else if (/\bWindows\b/.test(ua)) os = "windows";
  else if (/\bLinux\b/.test(ua)) os = "linux";

  return { browser, os };
}
