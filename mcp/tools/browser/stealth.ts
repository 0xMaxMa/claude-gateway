import type { Page } from 'playwright';

const STEALTH_SCRIPT = `
(function() {
  // Remove CDP window artifacts fingerprinters look for
  var cdpVars = [
    'cdc_adoQpoasnfa76pfcZLmcfl_Array',
    'cdc_adoQpoasnfa76pfcZLmcfl_Promise',
    'cdc_adoQpoasnfa76pfcZLmcfl_Symbol',
  ];
  for (var i = 0; i < cdpVars.length; i++) {
    try { delete window[cdpVars[i]]; } catch(e) {}
  }

  // Patch chrome.runtime to look like headed Chrome
  if (typeof window.chrome === 'undefined') {
    Object.defineProperty(window, 'chrome', { writable: true, enumerable: true, configurable: false, value: {} });
  }
  if (!window.chrome.runtime) {
    window.chrome.runtime = {};
  }

  // Spoof non-empty plugins list (headless returns 0)
  if (navigator.plugins.length === 0) {
    Object.defineProperty(navigator, 'plugins', {
      get: function() {
        return [{ name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }];
      },
    });
  }

  // Ensure languages is set
  if (!navigator.languages || navigator.languages.length === 0) {
    Object.defineProperty(navigator, 'languages', { get: function() { return ['en-US', 'en']; } });
  }
})();
`;

export default async function stealth(page: Page): Promise<void> {
  await page.addInitScript(STEALTH_SCRIPT);
}
