# Unified Download Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the separate "Download PNG" and "Record WEBM" buttons with a single "Download" button that exports PNG for static images, and MP4 (via WebCodecs + mp4-muxer) for GIF, video, and demo sources — with auto-timed, zero-click export.

**Architecture:** All code lives in `index.html` (one inline `<script type="module">` block). The download button dispatches to one of four paths based on `activeSource`, `activeGif`, and `activeMedia`. GIF export iterates `activeGif[]` frames entirely off-screen (fast, no rAF involvement). Video and demo recording hook into the existing `loop()` rAF callback and auto-stop at known durations. Shared encoder helpers set up and tear down `VideoEncoder` + `mp4-muxer` for all three MP4 paths.

**Tech Stack:** Native WebCodecs `VideoEncoder` API (Chrome 94+, Firefox 130+, Safari 16.4+), `mp4-muxer@5` (CDN ESM import), vanilla JS ES module in a single HTML file. All code changes via Codex CLI.

---

### Task 1: Add mp4-muxer import

**Files:**
- Modify: `index.html` — `<script type="module">` import block (~line 201)

- [ ] **Step 1: Add mp4-muxer to the existing import block**

```bash
codex "In index.html, find the existing import statement at the top of the <script type=\"module\"> block:
  import { parseGIF, decompressFrames } from 'https://cdn.jsdelivr.net/npm/gifuct-js@2.1.2/+esm';
Add a second import on the next line:
  import { Muxer, ArrayBufferTarget } from 'https://cdn.jsdelivr.net/npm/mp4-muxer@5/+esm';"
```

- [ ] **Step 2: Verify in browser**

Open `index.html` in Chrome. Open DevTools console. Confirm no import or network errors on load.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: import mp4-muxer for MP4 export"
```

---

### Task 2: Replace buttons in HTML and remove old recording code

**Files:**
- Modify: `index.html` — HTML button elements (~line 178-179), JS state variables (~line 299-301), `recordButton` event listener (~lines 607-649)

- [ ] **Step 1: Update HTML buttons**

```bash
codex "In index.html, in the <aside> controls section:
1. Find the button with id='download-frame' and text content 'Download PNG'. Change its text content to 'Download'. Keep the id unchanged.
2. Remove the button with id='record-output' and text 'Record WEBM' entirely."
```

- [ ] **Step 2: Remove old recording state and handler**

```bash
codex "In index.html, in the <script type=\"module\"> block:
1. Remove these variable declarations: let mediaRecorder = null; let recordedChunks = []; let isRecording = false;
2. Remove the line: const recordButton = document.getElementById('record-output');
3. Remove the entire recordButton.addEventListener('click', ...) handler block and its contents."
```

- [ ] **Step 3: Verify in browser**

Open `index.html`. Confirm only one button labeled "Download" appears in the sidebar. Confirm no JS errors in console. Confirm clicking Download still triggers a PNG download (existing handler still in place).

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: replace two export buttons with single Download button, remove WEBM recorder"
```

---

### Task 3: Add export state and shared MP4 encode helpers

**Files:**
- Modify: `index.html` — state variables block and helper functions section

- [ ] **Step 1: Add export state variables**

```bash
codex "In index.html, in the <script type=\"module\"> block, after the line 'let gifFrameTime = null;', add:

let isExporting = false;
let exportState = null;  // { encoder, muxer, filename, frameIndex, startTime, type, done }"
```

- [ ] **Step 2: Add startMp4Encoder helper**

```bash
codex "In index.html, after the setStatus helper function, add:

const startMp4Encoder = (filename) => {
    const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: 'avc', width: outputCanvas.width, height: outputCanvas.height }
    });
    const encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (e) => {
            setStatus('Encoding error: ' + e.message);
            isExporting = false;
            exportState = null;
            downloadButton.disabled = false;
            downloadButton.textContent = 'Download';
        }
    });
    encoder.configure({
        codec: 'avc1.42001f',
        width: outputCanvas.width,
        height: outputCanvas.height,
        bitrate: 8_000_000,
        framerate: 60
    });
    return { encoder, muxer, filename, frameIndex: 0, startTime: null, type: null, done: false };
};"
```

- [ ] **Step 3: Add encodeOutputFrame helper**

```bash
codex "In index.html, after the startMp4Encoder function, add:

const encodeOutputFrame = (state, timestampMicros, durationMicros) => {
    const frame = new VideoFrame(outputCanvas, { timestamp: timestampMicros, duration: durationMicros });
    state.encoder.encode(frame, { keyFrame: state.frameIndex % 60 === 0 });
    frame.close();
    state.frameIndex++;
};"
```

