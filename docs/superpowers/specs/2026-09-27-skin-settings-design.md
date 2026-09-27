# QuotaHalo skin settings

## Goal

Give QuotaHalo a compact in-window skin selector while preserving its tray-sized layout. The default skin is low-luminance violet. Main text remains white in every skin for reliable contrast.

## Interface

The footer gains a settings button beside refresh. It opens an anchored panel above the footer with five named color swatches: Violet, Cyan, Indigo, Moss, and Amber. Selecting a swatch applies the skin immediately and closes the panel. The panel never changes the window size.

## Data and behavior

The selection is stored as a skin-name string in WebView local storage under `quota-halo-skin`. No quota data, login data, or credentials are stored. Missing or invalid values fall back to Violet. Clicking settings toggles the panel; refresh behavior remains unchanged.

## Styling

CSS variables define page background, panel gradient, borders, muted text, track, and accent color. Every theme uses a low-luminance, low-saturation dark background. Titles, quota labels, and primary text use white; accents apply only to progress, selected controls, and small highlights.

## Validation

The frontend lifecycle test verifies that theme storage fallback does not affect refresh behavior and that the three-minute poll remains registered. Rust tests continue to cover the quota protocol independently.
