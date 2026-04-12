# GIF Shader Pipeline — Design Spec
**Date:** 2026-04-11

## Problem

Animated GIFs uploaded to the CRT shader tool animate but with jitter. The root cause: the browser advances GIF frames on its own internal timer, while the rAF render loop captures via `drawImage` at 60fps regardless. The two clocks are unsynced, producing duplicate or dropped frames.

## Solution

Use `gifuct-js` to decode GIF frames in JavaScript and own the frame clock ourselves. Each GIF frame becomes a pre-composited `ImageData`; the render loop advances the frame index based on elapsed time and per-frame delay metadata from the GIF.

## Architecture

No new files. All changes are in `index.html`.

### New CDN dependency

```html
<script src="https://cdn.jsdelivr.net/npm/gifuct-js@2.1.2/dist/gifuct-js.min.js"></script>
```

Added alongside the existing Tweakpane CDN script.

### New state variables

```js
let activeGif = null;        // array of { imageData, delay } decoded frames, or null
let gifFrameIndex = 0;       // current frame index
let gifFrameTime = 0;        // rAF timestamp when current frame started
```

### Detection & loading (file input handler)

Add a GIF branch before the existing image branch:

```
if (file.type === 'image/gif')       → GIF decode path
else if (file.type.startsWith('video/'))  → existing video path
else if (file.type.startsWith('image/'))  → existing static image path
```

In the GIF path:
1. `file.arrayBuffer()` → `gifuct-js.parseGIF()` → `gifuct-js.decompressFrames(gif, true)`
2. Composite each frame patch onto a persistent offscreen canvas (GIFs use delta-patching)
3. Snapshot each fully-composited frame as `ImageData` via `getImageData`
4. Store as `activeGif = [{ imageData, delay }, ...]`
5. Initialize `gifFrameIndex = 0`, `gifFrameTime = 0` (set on first render tick)
6. Call `useUploadedSource()` — routes `mediaCanvas` into the CRT pipeline

`activeMedia` stays `null` for GIFs (it's only used for `<img>` and `<video>` references).

### Render loop

Existing loop checks for GIF alongside video and image:

```js
if (activeMedia === sourceVideo && sourceVideo.readyState >= 2) {
    drawMediaToCanvas();
} else if (activeGif) {
    drawGifFrameToCanvas(time);
} else if (activeMedia === sourceImage) {
    drawMediaToCanvas();
}
```

`drawGifFrameToCanvas(time)`:
- On first call (`gifFrameTime === 0`), initialize `gifFrameTime = time`
- Compute `elapsed = time - gifFrameTime`
- If `elapsed >= activeGif[gifFrameIndex].delay`, advance frame index (wrap around), subtract consumed delay from elapsed, update `gifFrameTime`
- `putImageData(activeGif[gifFrameIndex].imageData, 0, 0)` onto `mediaCanvas` only when frame changes

### Cleanup

`clearCurrentMedia()` gains: `activeGif = null; gifFrameIndex = 0; gifFrameTime = 0;`

## UX

- File input `accept="image/*,video/*"` — GIFs already accepted, no change needed
- Status messages: `"Loading GIF: filename.gif"` → `"Showing GIF: filename.gif (N frames)"`
- On decode failure: fall back to static `<img>` path with a status warning
- GIF loops automatically (same as `<video loop>`)
- No new UI controls

## Out of scope

- GIF-to-MP4 conversion (not needed — direct decode is simpler and sufficient)
- Disposal method handling beyond "restore to background color" (covers the vast majority of real-world GIFs)
