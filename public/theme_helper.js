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

  /**
   * Converts a 3 or 6 digit hex color string to RGB array [r, g, b].
   * @param {string} hex 
   * @returns {[number, number, number]|null}
   */
  function hexToRgb(hex) {
    if (typeof hex !== 'string') return null;
    let clean = hex.trim().replace(/^#/, '');
    if (clean.length === 3) {
      clean = clean.split('').map(c => c + c).join('');
    }
    if (clean.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(clean)) {
      return null;
    }
    const num = parseInt(clean, 16);
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
  }

  /**
   * Calculates the relative luminance of an sRGB channel value.
   * @param {number} value (0-255)
   * @returns {number}
   */
  function getChannelLuminance(value) {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }

  /**
   * Calculates relative luminance of an RGB triplet per WCAG 2.1 specs.
   * @param {[number, number, number]} rgb 
   * @returns {number}
   */
  function calculateRelativeLuminance(rgb) {
    if (!Array.isArray(rgb) || rgb.length < 3) return 0;
    const [r, g, b] = rgb;
    return 0.2126 * getChannelLuminance(r) + 0.7152 * getChannelLuminance(g) + 0.0722 * getChannelLuminance(b);
  }

  /**
   * Calculates WCAG 2.1 contrast ratio between two colors (hex or [r,g,b]).
   * @param {string|[number,number,number]} c1 
   * @param {string|[number,number,number]} c2 
   * @returns {number} contrast ratio from 1.0 to 21.0
   */
  function calculateContrastRatio(c1, c2) {
    const rgb1 = Array.isArray(c1) ? c1 : hexToRgb(c1);
    const rgb2 = Array.isArray(c2) ? c2 : hexToRgb(c2);
    if (!rgb1 || !rgb2) return 1.0;

    const l1 = calculateRelativeLuminance(rgb1);
    const l2 = calculateRelativeLuminance(rgb2);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
  }

  /**
   * Evaluates WCAG compliance for normal and large text.
   * @param {number} ratio 
   * @param {boolean} isLargeText 
   * @returns {{ ratio: number, passAA: boolean, passAAA: boolean }}
   */
  function evaluateWcagCompliance(ratio, isLargeText = false) {
    const minAA = isLargeText ? 3.0 : 4.5;
    const minAAA = isLargeText ? 4.5 : 7.0;
    return {
      ratio,
      passAA: ratio >= minAA,
      passAAA: ratio >= minAAA
    };
  }

  /**
   * Audits CSS stylesheet to verify form inputs and modals don't have hardcoded uncontrasted colors.
   * @param {string} cssContent 
   * @returns {{ compliant: boolean, violations: string[] }}
   */
  function auditFormInputContrasts(cssContent) {
    const violations = [];
    if (!cssContent || typeof cssContent !== 'string') {
      return { compliant: false, violations: ['Empty or invalid stylesheet'] };
    }

    // Check for hardcoded white text on .form-group input
    const formGroupInputRegex = /\.form-group\s+input\[type="text"\][^\{]*\{([^}]+)\}/s;
    const match = formGroupInputRegex.exec(cssContent);
    if (match) {
      const block = match[1];
      if (/color:\s*#fff\b/i.test(block) && !block.includes('var(--text-primary)')) {
        violations.push('.form-group inputs have hardcoded #fff text color (fails light-theme contrast)');
      }
      if (/background:\s*rgba\(255,\s*255,\s*255,\s*0\.05\)/i.test(block) && !block.includes('var(--input-bg)')) {
        violations.push('.form-group inputs have hardcoded dark-mode background without light-theme variable');
      }
    }

    return {
      compliant: violations.length === 0,
      violations
    };
  }

  return {
    SUPPORTED_THEMES,
    DEFAULT_THEME,
    normalizeTheme,
    getNextTheme,
    serializeThemeConfig,
    deserializeThemeConfig,
    validateThemeCSS,
    hexToRgb,
    calculateRelativeLuminance,
    calculateContrastRatio,
    evaluateWcagCompliance,
    auditFormInputContrasts
  };
});
