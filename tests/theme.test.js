const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ThemeHelper = require('../public/theme_helper');

test('Unit Tests: normalizeTheme cleanses and validates theme names', () => {
  // Direct matches
  assert.equal(ThemeHelper.normalizeTheme('dark'), 'dark');
  assert.equal(ThemeHelper.normalizeTheme('light'), 'light');

  // Case insensitivity and whitespace trimming
  assert.equal(ThemeHelper.normalizeTheme('DARK'), 'dark');
  assert.equal(ThemeHelper.normalizeTheme('  light  '), 'light');
  assert.equal(ThemeHelper.normalizeTheme('Dark'), 'dark');

  // Edge cases, null, undefined, invalid types
  assert.equal(ThemeHelper.normalizeTheme(null), 'dark');
  assert.equal(ThemeHelper.normalizeTheme(undefined), 'dark');
  assert.equal(ThemeHelper.normalizeTheme(123), 'dark');
  assert.equal(ThemeHelper.normalizeTheme({}), 'dark');
  assert.equal(ThemeHelper.normalizeTheme('neon'), 'dark');

  // Custom fallback
  assert.equal(ThemeHelper.normalizeTheme('invalid', 'light'), 'light');
  assert.equal(ThemeHelper.normalizeTheme(null, 'light'), 'light');
  assert.equal(ThemeHelper.normalizeTheme(null, 'invalid-fallback'), 'dark');
});

test('Unit Tests: getNextTheme accurately toggles theme state', () => {
  assert.equal(ThemeHelper.getNextTheme('dark'), 'light');
  assert.equal(ThemeHelper.getNextTheme('light'), 'dark');
  assert.equal(ThemeHelper.getNextTheme('DARK'), 'light');
  assert.equal(ThemeHelper.getNextTheme('LIGHT'), 'dark');
  assert.equal(ThemeHelper.getNextTheme(null), 'light'); // null defaults to dark, so next is light
  assert.equal(ThemeHelper.getNextTheme('unknown'), 'light');
});

test('Pickle Tests: Theme Configuration Serialization & Deserialization roundtrip integrity', () => {
  const originalConfig = {
    theme: 'light',
    autoSync: true,
    updatedAt: '2026-09-15T12:00:00.000Z'
  };

  const serialized = ThemeHelper.serializeThemeConfig(originalConfig);
  assert.equal(typeof serialized, 'string');

  const deserialized = ThemeHelper.deserializeThemeConfig(serialized);
  assert.equal(deserialized.theme, 'light');
  assert.equal(deserialized.autoSync, true);
  assert.equal(deserialized.updatedAt, '2026-09-15T12:00:00.000Z');

  // Type errors on invalid inputs
  assert.throws(() => ThemeHelper.serializeThemeConfig(null), TypeError);
  assert.throws(() => ThemeHelper.serializeThemeConfig('invalid'), TypeError);
  assert.throws(() => ThemeHelper.deserializeThemeConfig(123), TypeError);
  assert.throws(() => ThemeHelper.deserializeThemeConfig(null), TypeError);
});

test('Mutation Testing: Deserializer recovers gracefully from corrupted or mutant payloads', () => {
  // Corrupted JSON string
  const corrupted = '{"theme": "light", "autoSync": corrupt';
  const recoveredFromCorruption = ThemeHelper.deserializeThemeConfig(corrupted);
  assert.equal(recoveredFromCorruption.theme, 'dark');
  assert.equal(recoveredFromCorruption.autoSync, false);
  assert.ok(typeof recoveredFromCorruption.updatedAt === 'string');

  // JSON primitives that are not objects
  const primitiveJson = '"string-only"';
  const recoveredFromPrimitive = ThemeHelper.deserializeThemeConfig(primitiveJson);
  assert.equal(recoveredFromPrimitive.theme, 'dark');

  // Unknown theme mutated into payload
  const mutatedThemePayload = JSON.stringify({ theme: 'hacker-green', autoSync: 'yes' });
  const recoveredFromMutation = ThemeHelper.deserializeThemeConfig(mutatedThemePayload);
  assert.equal(recoveredFromMutation.theme, 'dark');
  assert.equal(recoveredFromMutation.autoSync, true);
});

test('Quality Control (QA): Theme tokens and stylesheet integrity verification', () => {
  const cssPath = path.join(__dirname, '../public/style.css');
  assert.ok(fs.existsSync(cssPath), 'style.css must exist');
  const cssContent = fs.readFileSync(cssPath, 'utf8');

  // Validate dark theme tokens
  const darkCheck = ThemeHelper.validateThemeCSS('dark', cssContent);
  assert.ok(darkCheck.valid, `Dark theme missing tokens: ${darkCheck.missing.join(', ')}`);

  // Validate light theme tokens
  const lightCheck = ThemeHelper.validateThemeCSS('light', cssContent);
  assert.ok(lightCheck.valid, `Light theme missing tokens: ${lightCheck.missing.join(', ')}`);

  // Verify theme-toggle button rules exist in CSS
  assert.ok(cssContent.includes('.theme-toggle-btn'), 'CSS must define .theme-toggle-btn');
  assert.ok(cssContent.includes('.theme-icon-sun'), 'CSS must define .theme-icon-sun');
  assert.ok(cssContent.includes('.theme-icon-moon'), 'CSS must define .theme-icon-moon');
});

test('Quality Control (QA): DOM Template & Accessibility Integrity in index.html', () => {
  const htmlPath = path.join(__dirname, '../public/index.html');
  assert.ok(fs.existsSync(htmlPath), 'index.html must exist');
  const htmlContent = fs.readFileSync(htmlPath, 'utf8');

  // Dashboard topbar toggle
  assert.ok(htmlContent.includes('id="btn-theme-toggle"'), 'index.html must include #btn-theme-toggle');
  assert.ok(htmlContent.includes('id="theme-toggle-label"'), 'index.html must include #theme-toggle-label');

  // Login overlay toggle
  assert.ok(htmlContent.includes('id="btn-theme-toggle-login"'), 'index.html must include #btn-theme-toggle-login');
  assert.ok(htmlContent.includes('id="theme-toggle-login-label"'), 'index.html must include #theme-toggle-login-label');

  // Early boot theme loader script in head
  assert.ok(htmlContent.includes("localStorage.getItem('tp_theme')"), 'index.html must have early theme loader in head');

  // Script include for theme_helper.js
  assert.ok(htmlContent.includes('theme_helper.js'), 'index.html must include theme_helper.js');
});
