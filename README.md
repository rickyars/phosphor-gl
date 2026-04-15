# CRT Shader Demo

A browser-based WebGL2 CRT post-process demo with one shared renderer and two source modes: a built-in procedural scene and uploaded image, GIF, or video media.

## Files

- [`CRTShader.js`](CRTShader.js): the reusable CRT renderer, including mask, bloom, tone, and blue-noise flavor passes
- [`ShadertoyScene.js`](ShadertoyScene.js): the procedural source scene used by the demo mode
- [`index.html`](index.html): the single-page demo UI, media loader, presets, and Tweakpane controls

## Controls

- source: switch between the built-in Shadertoy-style scene and uploaded media
- screen: curvature and vignette
- bloom: radius, glow, and base
- mask: intensity, size, border, mode, triad offset, and aberration
- tone: exposure, pulse animation, and optional display gamma
- flavor: signal waver, phosphor flicker, and scanline shimmer for extra analog instability

## Presets

- `Default`: the more stylized CRT look with a larger mask, stronger bloom, and visibly unstable blue-noise flavor motion
- `Text Friendly`: a tighter row-mask setup tuned for terminal text and UI readability, with a lighter dose of flavor noise

## Interaction

- drag on the output canvas to pan
- use the mouse wheel to zoom toward the pointer
- press `Space` or `R` to reset the view
- upload an image, GIF, or video, then switch the source selector to preview it through the same CRT pass
- click **Download** to export the current output:
  - **Shadertoy demo** → 8-second MP4 captured at the current settings
  - **Animated GIF** → full GIF re-rendered frame-by-frame and saved as MP4
  - **Video** → one full playback loop captured to MP4
  - **Static image** → PNG snapshot of the current frame

## Notes

- The strongest CRT character still comes from the mask, bloom, curvature, vignette, aberration, and tone controls.
- The `Flavor` group uses temporal blue noise. `Signal Waver` jitters rows horizontally, `Phosphor Flicker` modulates phosphor-cell brightness through the mask, and `Scanline Shimmer` adds row-level interlace-style brightness variation.
- `Triad Offset` disables itself whenever `Mask Mode` is set to `Row`, so the pane matches what the shader is actually using.
- MP4 export uses the WebCodecs API (`VideoEncoder`/`VideoFrame`) and requires Chrome 94+, Firefox 130+, or Safari 16.4+.
