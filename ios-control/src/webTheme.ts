const WEBVIEW_THEME_CSS = String.raw`
:root[data-xiaoli-ios-theme="true"] {
  color: #14213d;
  background: #f7f3ea;
  color-scheme: light;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
  font-synthesis: none;
  -webkit-font-smoothing: antialiased;
  --navy: #14213d;
  --navy-soft: #263553;
  --gold: #d99a3d;
  --gold-deep: #bd7f26;
  --gold-soft: #f3e3c8;
  --ivory: #f7f3ea;
  --ivory-deep: #eee6d8;
  --surface: #fffdf8;
  --surface-strong: #ffffff;
  --ink-muted: #667085;
  --line: rgba(20, 33, 61, 0.12);
  --success: #2f7664;
  --success-soft: #e7f2ed;
  --danger: #a44343;
  --shadow-card: 0 12px 34px rgba(20, 33, 61, 0.09), 0 2px 8px rgba(20, 33, 61, 0.04);
  --shadow-control: 0 2px 5px rgba(20, 33, 61, 0.08);
}

html[data-xiaoli-ios-theme="true"] {
  min-width: 320px;
  min-height: 100%;
  background: #f7f3ea;
  scroll-behavior: smooth;
}

html[data-xiaoli-ios-theme="true"] body {
  min-height: 100vh;
  min-height: 100dvh;
  margin: 0;
  color: var(--navy);
  background:
    radial-gradient(circle at 100% -4rem, rgba(217, 154, 61, 0.17), transparent 24rem),
    radial-gradient(circle at -6rem 30rem, rgba(20, 33, 61, 0.06), transparent 22rem),
    var(--ivory);
  letter-spacing: -0.01em;
  -webkit-text-size-adjust: 100%;
}

html[data-xiaoli-ios-theme="true"] *,
html[data-xiaoli-ios-theme="true"] *::before,
html[data-xiaoli-ios-theme="true"] *::after {
  box-sizing: border-box;
}

html[data-xiaoli-ios-theme="true"] [hidden] {
  display: none !important;
}

html[data-xiaoli-ios-theme="true"] button,
html[data-xiaoli-ios-theme="true"] input {
  font: inherit;
}

html[data-xiaoli-ios-theme="true"] button,
html[data-xiaoli-ios-theme="true"] a,
html[data-xiaoli-ios-theme="true"] input {
  -webkit-tap-highlight-color: transparent;
}

html[data-xiaoli-ios-theme="true"] :focus-visible {
  outline: 3px solid rgba(217, 154, 61, 0.55);
  outline-offset: 3px;
}

html[data-xiaoli-ios-theme="true"] .skip-link {
  position: fixed;
  z-index: 100;
  top: max(0.75rem, env(safe-area-inset-top));
  left: max(0.75rem, env(safe-area-inset-left));
  padding: 0.72rem 1rem;
  color: var(--navy);
  background: var(--gold);
  border-radius: 0.8rem;
  box-shadow: var(--shadow-control);
  font-weight: 750;
  transform: translateY(-180%);
}

html[data-xiaoli-ios-theme="true"] .skip-link:focus {
  transform: translateY(0);
}

html[data-xiaoli-ios-theme="true"] .app-header {
  position: sticky;
  z-index: 20;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  min-height: 4.35rem;
  padding: 0.72rem 1rem;
  color: #fffdf8;
  background: linear-gradient(145deg, #14213d 0%, #1d2d4d 100%);
  border-bottom: 1px solid rgba(217, 154, 61, 0.45);
  box-shadow: 0 8px 24px rgba(20, 33, 61, 0.16);
  -webkit-backdrop-filter: saturate(140%) blur(18px);
  backdrop-filter: saturate(140%) blur(18px);
}

html[data-xiaoli-ios-theme="true"] .app-header h1,
html[data-xiaoli-ios-theme="true"] .panel-heading h2,
html[data-xiaoli-ios-theme="true"] .section-title-row h2 {
  margin: 0;
  line-height: 1.15;
  letter-spacing: -0.035em;
}

html[data-xiaoli-ios-theme="true"] .app-header h1 {
  color: #fffdf8;
  font-size: clamp(1.45rem, 5.5vw, 1.9rem);
  font-weight: 780;
}

html[data-xiaoli-ios-theme="true"] .eyebrow,
html[data-xiaoli-ios-theme="true"] .step-label {
  margin: 0 0 0.34rem;
  font-size: 0.7rem;
  font-weight: 800;
  letter-spacing: 0.14em;
  line-height: 1.2;
  text-transform: uppercase;
}

html[data-xiaoli-ios-theme="true"] .eyebrow {
  color: #e9bb72;
}

html[data-xiaoli-ios-theme="true"] .step-label {
  color: var(--gold-deep);
}

html[data-xiaoli-ios-theme="true"] .page-shell {
  width: min(calc(100% - 1.25rem), 76rem);
  margin: 0 auto;
  padding: 1rem 0 max(2rem, env(safe-area-inset-bottom));
}

html[data-xiaoli-ios-theme="true"] .panel,
html[data-xiaoli-ios-theme="true"] .status-overview {
  padding: 1.2rem;
  overflow: hidden;
  background: rgba(255, 253, 248, 0.97);
  border: 1px solid rgba(20, 33, 61, 0.1);
  border-radius: 1.35rem;
  box-shadow: var(--shadow-card);
}

html[data-xiaoli-ios-theme="true"] .setup-panel {
  max-width: 34rem;
  margin: clamp(1.4rem, 6vh, 4rem) auto 0;
}

html[data-xiaoli-ios-theme="true"] .panel-heading {
  margin-bottom: 1.3rem;
}

html[data-xiaoli-ios-theme="true"] .panel-heading h2,
html[data-xiaoli-ios-theme="true"] .section-title-row h2 {
  color: var(--navy);
  font-size: clamp(1.42rem, 5vw, 1.85rem);
  font-weight: 780;
}

html[data-xiaoli-ios-theme="true"] .panel-heading p:not(.step-label) {
  max-width: 42rem;
  margin: 0.7rem 0 0;
  color: var(--ink-muted);
  font-size: 0.91rem;
  line-height: 1.65;
}

html[data-xiaoli-ios-theme="true"] .compact-heading {
  margin-bottom: 1rem;
}

html[data-xiaoli-ios-theme="true"] .stack-form,
html[data-xiaoli-ios-theme="true"] .voice-form {
  display: grid;
  gap: 0.9rem;
}

html[data-xiaoli-ios-theme="true"] label {
  color: var(--navy);
  font-size: 0.88rem;
  font-weight: 720;
}

html[data-xiaoli-ios-theme="true"] input[type="text"],
html[data-xiaoli-ios-theme="true"] input[type="password"] {
  width: 100%;
  min-height: 3.15rem;
  padding: 0.76rem 0.9rem;
  color: var(--navy);
  caret-color: var(--gold-deep);
  background: var(--surface-strong);
  border: 1px solid rgba(20, 33, 61, 0.2);
  border-radius: 0.9rem;
  box-shadow: inset 0 1px 2px rgba(20, 33, 61, 0.035), var(--shadow-control);
  appearance: none;
  -webkit-appearance: none;
  transition: border-color 160ms ease, box-shadow 160ms ease, background-color 160ms ease;
}

html[data-xiaoli-ios-theme="true"] input[type="text"]:focus,
html[data-xiaoli-ios-theme="true"] input[type="password"]:focus {
  background: #ffffff;
  border-color: var(--gold);
  box-shadow: 0 0 0 4px rgba(217, 154, 61, 0.14);
  outline: none;
}

html[data-xiaoli-ios-theme="true"] .button {
  min-height: 3.05rem;
  padding: 0.72rem 1.05rem;
  border: 1px solid transparent;
  border-radius: 0.92rem;
  box-shadow: var(--shadow-control);
  font-size: 0.92rem;
  font-weight: 780;
  line-height: 1.15;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  transition: transform 130ms ease, background-color 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
}

html[data-xiaoli-ios-theme="true"] .button:active:not(:disabled) {
  transform: scale(0.985);
}

html[data-xiaoli-ios-theme="true"] .button:disabled {
  cursor: not-allowed;
  box-shadow: none;
  opacity: 0.5;
}

html[data-xiaoli-ios-theme="true"] .button-primary {
  color: var(--navy);
  background: linear-gradient(180deg, #e6b366 0%, #d99a3d 100%);
  border-color: rgba(164, 104, 24, 0.32);
  box-shadow: 0 6px 16px rgba(189, 127, 38, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.4);
}

html[data-xiaoli-ios-theme="true"] .button-secondary {
  color: var(--navy);
  background: var(--gold-soft);
  border-color: rgba(217, 154, 61, 0.35);
}

html[data-xiaoli-ios-theme="true"] .button-quiet {
  color: var(--navy-soft);
  background: rgba(255, 255, 255, 0.3);
  border-color: rgba(20, 33, 61, 0.18);
  box-shadow: none;
}

html[data-xiaoli-ios-theme="true"] .app-header .button-quiet {
  min-height: 2.55rem;
  padding: 0.6rem 0.8rem;
  color: #fffdf8;
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.22);
}

html[data-xiaoli-ios-theme="true"] .form-message {
  min-height: 1.35rem;
  margin: 0;
  color: var(--success);
  font-size: 0.84rem;
  line-height: 1.45;
}

html[data-xiaoli-ios-theme="true"] .error-message,
html[data-xiaoli-ios-theme="true"] .form-message[data-kind="error"],
html[data-xiaoli-ios-theme="true"] .activity-status[data-kind="error"] {
  color: var(--danger);
}

html[data-xiaoli-ios-theme="true"] .dashboard {
  display: grid;
  gap: 1rem;
}

html[data-xiaoli-ios-theme="true"] .section-title-row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 0.9rem;
  margin-bottom: 1rem;
}

html[data-xiaoli-ios-theme="true"] .section-title-row .button {
  flex: none;
}

html[data-xiaoli-ios-theme="true"] .metric-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.7rem;
}

html[data-xiaoli-ios-theme="true"] .metric-card {
  min-width: 0;
  padding: 0.95rem;
  color: var(--navy);
  background: var(--surface-strong);
  border: 1px solid var(--line);
  border-radius: 1rem;
  box-shadow: 0 3px 10px rgba(20, 33, 61, 0.045);
}

html[data-xiaoli-ios-theme="true"] .metric-card:first-child {
  grid-column: 1 / -1;
  color: var(--navy);
  background: linear-gradient(135deg, #f6e8cf 0%, #fffaf0 100%);
  border-color: rgba(217, 154, 61, 0.32);
}

html[data-xiaoli-ios-theme="true"] .metric-card span {
  display: block;
  margin-bottom: 0.36rem;
  color: var(--ink-muted);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.02em;
}

html[data-xiaoli-ios-theme="true"] .metric-card strong {
  display: block;
  color: var(--navy);
  font-size: clamp(1rem, 4vw, 1.16rem);
  font-weight: 800;
  line-height: 1.28;
  overflow-wrap: anywhere;
}

html[data-xiaoli-ios-theme="true"] .metric-card:first-child strong {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  color: var(--navy);
}

html[data-xiaoli-ios-theme="true"] .metric-card:first-child strong::before {
  width: 0.62rem;
  height: 0.62rem;
  flex: none;
  content: "";
  background: var(--gold);
  border: 2px solid #fffdf8;
  border-radius: 50%;
  box-shadow: 0 0 0 3px rgba(217, 154, 61, 0.2);
}

html[data-xiaoli-ios-theme="true"] .device-list {
  display: grid;
  gap: 0.9rem;
}

html[data-xiaoli-ios-theme="true"] .device-card {
  padding: 1rem;
  background: var(--surface-strong);
  border: 1px solid var(--line);
  border-radius: 1.1rem;
  box-shadow: 0 5px 18px rgba(20, 33, 61, 0.055);
}

html[data-xiaoli-ios-theme="true"] .device-header,
html[data-xiaoli-ios-theme="true"] .device-action-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

html[data-xiaoli-ios-theme="true"] .device-header h3 {
  margin: 0;
  color: var(--navy);
  font-size: 1.08rem;
  font-weight: 780;
  letter-spacing: -0.02em;
  overflow-wrap: anywhere;
}

html[data-xiaoli-ios-theme="true"] .badge {
  display: inline-flex;
  align-items: center;
  gap: 0.38rem;
  flex: none;
  min-height: 1.65rem;
  padding: 0.3rem 0.62rem;
  color: #76511c;
  background: var(--gold-soft);
  border: 1px solid rgba(217, 154, 61, 0.28);
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 800;
}

html[data-xiaoli-ios-theme="true"] .badge::before {
  width: 0.42rem;
  height: 0.42rem;
  flex: none;
  content: "";
  background: currentColor;
  border-radius: 50%;
  opacity: 0.78;
}

html[data-xiaoli-ios-theme="true"] .badge[data-online="true"] {
  color: var(--success);
  background: var(--success-soft);
  border-color: rgba(47, 118, 100, 0.24);
}

html[data-xiaoli-ios-theme="true"] .case-meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.65rem;
  margin: 0.95rem 0;
}

html[data-xiaoli-ios-theme="true"] .case-meta div {
  min-width: 0;
  padding: 0.76rem;
  background: var(--ivory);
  border: 1px solid rgba(20, 33, 61, 0.07);
  border-radius: 0.82rem;
}

html[data-xiaoli-ios-theme="true"] .case-meta dt {
  color: var(--ink-muted);
  font-size: 0.69rem;
  font-weight: 700;
}

html[data-xiaoli-ios-theme="true"] .case-meta dd {
  margin: 0.22rem 0 0;
  color: var(--navy);
  font-size: 0.88rem;
  font-weight: 760;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

html[data-xiaoli-ios-theme="true"] .speaker-grid {
  display: grid;
  gap: 0.7rem;
  margin-bottom: 0.95rem;
}

html[data-xiaoli-ios-theme="true"] .speaker-card {
  min-width: 0;
  padding: 0.9rem;
  background: #fcfaf5;
  border: 1px solid var(--line);
  border-radius: 0.92rem;
}

html[data-xiaoli-ios-theme="true"] .speaker-card[data-speaker="A"] {
  background: linear-gradient(90deg, rgba(20, 33, 61, 0.055), transparent 70%);
  border-left: 0.28rem solid var(--navy);
}

html[data-xiaoli-ios-theme="true"] .speaker-card[data-speaker="B"] {
  background: linear-gradient(90deg, rgba(217, 154, 61, 0.1), transparent 70%);
  border-left: 0.28rem solid var(--gold);
}

html[data-xiaoli-ios-theme="true"] .speaker-card h4 {
  margin: 0 0 0.48rem;
  color: var(--navy);
  font-size: 0.86rem;
  font-weight: 780;
}

html[data-xiaoli-ios-theme="true"] .transcript {
  margin: 0;
  color: #44506a;
  font-size: 0.88rem;
  line-height: 1.65;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

html[data-xiaoli-ios-theme="true"] .device-hint {
  margin: 0;
  color: var(--ink-muted);
  font-size: 0.78rem;
  line-height: 1.5;
}

html[data-xiaoli-ios-theme="true"] .empty-state {
  margin: 0;
  padding: 1.35rem 1rem;
  color: var(--ink-muted);
  text-align: center;
  background: var(--ivory);
  border: 1px dashed rgba(20, 33, 61, 0.16);
  border-radius: 0.95rem;
}

html[data-xiaoli-ios-theme="true"] .voice-form {
  gap: 1rem;
}

html[data-xiaoli-ios-theme="true"] .field-group {
  display: grid;
  gap: 0.52rem;
}

html[data-xiaoli-ios-theme="true"] .range-field {
  padding: 0.92rem 0 0.65rem;
  border-top: 1px solid var(--line);
}

html[data-xiaoli-ios-theme="true"] .range-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.62rem;
}

html[data-xiaoli-ios-theme="true"] .range-label output {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 2.75rem;
  min-height: 1.7rem;
  padding: 0.2rem 0.5rem;
  color: var(--navy);
  background: var(--gold-soft);
  border-radius: 999px;
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
  font-weight: 800;
  text-align: center;
}

html[data-xiaoli-ios-theme="true"] input[type="range"] {
  width: 100%;
  height: 2.2rem;
  margin: 0;
  background: transparent;
  accent-color: var(--gold);
  appearance: none;
  -webkit-appearance: none;
}

html[data-xiaoli-ios-theme="true"] input[type="range"]::-webkit-slider-runnable-track {
  height: 0.42rem;
  background: linear-gradient(90deg, rgba(217, 154, 61, 0.5), var(--ivory-deep));
  border: 1px solid rgba(20, 33, 61, 0.08);
  border-radius: 999px;
}

html[data-xiaoli-ios-theme="true"] input[type="range"]::-webkit-slider-thumb {
  width: 1.45rem;
  height: 1.45rem;
  margin-top: -0.58rem;
  background: #fffdf8;
  border: 0.14rem solid var(--gold);
  border-radius: 50%;
  box-shadow: 0 2px 7px rgba(20, 33, 61, 0.18);
  appearance: none;
  -webkit-appearance: none;
}

html[data-xiaoli-ios-theme="true"] input[type="range"]:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 4px rgba(217, 154, 61, 0.18), 0 2px 7px rgba(20, 33, 61, 0.18);
}

html[data-xiaoli-ios-theme="true"] .activity-status {
  min-height: 1.4rem;
  margin: 0.9rem 0 0;
  color: var(--ink-muted);
  font-size: 0.8rem;
  text-align: center;
}

html[data-xiaoli-ios-theme="true"] .app-footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.55rem 1rem;
  padding:
    0
    max(1rem, env(safe-area-inset-right))
    max(1.5rem, env(safe-area-inset-bottom))
    max(1rem, env(safe-area-inset-left));
  color: var(--ink-muted);
  font-size: 0.74rem;
  line-height: 1.45;
  text-align: center;
}

html[data-xiaoli-ios-theme="true"] a[href*=".apk" i],
html[data-xiaoli-ios-theme="true"] .download-link {
  display: none !important;
}

@media (hover: hover) and (pointer: fine) {
  html[data-xiaoli-ios-theme="true"] .button-primary:not(:disabled):hover {
    background: linear-gradient(180deg, #e9bb72 0%, #d39332 100%);
    box-shadow: 0 7px 19px rgba(189, 127, 38, 0.26), inset 0 1px 0 rgba(255, 255, 255, 0.46);
  }

  html[data-xiaoli-ios-theme="true"] .button-secondary:not(:disabled):hover,
  html[data-xiaoli-ios-theme="true"] .button-quiet:not(:disabled):hover {
    border-color: rgba(217, 154, 61, 0.48);
  }
}

@media (min-width: 44rem) {
  html[data-xiaoli-ios-theme="true"] .page-shell {
    padding-top: 1.5rem;
  }

  html[data-xiaoli-ios-theme="true"] .panel,
  html[data-xiaoli-ios-theme="true"] .status-overview {
    padding: 1.5rem;
  }

  html[data-xiaoli-ios-theme="true"] .metric-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  html[data-xiaoli-ios-theme="true"] .metric-card:first-child {
    grid-column: auto;
  }

  html[data-xiaoli-ios-theme="true"] .speaker-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  html[data-xiaoli-ios-theme="true"] .voice-form {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    column-gap: 1.2rem;
  }

  html[data-xiaoli-ios-theme="true"] .voice-name-field,
  html[data-xiaoli-ios-theme="true"] .voice-form .form-message,
  html[data-xiaoli-ios-theme="true"] .voice-form .button {
    grid-column: 1 / -1;
  }
}

@media (max-width: 43.99rem) {
  html[data-xiaoli-ios-theme="true"] .device-action-row {
    align-items: stretch;
    flex-direction: column;
  }

  html[data-xiaoli-ios-theme="true"] .device-action-row .button {
    width: 100%;
  }
}

@media (min-width: 66rem) {
  html[data-xiaoli-ios-theme="true"] .dashboard {
    grid-template-columns: minmax(0, 1.65fr) minmax(19rem, 0.8fr);
    align-items: start;
  }

  html[data-xiaoli-ios-theme="true"] .status-overview {
    grid-column: 1 / -1;
  }

  html[data-xiaoli-ios-theme="true"] .voice-panel {
    position: sticky;
    top: 6.4rem;
  }

  html[data-xiaoli-ios-theme="true"] .voice-form {
    grid-template-columns: 1fr;
  }

  html[data-xiaoli-ios-theme="true"] .voice-name-field,
  html[data-xiaoli-ios-theme="true"] .voice-form .form-message,
  html[data-xiaoli-ios-theme="true"] .voice-form .button {
    grid-column: auto;
  }
}

@media (max-width: 23rem) {
  html[data-xiaoli-ios-theme="true"] .section-title-row {
    align-items: stretch;
    flex-direction: column;
  }

  html[data-xiaoli-ios-theme="true"] .section-title-row .button {
    width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  html[data-xiaoli-ios-theme="true"],
  html[data-xiaoli-ios-theme="true"] *,
  html[data-xiaoli-ios-theme="true"] *::before,
  html[data-xiaoli-ios-theme="true"] *::after {
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
  }
}
`;

