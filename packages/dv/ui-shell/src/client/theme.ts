/**
 * The DreamVerse theme: one stylesheet that defines the `--dv-*` variables every DreamVerse package draws with, for the
 * light theme (`body`) and the dark theme (`body[data-ds-dark-theme]`, which DSH sets), and points DSH's alias
 * variables at the same values, so the DSH sidebar, right panel, composer, menus, and buttons share the DreamVerse
 * palette and its one blue accent. The selectors start with `html` so they win over DSH's own `body` and
 * `body[data-ds-dark-theme]` rules.
 *
 * @module @dv/ui-shell/theme
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'

/** The `--dv-*` variables and the DSH alias mapping. */
const DV_THEME_CSS = `
html body {
  --dv-bg: #F5F6F8;
  --dv-surface-1: #FFFFFF;
  --dv-surface-2: #FFFFFF;
  --dv-surface-3: #F0F2F5;
  --dv-surface-4: #E6E9EF;
  --dv-line: rgba(16,24,40,0.08);
  --dv-line-strong: rgba(16,24,40,0.14);
  --dv-text: #14161B;
  --dv-text-2: #5B6170;
  --dv-text-3: #8A90A0;
  --dv-accent: #2B5FF0;
  --dv-accent-hover: #2350D6;
  --dv-accent-text: #2350D6;
  --dv-accent-soft: #EAF0FF;
  --dv-ok: #15803D;
  --dv-ok-soft: #E7F6EC;
  --dv-warn: #B45309;
  --dv-danger: #DC2626;
  --dv-danger-soft: #FDF0F0;
  --dv-kind-character: #DB2777;
  --dv-kind-plan: #EA580C;
  --dv-kind-take: #0D9488;
  --dv-kind-audio: rgba(77,124,15,0.7);
  --dv-kind-audio-soft: rgba(101,163,13,0.10);
  --dv-grid: rgba(16,24,40,0.10);
  --dv-media-bg: #E9ECF1;
  --dv-overlay: rgba(20,22,27,0.18);
  --dv-shadow-1: 0 6px 18px rgba(16,24,40,0.08);
  --dv-shadow-2: 0 24px 60px rgba(16,24,40,0.18);

  --dv-font-sans: "Geist", "Inter", -apple-system, "PingFang SC", "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif;
  --dv-font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
  --dv-radius-sm: 6px;
  --dv-radius-md: 8px;
  --dv-radius-lg: 12px;
  --dv-radius-xl: 16px;
  --dv-ease: cubic-bezier(0.2, 0, 0, 1);
}

html body[data-ds-dark-theme] {
  --dv-bg: #0A0B0D;
  --dv-surface-1: #111317;
  --dv-surface-2: #171A1F;
  --dv-surface-3: #1E2228;
  --dv-surface-4: #272B33;
  --dv-line: rgba(255,255,255,0.07);
  --dv-line-strong: rgba(255,255,255,0.12);
  --dv-text: #ECEEF2;
  --dv-text-2: #A1A7B3;
  --dv-text-3: #6B7280;
  --dv-accent: #2B5FF0;
  --dv-accent-hover: #356CFF;
  --dv-accent-text: #8AB0FF;
  --dv-accent-soft: rgba(53,108,255,0.16);
  --dv-ok: #3DD68C;
  --dv-ok-soft: rgba(61,214,140,0.12);
  --dv-warn: #F5B83D;
  --dv-danger: #F2555A;
  --dv-danger-soft: rgba(242,85,90,0.10);
  --dv-kind-character: #F472B6;
  --dv-kind-plan: #FB923C;
  --dv-kind-take: #2DD4BF;
  --dv-kind-audio: rgba(163,230,53,0.75);
  --dv-kind-audio-soft: rgba(163,230,53,0.10);
  --dv-grid: rgba(255,255,255,0.06);
  --dv-media-bg: #050607;
  --dv-overlay: rgba(0,0,0,0.45);
  --dv-shadow-1: 0 8px 24px rgba(0,0,0,0.35);
  --dv-shadow-2: 0 24px 60px rgba(0,0,0,0.55);
}

/* DSH alias variables. Both selectors carry the mapping because DSH redefines every alias under
   body[data-ds-dark-theme]; the values refer to --dv-* variables, which resolve per theme on the same element. Text
   that DSH draws in its tertiary color is metadata, so it takes the secondary DreamVerse text color; the third text
   color is kept for placeholders. */
html body,
html body[data-ds-dark-theme] {
  --dsw-font-family: var(--dv-font-sans);
  --dsw-alias-bg-base: var(--dv-surface-1);
  --dsw-alias-bg-layer-1: var(--dv-surface-2);
  --dsw-alias-bg-layer-2: var(--dv-surface-2);
  --dsw-alias-bg-layer-3: var(--dv-surface-3);
  --dsw-alias-bg-overlay: var(--dv-surface-4);
  --dsw-alias-bg-mask-1: var(--dv-overlay);
  --dsw-alias-border-l1: var(--dv-line);
  --dsw-alias-border-l2: var(--dv-line);
  --dsw-alias-border-l2-darkmode-thin: var(--dv-line);
  --dsw-alias-border-l3: var(--dv-line-strong);
  --dsw-alias-border-l4: var(--dv-line-strong);
  --dsw-alias-label-primary: var(--dv-text);
  --dsw-alias-label-primary-dimmed: var(--dv-text);
  --dsw-alias-label-secondary: var(--dv-text-2);
  --dsw-alias-label-tertiary: var(--dv-text-2);
  --dsw-alias-label-caption: var(--dv-text-3);
  --dsw-alias-label-primary-foreground: #FFFFFF;
  --dsw-alias-interactive-bg-hover: var(--dv-surface-3);
  --dsw-alias-interactive-bg-hover-solid: var(--dv-surface-3);
  --dsw-alias-interactive-bg-active: var(--dv-surface-4);
  --dsw-alias-brand-primary: var(--dv-accent);
  --dsw-alias-button-primary-fill: var(--dv-accent);
  --dsw-alias-button-primary-hover: var(--dv-accent-hover);
  --dsw-alias-button-info-fill: var(--dv-accent);
  --dsw-alias-button-info-hover: var(--dv-accent-hover);
  --dsw-alias-button-elevated-fill: var(--dv-surface-2);
  --dsw-alias-button-floating-fill: var(--dv-surface-2);
  --dsw-alias-button-floating-hover: var(--dv-surface-3);
  --dsw-alias-state-business-primary: var(--dv-accent);
  --dsw-alias-state-business-tertiary: var(--dv-accent-soft);
  --dsw-alias-state-success-primary: var(--dv-ok);
  --dsw-alias-state-success-tertiary: var(--dv-ok-soft);
  --dsw-alias-state-warn-primary: var(--dv-warn);
  --dsw-alias-state-error-primary: var(--dv-danger);
  --dsw-alias-link: var(--dv-accent-text);
  --dsw-specific-input-major: var(--dv-surface-2);
  --dsw-specific-sidebar-fill: var(--dv-surface-1);
  --dsw-specific-sidebar-nav-item-hover: var(--dv-surface-3);
  --dsw-specific-sidebar-nav-item-active: var(--dv-surface-3);
  --dsw-specific-sidebar-nav-item-active-accent: var(--dv-accent-soft);
  --dsw-specific-selector: var(--dv-surface-3);
  --dsw-specific-bubble: var(--dv-surface-3);
  --dsw-specific-bubble-highlight: var(--dv-surface-4);

  background-color: var(--dv-bg);
  color: var(--dv-text);
  font-family: var(--dv-font-sans);
}
`

/**
 * Inject the DreamVerse theme stylesheet while the shell is loaded.
 * @param ctx - client root context.
 */
export function applyTheme(ctx: ClientContext): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = '@dv/ui-shell/theme'
    style.textContent = DV_THEME_CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'ui-shell: DreamVerse theme')
}
