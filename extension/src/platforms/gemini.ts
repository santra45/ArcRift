import { INPUT_SELECTOR_STRATEGIES } from "../platform/resolver";

export const gemini = {
  name: "gemini" as const,
  hostname: "gemini.google.com",
  userSelectors: [
    // Gemini uses obfuscated classes & custom web components — multi-level cascade
    '.query-text',
    '.user-query',
    '.query-content',
    'user-query',                          // custom web component tag
    'message-content[data-query-text]',    // data attribute variant
    'div[data-test-id="user-query"]',      // data-test-id variant
    '[data-message-author="user"]',
    // Fallback: Gemini wraps user prompts in specific turn containers
    '.conversation-turn-user',
    'user-message',                         // custom element tag
    'div[data-testid="user-turn"]',         // unhyphenated data-testid
    '.user-query-container',
    // Last resort: case-insensitive aria labels, including localized ones
    'div[aria-label*="User prompt" i]',
    'div[aria-label*="用户提示" i]',
  ],
  responseSelectors: [
    ".response-content",
    "model-response",
    ".model-response-text",
    "message-content",                      // custom element tag for responses
    'div[data-test-id="model-response"]',   // data-test-id variant
    'div[data-testid="assistant-turn"]',    // unhyphenated data-testid
    '.model-response-container',
    // Last resort: case-insensitive aria labels, including localized ones
    'div[aria-label*="Model response" i]',
    'div[aria-label*="Gemini response" i]',
    'div[aria-label*="回答" i]',
  ],
  // v1.5.1: multi-strategy selectors via resolver — survives platform UI updates
  inputSelectors: INPUT_SELECTOR_STRATEGIES.gemini,
  sendButtonSelectors: [
    'button[aria-label="Send message"]',
    'button[mat-icon-button][aria-label*="Send" i]',
    'button[aria-label*="Send" i]',
    'button[aria-label*="Submit" i]',
    'button[aria-label*="发送" i]',          // zh-CN locale
    ".send-button",
    'button.send-button',
    'button.send-button-container',
    // Last resort: identify the button by the icon it wraps
    'button:has(mat-icon[data-mat-icon-name="send"])',
    'button:has(svg[data-icon="send"])',
  ],
};
