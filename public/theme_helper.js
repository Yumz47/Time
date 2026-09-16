/**
 * TimePulse Theme Management Helper (UMD Pattern)
 * Provides modular theme state transitions, validation, and serialization integrity.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ThemeHelper = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SUPPORTED_THEMES = Object.freeze(['dark', 'light']);
  const DEFAULT_THEME = 'dark';

  /**
   * Normalizes input theme into either 'dark' or 'light'.
   * @param {any} input 
   * @param {string} fallback 
   * @returns {'dark'|'light'}
   */
  function normalizeTheme(input, fallback = DEFAULT_THEME) {
    const cleanFallback = SUPPORTED_THEMES.includes(fallback) ? fallback : DEFAULT_THEME;
    if (typeof input !== 'string') {
      return cleanFallback;
    }
    const cleanInput = input.trim().toLowerCase();
    return SUPPORTED_THEMES.includes(cleanInput) ? cleanInput : cleanFallback;
  }

  /**
   * Returns the opposite theme.
   * @param {string} currentTheme 
   * @returns {'dark'|'light'}
   */
  function getNextTheme(currentTheme) {
    const normalized = normalizeTheme(currentTheme);
    return normalized === 'dark' ? 'light' : 'dark';
  }

  /**
   * Serializes a theme configuration payload with integrity guarantees (Pickle Test standard).
   * @param {object} config 
   * @returns {string} JSON string
   */
  function serializeThemeConfig(config) {
    if (!config || typeof config !== 'object') {
      throw new TypeError('serializeThemeConfig requires a valid object payload');
    }
    const payload = {
      theme: normalizeTheme(config.theme),
      autoSync: Boolean(config.autoSync),
      updatedAt: config.updatedAt ? new Date(config.updatedAt).toISOString() : new Date().toISOString()
    };
    return JSON.stringify(payload);
  }

  /**
   * Deserializes and validates a serialized theme payload.
   * @param {string} serialized 
   * @returns {{ theme: 'dark'|'light', autoSync: boolean, updatedAt: string }}
   */
  function deserializeThemeConfig(serialized) {
    if (typeof serialized !== 'string') {
      throw new TypeError('deserializeThemeConfig requires a string input');
    }
    try {
      const parsed = JSON.parse(serialized);
      if (!parsed || typeof parsed !== 'object') {
        return { theme: DEFAULT_THEME, autoSync: false, updatedAt: new Date().toISOString() };
      }
      return {
        theme: normalizeTheme(parsed.theme),
        autoSync: Boolean(parsed.autoSync),
        updatedAt: parsed.updatedAt ? String(parsed.updatedAt) : new Date().toISOString()
      };
    } catch (err) {
      return { theme: DEFAULT_THEME, autoSync: false, updatedAt: new Date().toISOString() };
    }
  }

  /**
   * Validates that essential CSS variables for a given theme exist in the stylesheet.
   * @param {'dark'|'light'} theme 
   * @param {string} cssContent 
   * @returns {{ valid: boolean, missing: string[] }}
   */
  function validateThemeCSS(theme, cssContent) {
    const normalized = normalizeTheme(theme);
    const requiredTokens = [
      '--bg-main',
      '--bg-secondary',
      '--bg-card',
      '--border-color',
      '--text-primary',
      '--accent-cyan'
    ];

    const missing = [];
    const selector = normalized === 'dark' ? 'body.dark-theme' : 'body.light-theme';
    
    if (!cssContent || !cssContent.includes(selector)) {
      return { valid: false, missing: [`selector: ${selector}`] };
    }

    for (const token of requiredTokens) {
      if (!cssContent.includes(token)) {
        missing.push(token);
      }
    }

    return {
      valid: missing.length === 0,
      missing
    };
  }

  return {
    SUPPORTED_THEMES,
    DEFAULT_THEME,
    normalizeTheme,
    getNextTheme,
    serializeThemeConfig,
    deserializeThemeConfig,
    validateThemeCSS
  };
});
