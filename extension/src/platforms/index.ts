import { claude } from "./claude";
import { chatgpt } from "./chatgpt";
import { gemini } from "./gemini";
import { deepseek } from "./deepseek";
import { grok } from "./grok";
import { copilot } from "./copilot";
import { mistral } from "./mistral";

export type Platform = "claude" | "chatgpt" | "gemini" | "deepseek" | "grok" | "copilot" | "mistral" | "unknown";

export type PlatformConfig = {
  name: Platform;
  hostname: string;
  userSelectors: string[];
  responseSelectors: string[];
  inputSelectors: string[];
  sendButtonSelectors: string[];
};

const platforms: PlatformConfig[] = [claude, chatgpt, gemini, deepseek, grok, copilot, mistral];

export const PLATFORM_HOSTNAMES: Record<string, string> = {
  claude: "claude.ai",
  chatgpt: "chatgpt.com",
  gemini: "gemini.google.com",
  deepseek: "chat.deepseek.com",
  grok: "x.com",
  copilot: "copilot.microsoft.com",
  mistral: "chat.mistral.ai",
};

export function detectPlatform(): Platform {
  const host = window.location.hostname;
  const match = platforms.find(p => {
    if (p.name === "copilot") {
      return host.includes("copilot.microsoft.com") || host.includes("m365.cloud.microsoft");
    }
    return host.includes(p.hostname);
  });
  return match?.name || "unknown";
}

export function getPlatformConfig(platform: Platform): PlatformConfig | null {
  return platforms.find(p => p.name === platform) || null;
}

export function queryAll(selectors: string[]): Element[] {
  const seen = new Set<Element>();
  const results: Element[] = [];
  for (const sel of selectors) {
    try {
      const els = document.querySelectorAll(sel);
      for (const el of Array.from(els)) {
        if (!seen.has(el)) {
          seen.add(el);
          results.push(el);
        }
      }
    } catch { /* invalid selector */ }
  }

  // Remove ancestor/descendant duplicates — keep the most specific (deepest) element.
  // This prevents double-scraping when e.g. model-response contains .model-response-text
  return results.filter(el =>
    !results.some(other => other !== el && other.contains(el))
  );
}

export function queryOne(selectors: string[]): Element | null {
  for (const sel of selectors) {
    try {
      const result = document.querySelector(sel);
      if (result) return result;
    } catch { /* invalid selector */ }
  }
  return null;
}

// Same guard as queryAll/queryOne, for matching an element against a selector
// list. Unguarded, one selector a browser cannot parse throws out of whichever
// event handler called it — and the send-button handler is shared by every
// platform, so a Gemini-only selector would break send detection everywhere.
export function matchesAny(el: Element, selectors: string[]): boolean {
  for (const sel of selectors) {
    try {
      if (el.closest(sel)) return true;
    } catch { /* invalid selector */ }
  }
  return false;
}
