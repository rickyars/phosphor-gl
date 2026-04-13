# Unified Download Button — Design Spec
_Date: 2026-04-12_

## Problem

The current UI has two separate export buttons:

- **Download PNG** — captures a single frame from the output canvas as a PNG.
- **Record WEBM** — manual start/stop screen recording. Output is always WebM regardless of input format, and the user must manually stop it, making the duration arbitrary.

This is inconvenient for animated sources (GIF, video) and inconsistent. The goal is a single Download button that automatically does the right thing based on the active source.

## Goals

- One download button, no manual start/stop.
- Output format matches the source type: static → PNG, animated → MP4.
- Duration is automatic: GIF exports one full loop, video exports one full loop, demo exports 8 seconds.
- All exports are 1280×720 (fixed for this proof-of-concept).

## Non-Goals

- Native input resolution export (deferred — future app version may preserve source dimensions).
- Format fidelity for GIF (GIF → GIF is skipped due to 256-color palette degradation; MP4 is used instead).
- Variable export duration or user-defined clip length.

## Output Matrix

| Source | Output format | Duration |
|---|---|---|
| Static image (PNG, JPEG, etc.) | PNG | Instant (single frame) |
| Animated GIF | MP4 (H.264, 1280×720) | One full GIF loop |
| Video (MP4, WebM, etc.) | MP4 (H.264, 1280×720) | One full video loop |
| Demo (Shadertoy scene) | MP4 (H.264, 1280×720) | 8 seconds |

## UI Changes

- Remove the "Record WEBM" button entirely.
- Rename "Download PNG" to "Download".
- During encoding: button is disabled, label reads "Encoding… N%" (video/demo) or "Encoding…" (GIF, near-instant).
- Status line provides detail (e.g. "Encoding GIF: 24/48 frames", "Recording demo: 4.2s / 8s").
- On completion: button re-enables, status shows the saved filename.

## Encoding Stack

**Dependencies:**
- `VideoEncoder` — native WebCodecs API (no import needed). Supported in Chrome 94+, Firefox 130+, Safari 16.4+.
- `mp4-muxer` — lightweight CDN import (`mp4-muxer@5`). Wraps encoded H.264 chunks into an MP4 container and outputs an `ArrayBuffer`.

**Setup per export:**
```js
const muxer = new Muxer({
  target: new ArrayBufferTarget(),
  video: { codec: 'avc', width: 1280, height: 720 }
});
const encoder = new VideoEncoder({
  output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
  error: (e) => { setStatus('Encoding error: ' + e.message); }
});
encoder.configure({
  codec: 'avc1.42001f',   // H.264 Baseline
  width: 1280,
  height: 720,
  bitrate: 8_000_000,     // 8 Mbps
  framerate: 30
});
```

**Per frame:**
```js
const frame = new VideoFrame(outputCanvas, {
  timestamp: timestampMicros,
  duration: durationMicros
});
encoder.encode(frame, { keyFrame: frameIndex % 60 === 0 });
frame.close();
```

**Finalize:**
```js
await encoder.flush();
muxer.finalize();
const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
// trigger download
```

## Per-Source Behavior

### Static Image → PNG
No change. `outputCanvas.toBlob('image/png')` → download with `-crt.png` suffix.

### GIF → MP4 (off-screen, faster than real-time)

All GIF frames are already decoded into `activeGif[]` with `{ imageData, delay }` (delay in ms). Export does not use the rAF loop:

1. Initialize encoder and muxer.
2. Iterate `activeGif[]`. For each frame `i`:
   - Draw `frame.imageData` into `mediaCanvas` via `mediaCtx.putImageData`.
   - Call `crt.render(syntheticTime)` where `syntheticTime` advances by `frame.delay` each step (in ms, converted to the same unit as the live rAF clock).
   - Capture `new VideoFrame(outputCanvas, { timestamp, duration })` where timestamp is the cumulative delay sum in microseconds.
   - `encoder.encode(frame)`, `frame.close()`.
3. `encoder.flush()`, `muxer.finalize()`, download.

The live preview canvas is unaffected. GIF state (`gifFrameIndex`, `gifFrameTime`) is saved and restored after export.

### Video → MP4 (real-time, rAF-hooked)

1. Seek video to `currentTime = 0`.
2. Set a recording flag and initialize encoder/muxer.
3. In the rAF loop, after `crt.render()`: if recording, capture a `VideoFrame` from `outputCanvas` with the current elapsed timestamp.
4. Check `sourceVideo.currentTime >= sourceVideo.duration - epsilon` (epsilon = 0.1s). If true: stop recording, finalize, download.
5. Progress: `sourceVideo.currentTime / sourceVideo.duration`.

### Demo → MP4 (real-time, rAF-hooked)

Same as video, but duration is fixed at 8000ms. Stop condition: `recordingElapsed >= 8000`.

Progress: `recordingElapsed / 8000`.

## Filename Convention

Same slug logic as today:

- Static: `<slug>-crt.png`
- Animated: `<slug>-crt.mp4`

Where `<slug>` is the uploaded filename (lowercased, extension stripped, non-alphanumeric replaced with `-`) or `shadertoy-scene` for the demo.

## Error Handling

- If `VideoEncoder` or `VideoFrame` are not available: show "Your browser does not support MP4 export. Try Chrome or Edge." and abort.
- Encoder errors surface to the status line and re-enable the button.
- If export is interrupted (e.g. user navigates away), no download is triggered.

## Out of Scope

- Audio track (the demo has no audio; video is muted for playback).
- Export at input native resolution (deferred).
- GIF re-encoding (deferred, quality concern).