- [ ] **Step 4: Add finalizeMp4Export helper**

```bash
codex "In index.html, after the encodeOutputFrame function, add:

const finalizeMp4Export = async (state) => {
    await state.encoder.flush();
    state.muxer.finalize();
    const blob = new Blob([state.muxer.target.buffer], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = state.filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    isExporting = false;
    exportState = null;
    downloadButton.disabled = false;
    downloadButton.textContent = 'Download';
    setStatus('Saved: ' + state.filename);
};"
```

- [ ] **Step 5: Add canExportMp4 capability check**

```bash
codex "In index.html, after the finalizeMp4Export function, add:

const canExportMp4 = () => {
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
        setStatus('MP4 export requires Chrome 94+, Firefox 130+, or Safari 16.4+.');
        return false;
    }
    return true;
};"
```

- [ ] **Step 6: Verify in browser**

Open DevTools console. Confirm no syntax errors on load. Download button should still work for PNG.

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat: add shared MP4 encode helpers (startMp4Encoder, encodeOutputFrame, finalizeMp4Export)"
```

---

### Task 4: Implement GIF → MP4 off-screen export

**Files:**
- Modify: `index.html` — add `exportGif` function after `canExportMp4`

- [ ] **Step 1: Add exportGif function**

```bash
codex "In index.html, after the canExportMp4 function, add:

const exportGif = async (filename) => {
    if (!canExportMp4() || !activeGif || activeGif.length === 0) return;
    isExporting = true;
    downloadButton.disabled = true;
    downloadButton.textContent = 'Encoding…';
    setStatus('Encoding GIF to MP4…');

    const savedFrameIndex = gifFrameIndex;
    const savedFrameTime = gifFrameTime;
    const state = startMp4Encoder(filename);

    let syntheticTime = 0;
    let cumulativeMicros = 0;

    for (let i = 0; i < activeGif.length; i++) {
        const gifFrame = activeGif[i];
        mediaCtx.putImageData(gifFrame.imageData, 0, 0);
        crt.render(syntheticTime);
        const durationMicros = gifFrame.delay * 1000;
        encodeOutputFrame(state, cumulativeMicros, durationMicros);
        cumulativeMicros += durationMicros;
        syntheticTime += gifFrame.delay;
        downloadButton.textContent = 'Encoding… ' + Math.round((i + 1) / activeGif.length * 100) + '%';
    }

    gifFrameIndex = savedFrameIndex;
    gifFrameTime = savedFrameTime;

    await finalizeMp4Export(state);
};"
```

- [ ] **Step 2: Smoke-test in browser console**

Upload an animated GIF. Switch to Uploaded Media source. In DevTools console run:
```js
exportGif('test-crt.mp4')
```
Confirm button shows progress then resets. File downloads. Open the MP4 — it should show the CRT-processed GIF loop with correct frame timing.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: implement GIF to MP4 off-screen export"
```

---

### Task 5: Modify rAF loop and implement video → MP4 export

**Files:**
- Modify: `index.html` — modify `loop()` function, add `exportVideo` function

- [ ] **Step 1: Add frame capture block to rAF loop**

```bash
codex "In index.html, find the loop function. After the line 'crt.render(time);' and before 'requestAnimationFrame(loop);', add:

    if (exportState && !exportState.done) {
        if (exportState.startTime === null) exportState.startTime = time;
        const elapsed = time - exportState.startTime;
        const timestampMicros = exportState.type === 'video'
            ? Math.round(sourceVideo.currentTime * 1_000_000)
            : Math.round(elapsed * 1000);
        encodeOutputFrame(exportState, timestampMicros, 16667);

        if (exportState.type === 'video') {
            const progress = Math.min(sourceVideo.currentTime / sourceVideo.duration, 1);
            downloadButton.textContent = 'Encoding… ' + Math.round(progress * 100) + '%';
            setStatus('Recording video: ' + sourceVideo.currentTime.toFixed(1) + 's / ' + sourceVideo.duration.toFixed(1) + 's');
            if (sourceVideo.currentTime >= sourceVideo.duration - 0.1) {
                exportState.done = true;
                finalizeMp4Export(exportState);
            }
        } else if (exportState.type === 'demo') {
            const progress = Math.min(elapsed / 8000, 1);
            downloadButton.textContent = 'Encoding… ' + Math.round(progress * 100) + '%';
            setStatus('Recording demo: ' + (elapsed / 1000).toFixed(1) + 's / 8s');
            if (elapsed >= 8000) {
                exportState.done = true;
                finalizeMp4Export(exportState);
            }
        }
    }"
```