export const WEBVIEW_THEME_SCRIPT = `
(() => {
  const STYLE_ID = 'xiaoli-ios-webview-theme';
  const STATE_KEY = '__xiaoliIosWebViewThemeState';
  const THEME_CSS = ${JSON.stringify(WEBVIEW_THEME_CSS)};

  const state = window[STATE_KEY] || {
    cssApplied: false,
    observer: null,
    retryTimer: null,
  };
  window[STATE_KEY] = state;

  const removeApkLinks = () => {
    document.querySelectorAll('a[href]').forEach((link) => {
      const href = link.getAttribute('href') || '';
      if (/\\.apk(?:[?#]|$)/i.test(href)) {
        link.remove();
      }
    });
  };

  const splitCssRules = (css) => {
    const rules = [];
    let start = 0;
    let depth = 0;
    let quote = '';
    let escaped = false;
    let inComment = false;

    for (let index = 0; index < css.length; index += 1) {
      const character = css[index];
      const nextCharacter = css[index + 1];

      if (inComment) {
        if (character === '*' && nextCharacter === '/') {
          inComment = false;
          index += 1;
        }
        continue;
      }

      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\\\') {
          escaped = true;
        } else if (character === quote) {
          quote = '';
        }
        continue;
      }

      if (character === '/' && nextCharacter === '*') {
        inComment = true;
        index += 1;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '{') {
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          const rule = css.slice(start, index + 1).trim();
          if (rule) rules.push(rule);
          start = index + 1;
        }
      }
    }

    return rules;
  };

  const installWithCssom = () => {
    const rules = splitCssRules(THEME_CSS);
    const styleSheets = Array.from(document.styleSheets).sort((left, right) => {
      const leftIsMobileStyles = /\\/styles\\.css(?:[?#]|$)/i.test(left.href || '');
      const rightIsMobileStyles = /\\/styles\\.css(?:[?#]|$)/i.test(right.href || '');
      return Number(rightIsMobileStyles) - Number(leftIsMobileStyles);
    });

    for (const styleSheet of styleSheets) {
      let inserted = 0;
      try {
        void styleSheet.cssRules;
      } catch {
        continue;
      }

      for (const rule of rules) {
        try {
          styleSheet.insertRule(rule, styleSheet.cssRules.length);
          inserted += 1;
        } catch {
          // Keep installing supported rules when an older WebKit rejects one selector.
        }
      }

      if (inserted > 0) {
        return true;
      }
    }

    return false;
  };

  const installThemeCss = () => {
    if (state.cssApplied) return true;

    const existingStyle = document.getElementById(STYLE_ID);
    if (existingStyle && existingStyle.sheet) {
      state.cssApplied = true;
      return true;
    }
    if (existingStyle) existingStyle.remove();

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.setAttribute('data-xiaoli-theme', 'ios');
    style.textContent = THEME_CSS;
    (document.head || document.documentElement).append(style);

    if (style.sheet) {
      state.cssApplied = true;
      return true;
    }

    style.remove();
    state.cssApplied = installWithCssom();
    return state.cssApplied;
  };

  const applyTheme = () => {
    const root = document.documentElement;
    if (!root) return;

    if (root.dataset.xiaoliIosTheme !== 'true') {
      root.dataset.xiaoliIosTheme = 'true';
    }

    removeApkLinks();
    installThemeCss();
  };

  applyTheme();

  if (!state.observer && document.documentElement) {
    state.observer = new MutationObserver(applyTheme);
    state.observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['href'],
      childList: true,
      subtree: true,
    });
  }

  if (!state.cssApplied && !state.retryTimer) {
    state.retryTimer = window.setTimeout(() => {
      state.retryTimer = null;
      applyTheme();
    }, 50);
  }
})();
true;
`;
