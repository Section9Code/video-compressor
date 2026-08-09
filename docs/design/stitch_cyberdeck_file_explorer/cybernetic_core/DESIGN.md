---
name: Cybernetic Core
colors:
  surface: '#131315'
  surface-dim: '#131315'
  surface-bright: '#39393b'
  surface-container-lowest: '#0e0e10'
  surface-container-low: '#1c1b1d'
  surface-container: '#201f21'
  surface-container-high: '#2a2a2c'
  surface-container-highest: '#353437'
  on-surface: '#e5e1e4'
  on-surface-variant: '#b9cacb'
  inverse-surface: '#e5e1e4'
  inverse-on-surface: '#313032'
  outline: '#849495'
  outline-variant: '#3a494b'
  surface-tint: '#00dbe7'
  primary: '#e1fdff'
  on-primary: '#00363a'
  primary-container: '#00f2ff'
  on-primary-container: '#006a71'
  inverse-primary: '#00696f'
  secondary: '#fface8'
  on-secondary: '#5e0053'
  secondary-container: '#ff24e4'
  on-secondary-container: '#520049'
  tertiary: '#e4ffd6'
  on-tertiary: '#053900'
  tertiary-container: '#34fc0d'
  on-tertiary-container: '#106f00'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#74f5ff'
  primary-fixed-dim: '#00dbe7'
  on-primary-fixed: '#002022'
  on-primary-fixed-variant: '#004f54'
  secondary-fixed: '#ffd7f0'
  secondary-fixed-dim: '#fface8'
  on-secondary-fixed: '#3a0033'
  on-secondary-fixed-variant: '#840076'
  tertiary-fixed: '#79ff5b'
  tertiary-fixed-dim: '#2ae500'
  on-tertiary-fixed: '#022100'
  on-tertiary-fixed-variant: '#095300'
  background: '#131315'
  on-background: '#e5e1e4'
  surface-variant: '#353437'
typography:
  headline-lg:
    fontFamily: Inter
    fontSize: 48px
    fontWeight: '800'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-lg-mobile:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '800'
    lineHeight: 40px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '700'
    lineHeight: 32px
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  data-mono:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
    letterSpacing: 0.05em
  label-caps:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '700'
    lineHeight: 16px
    letterSpacing: 0.1em
spacing:
  unit: 4px
  gutter: 16px
  margin: 24px
  container-max: 1440px
---

## Brand & Style

This design system establishes a high-fidelity cyberpunk aesthetic for modern file management. The personality is high-tech, precise, and rebellious, moving away from traditional corporate interfaces toward an immersive "hacker-terminal" experience. 

The design style is a hybrid of **Glassmorphism** and **Brutalism**. It utilizes deep obsidian surfaces to provide a high-contrast backdrop for vibrant neon accents. UI elements feature "holographic" properties: semi-transparent layers, backdrop blurs, and localized glows that suggest light emitting from the hardware itself. The visual language favors sharp geometric precision over organic softness to emphasize a technical, engineered feel.

## Colors

The palette is anchored in a dark-mode-first architecture. 

- **Base Background:** Deep Obsidian (#0a0a0c) serves as the "void" layer, ensuring maximum contrast for neon elements.
- **Electric Cyan (Primary):** Used for primary actions, active file selections, and system "ready" states.
- **Neon Magenta (Secondary):** Reserved for media files, encryption alerts, and high-energy interactions.
- **Toxic Green (Tertiary):** Dedicated to data streams, successful uploads, and system health indicators.
- **Surfaces:** All container backgrounds use a semi-transparent version of the neutral color (alpha 0.6 to 0.8) to facilitate glassmorphism.

## Typography

The typography system balances legibility with technical character. **Inter** provides the structural foundation for the UI, ensuring that complex file directories remain readable. **JetBrains Mono** is utilized for all "system metadata"—file paths, sizes, dates, and code snippets—to reinforce the developer-centric aesthetic.

Headlines should be tightly tracked and bold, mimicking high-end digital displays. Labels and metadata should always appear in monospace to suggest raw data output. For decorative elements, use the `label-caps` style to create a structured, "read-out" feel.

## Layout & Spacing

The layout follows a **fluid grid** model optimized for high-density information. The spacing rhythm is based on a strict 4px baseline grid to maintain geometric alignment.

- **Desktop:** 12-column grid with 16px gutters. Sidebars for navigation are fixed-width (280px) to simulate a persistent control panel.
- **Tablet:** 8-column grid with 16px gutters. Sidebars collapse into an overlay.
- **Mobile:** 4-column grid with 16px margins.
- **Density:** This design system supports "High Density" views by default, reducing vertical padding to fit more file entries on screen, separated by thin 1px neon borders.

## Elevation & Depth

Depth is conveyed through **backlight and transparency** rather than traditional shadows. 

1.  **The Base:** #0a0a0c background.
2.  **Surface Containers:** Translucent layers (rgba(10, 10, 12, 0.7)) with a `backdrop-filter: blur(12px)`.
3.  **Active Elevation:** Instead of a shadow, an elevated element gains a `1px` solid border using a neon accent color and a subtle `box-shadow` glow (e.g., `0 0 15px rgba(0, 242, 255, 0.3)`).
4.  **Z-Index:** Content is layered with "holographic" offsets. Modal windows should appear to float above the UI with a distinct outer glow in the primary color.

## Shapes

The shape language is strictly **geometric and sharp**. All corners are set to 0px roundedness to evoke a sense of hardware precision. 

To add visual interest, use "clipped corners" (45-degree chamfers) on primary buttons and header cards. Decorative "data brackets" (e.g., `[ ]`) should be used to frame important status indicators and file counts, reinforcing the terminal aesthetic.

## Components

- **Buttons:** Sharp corners. Primary buttons have a solid Electric Cyan background with black text. Secondary buttons are "ghost" style with a 1px neon border and an inner glow on hover.
- **Cards (File/Folder):** Translucent glass backgrounds. Selected cards feature a "glowing frame" effect using the primary accent.
- **Progress Bars:** Represented as "data streams." Use a segmented bar (small vertical blocks) rather than a solid fill. Completed segments glow in Toxic Green; active segments pulse in Electric Cyan.
- **Status Indicators:** Small "scanning" animations or flickering monospace text (e.g., `[ STATUS: ENCRYPTED ]`).
- **Input Fields:** Bottom-border only or full 1px border. On focus, the border and label glow. Use JetBrains Mono for all user input.
- **Holographic Icons:** Line-art icons with a "glitch" or "scanline" effect. Icons should use the same primary/secondary/tertiary colors based on their function (e.g., Folders = Cyan, Media = Magenta).
- **Breadcrumbs:** Use `>` or `/` separators in monospace, resembling a file directory path: `ROOT / VOL_01 / SYSTEM_FILES`.