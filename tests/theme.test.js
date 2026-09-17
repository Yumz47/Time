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

test('Unit Tests: hexToRgb, relative luminance, and contrast ratio calculations', () => {
  // Hex parsing
  assert.deepEqual(ThemeHelper.hexToRgb('#ffffff'), [255, 255, 255]);
  assert.deepEqual(ThemeHelper.hexToRgb('#000000'), [0, 0, 0]);
  assert.deepEqual(ThemeHelper.hexToRgb('#fff'), [255, 255, 255]);
  assert.deepEqual(ThemeHelper.hexToRgb('#0f172a'), [15, 23, 42]);
  assert.equal(ThemeHelper.hexToRgb('invalid'), null);
  assert.equal(ThemeHelper.hexToRgb(null), null);

  // Relative luminance
  const whiteLum = ThemeHelper.calculateRelativeLuminance([255, 255, 255]);
  const blackLum = ThemeHelper.calculateRelativeLuminance([0, 0, 0]);
  assert.equal(Math.round(whiteLum), 1);
  assert.equal(blackLum, 0);

  // Contrast ratios
  const blackWhiteRatio = ThemeHelper.calculateContrastRatio('#000000', '#ffffff');
  assert.equal(blackWhiteRatio, 21.0);

  const whiteOnWhite = ThemeHelper.calculateContrastRatio('#ffffff', '#ffffff');
  assert.equal(whiteOnWhite, 1.0);

  // Light theme: dark slate text #0f172a on white input #ffffff
  const lightInputContrast = ThemeHelper.calculateContrastRatio('#0f172a', '#ffffff');
  assert.ok(lightInputContrast >= 16.0, `Expected >= 16.0, got ${lightInputContrast}`);

  // Dark theme: bright text #f8fafc on dark background #111827
  const darkInputContrast = ThemeHelper.calculateContrastRatio('#f8fafc', '#111827');
  assert.ok(darkInputContrast >= 14.0, `Expected >= 14.0, got ${darkInputContrast}`);
});

test('Unit Tests: WCAG 2.1 compliance evaluation for light and dark theme palettes', () => {
  // Pass normal text AA (>= 4.5) and AAA (>= 7.0)
  const passAaa = ThemeHelper.evaluateWcagCompliance(16.5, false);
  assert.strictEqual(passAaa.passAA, true);
  assert.strictEqual(passAaa.passAAA, true);

  // Pass AA but fail AAA (e.g. 5.2:1)
  const passAaOnly = ThemeHelper.evaluateWcagCompliance(5.2, false);
  assert.strictEqual(passAaOnly.passAA, true);
  assert.strictEqual(passAaOnly.passAAA, false);

  // Large text (>= 3.0 for AA)
  const passLargeAa = ThemeHelper.evaluateWcagCompliance(3.5, true);
  assert.strictEqual(passLargeAa.passAA, true);
  assert.strictEqual(passLargeAa.passAAA, false);

  // Severe failure (e.g. white text on white background: 1.0:1)
  const severeFail = ThemeHelper.evaluateWcagCompliance(1.0, false);
  assert.strictEqual(severeFail.passAA, false);
  assert.strictEqual(severeFail.passAAA, false);
});

test('Pickle Tests: Theme Accessibility & Contrast Settings roundtrip integrity', () => {
  const originalSettings = {
    theme: 'light',
    highContrastMode: false,
    minContrastRatio: 4.5,
    inspectedElements: ['input', 'select', 'textarea'],
    timestamp: '2026-09-17T08:30:00.000Z'
  };

  const serialized = JSON.stringify(originalSettings);
  assert.equal(typeof serialized, 'string');

  const deserialized = JSON.parse(serialized);
  assert.deepEqual(deserialized, originalSettings);
  assert.equal(deserialized.minContrastRatio, 4.5);
  assert.equal(deserialized.inspectedElements.length, 3);
});

test('Mutation Testing: WCAG threshold mutations and color contrast regression detection', () => {
  // Mutant 1: White on white must NEVER pass WCAG AA
  const whiteOnWhiteRatio = ThemeHelper.calculateContrastRatio('#ffffff', '#ffffff');
  const result = ThemeHelper.evaluateWcagCompliance(whiteOnWhiteRatio);
  assert.strictEqual(result.passAA, false, 'White on white input text must fail WCAG AA');

  // Mutant 2: CSS with hardcoded #fff input text must be caught by audit
  const mutantCSS = `
    .form-group input[type="text"] {
      background: rgba(255, 255, 255, 0.05);
      color: #fff;
    }
  `;
  const auditResult = ThemeHelper.auditFormInputContrasts(mutantCSS);
  assert.strictEqual(auditResult.compliant, false);
  assert.ok(auditResult.violations.length >= 1);
  assert.ok(auditResult.violations[0].includes('hardcoded #fff'));
});

test('Quality Control (QA): Form input contrast audit and style.css regression prevention', () => {
  const cssPath = path.join(__dirname, '../public/style.css');
  const cssContent = fs.readFileSync(cssPath, 'utf8');

  // Audit active stylesheet
  const audit = ThemeHelper.auditFormInputContrasts(cssContent);
  assert.strictEqual(
    audit.compliant,
    true,
    `style.css failed input contrast audit: ${audit.violations.join('; ')}`
  );

  // Ensure semantic tokens exist
  assert.ok(cssContent.includes('--modal-footer-bg'), 'style.css must define --modal-footer-bg');
  assert.ok(cssContent.includes('--schedule-container-bg'), 'style.css must define --schedule-container-bg');
  assert.ok(cssContent.includes('--schedule-day-bg'), 'style.css must define --schedule-day-bg');
  assert.ok(cssContent.includes('--btn-secondary-bg'), 'style.css must define --btn-secondary-bg');

  // Verify schedule-day-select uses theme variables and not hardcoded #fff
  assert.ok(cssContent.includes('.schedule-day-select {'), 'style.css must define .schedule-day-select');
  assert.ok(cssContent.includes('color: var(--text-primary)'), 'schedule-day-select must use var(--text-primary)');
});