- [ ] **Step 2: Add exportVideo function**

```bash
codex "In index.html, after the exportGif function, add:

const exportVideo = (filename) => {
    if (!canExportMp4()) return;
    isExporting = true;
    downloadButton.disabled = true;
    downloadButton.textContent = 'Encoding…';
    setStatus('Seeking to start of video…');
    sourceVideo.currentTime = 0;
    sourceVideo.addEventListener('seeked', () => {
        const state = startMp4Encoder(filename);
        state.type = 'video';
        exportState = state;
        setStatus('Recording video — one full loop…');
    }, { once: true });
};"
```

- [ ] **Step 3: Smoke-test in browser console**

Upload an MP4. Switch to Uploaded Media source. In DevTools console run:
```js
exportVideo('test-video-crt.mp4')
```
Confirm progress increments and file downloads after one full loop. Confirm the downloaded MP4 duration matches the source.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: implement video to MP4 rAF-hooked export with auto-stop after one loop"
```

---

### Task 6: Implement demo → MP4 export

**Files:**
- Modify: `index.html` — add `exportDemo` function

- [ ] **Step 1: Add exportDemo function**

```bash
codex "In index.html, after the exportVideo function, add:

const exportDemo = (filename) => {
    if (!canExportMp4()) return;
    isExporting = true;
    downloadButton.disabled = true;
    downloadButton.textContent = 'Encoding… 0%';
    setStatus('Recording Shadertoy demo — 8 seconds…');
    const state = startMp4Encoder(filename);
    state.type = 'demo';
    exportState = state;
};"
```

- [ ] **Step 2: Smoke-test in browser console**

With the Shadertoy scene active, in DevTools console run:
```js
exportDemo('test-demo-crt.mp4')
```
Confirm progress increments from 0% to 100% over ~8 seconds, then file downloads. Confirm the MP4 is ~8 seconds long.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: implement demo scene 8-second MP4 export"
```

---

### Task 7: Wire up the unified download button click handler

**Files:**
- Modify: `index.html` — replace existing `downloadButton.addEventListener('click', ...)` handler

- [ ] **Step 1: Replace download button click handler**

```bash
codex "In index.html, find the existing downloadButton.addEventListener('click', ...) handler and replace it entirely with:

downloadButton.addEventListener('click', () => {
    if (isExporting) return;

    const slug = (activeSource === 'demo'
        ? 'shadertoy-scene'
        : ((activeMedia && activeMedia.dataset.label) || (activeGif ? 'animated' : 'crt-output'))
            .toLowerCase()
            .replace(/\.[^/.]+$/, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')) || 'crt-output';

    if (activeSource === 'demo') {
        exportDemo(slug + '-crt.mp4');
        return;
    }

    if (activeGif) {
        exportGif(slug + '-crt.mp4');
        return;
    }

    if (activeMedia === sourceVideo) {
        exportVideo(slug + '-crt.mp4');
        return;
    }

    // Static image — PNG
    requestAnimationFrame(() => {
        outputCanvas.toBlob((blob) => {
            if (!blob) {
                setStatus('Unable to export PNG from the current frame.');
                return;
            }
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = slug + '-crt.png';
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }, 'image/png');
    });
});"
```

- [ ] **Step 2: Full end-to-end browser test — all four paths**

Test each case:

1. **Demo → MP4**: Default Shadertoy scene, click Download. Progress shows 0%→100% over ~8s. `shadertoy-scene-crt.mp4` downloads and plays for 8 seconds with CRT effects.

2. **Static image → PNG**: Upload a JPEG (not a GIF). Click Download. PNG downloads immediately. Filename is `<slug>-crt.png`.

3. **GIF → MP4**: Upload an animated GIF. Source switches to Uploaded Media. Click Download. Button shows "Encoding… N%" briefly then resets. `<slug>-crt.mp4` downloads and plays the CRT-processed GIF loop with correct timing.

4. **Video → MP4**: Upload an MP4. Click Download. Progress increments over the video's duration. `<slug>-crt.mp4` downloads and duration matches the source.

5. **Guard**: During any MP4 export, click Download again. Confirm nothing happens (guarded by `isExporting`).

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: wire unified Download button — PNG for static, MP4 for GIF/video/demo"
```
