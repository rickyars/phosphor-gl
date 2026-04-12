# GIF Shader Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **IMPORTANT:** All code changes MUST be made using the `codex` CLI. Do not directly edit files — issue `codex` commands with the prompts provided.

**Goal:** Decode animated GIFs in-browser using gifuct-js and drive frame advancement from the rAF render loop, eliminating the jitter caused by the browser's internal GIF animation clock.

**Architecture:** All changes are confined to `index.html`. A new `activeGif` state variable holds pre-composited per-frame `ImageData` objects extracted upfront on upload. The existing rAF loop advances the GIF frame index based on elapsed time and per-frame delay metadata, then `putImageData`s the current frame onto `mediaCanvas` only when the frame actually changes.

**Tech Stack:** gifuct-js 2.1.2 (CDN), vanilla JS, Canvas 2D API, existing CRTShader/mediaCanvas pipeline.

---

### Task 1: Add gifuct-js CDN script

**Files:**
- Modify: `index.html` (the `<head>` script block, around line 197)

- [ ] **Step 1: Add the gifuct-js script tag**

Run:
```bash
codex "In index.html, add the following script tag immediately before the existing Tweakpane CDN script tag (the line that loads tweakpane@3.1.0):

<script src=\"https://cdn.jsdelivr.net/npm/gifuct-js@2.1.2/dist/gifuct-js.min.js\"></script>

Do not change anything else."
```

Expected result — the two CDN script lines in `index.html` should now read:
```html
<script src="https://cdn.jsdelivr.net/npm/gifuct-js@2.1.2/dist/gifuct-js.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/tweakpane@3.1.0/dist/tweakpane.min.js"></script>
```

- [ ] **Step 2: Verify in browser**

Open `index.html` in a browser. Open DevTools console. Run:
```js
typeof gifuct
```
Expected: `"object"` (not `"undefined"`). If undefined, check the script tag URL and network tab for a 404.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add gifuct-js CDN dependency for GIF frame decoding"
```

---

### Task 2: Add GIF state variables and update clearCurrentMedia

**Files:**
- Modify: `index.html` (the `<script>` block inside `<body>`)

- [ ] **Step 1: Add three state variables**

Run:
```bash
codex "In index.html, inside the window load event listener, find the block of 'let' variable declarations near the top of the listener (the block that includes lines like 'let currentURL = null', 'let activeMedia = null', 'let activeSource = ...' etc). Add these three new variable declarations immediately after that block:

let activeGif = null;
let gifFrameIndex = 0;
let gifFrameTime = 0;

Do not change anything else."
```

- [ ] **Step 2: Update clearCurrentMedia to reset GIF state**

Run:
```bash
codex "In index.html, find the clearCurrentMedia function. It currently ends with these two lines before the closing brace:
    currentURL = null;
  }
  drawPlaceholder();
};

Add these three lines immediately before the drawPlaceholder() call:
    activeGif = null;
    gifFrameIndex = 0;
    gifFrameTime = 0;

Do not change anything else."
```

Expected result — `clearCurrentMedia` body should end with:
```js
if (currentURL) {
    URL.revokeObjectURL(currentURL);
    currentURL = null;
}
activeGif = null;
gifFrameIndex = 0;
gifFrameTime = 0;
drawPlaceholder();
```

- [ ] **Step 3: Verify no syntax errors**

Open `index.html` in a browser. Check the DevTools console for any JS errors. Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: add GIF playback state variables and cleanup"
```

---

### Task 3: Add GIF decode path in file upload handler

**Files:**
- Modify: `index.html` (the `fileInput.addEventListener('change', ...)` handler)

- [ ] **Step 1: Add the GIF decode branch**

Run:
```bash
codex "In index.html, find the fileInput change event listener. It currently starts with these checks after getting the file and calling clearCurrentMedia/resetView:

if (file.type.startsWith('video/')) {

Add a new branch BEFORE that video check, so the order becomes: GIF check first, then video, then image. Insert this entire block before the 'if (file.type.startsWith(\"video/\"))' line:

if (file.type === 'image/gif') {
    setStatus(\`Loading GIF: \${file.name}\`);
    const arrayBuffer = await file.arrayBuffer();
    try {
        const gif = gifuct.parseGIF(arrayBuffer);
        const rawFrames = gifuct.decompressFrames(gif, true);
        const gifW = rawFrames[0].dims.width;
        const gifH = rawFrames[0].dims.height;

        // Offscreen canvas at GIF's native size for compositing patches
        const compCanvas = document.createElement('canvas');
        compCanvas.width = gifW;
        compCanvas.height = gifH;
        const compCtx = compCanvas.getContext('2d');

        // Scaled canvas at mediaCanvas size for final storage
        const scaleCanvas = document.createElement('canvas');
        scaleCanvas.width = mediaCanvas.width;
        scaleCanvas.height = mediaCanvas.height;
        const scaleCtx = scaleCanvas.getContext('2d');

        const scale = Math.min(mediaCanvas.width / gifW, mediaCanvas.height / gifH);
        const dw = gifW * scale;
        const dh = gifH * scale;
        const dx = (mediaCanvas.width - dw) / 2;
        const dy = (mediaCanvas.height - dh) / 2;

        activeGif = rawFrames.map(frame => {
            // Composite this frame's patch onto the running composition canvas
            const patchData = compCtx.createImageData(frame.dims.width, frame.dims.height);
            patchData.data.set(frame.patch);
            compCtx.putImageData(patchData, frame.dims.left, frame.dims.top);

            // Scale and center onto the output-size canvas
            scaleCtx.fillStyle = '#000';
            scaleCtx.fillRect(0, 0, scaleCanvas.width, scaleCanvas.height);
            scaleCtx.drawImage(compCanvas, dx, dy, dw, dh);

            return {
                imageData: scaleCtx.getImageData(0, 0, scaleCanvas.width, scaleCanvas.height),
                delay: (frame.delay || 10) * 10  // GIF delay is centiseconds; convert to ms
            };
        });

        gifFrameIndex = 0;
        gifFrameTime = 0;
        useUploadedSource();
        setStatus(\`Showing GIF: \${file.name} (\${activeGif.length} frames)\`);
    } catch (err) {
        console.warn('GIF decode failed, falling back to static image', err);
        activeGif = null;
        sourceImage.dataset.label = file.name;
        sourceImage.src = currentURL;
        sourceImage.addEventListener('load', () => {
            activeMedia = sourceImage;
            drawMediaToCanvas();
            useUploadedSource();
            setStatus(\`GIF decode failed, showing static: \${file.name}\`);
        }, { once: true });
    }
    return;
}

Do not change anything else."
```

- [ ] **Step 2: Verify in browser — happy path**

Open `index.html`. Upload any animated GIF. Expected:
- Status shows "Loading GIF: filename.gif" briefly
- Status updates to "Showing GIF: filename.gif (N frames)"
- The GIF plays through the CRT shader with smooth frame timing

- [ ] **Step 3: Verify in browser — fallback path**

Open DevTools and run this before uploading:
```js
gifuct.decompressFrames = () => { throw new Error('forced failure'); };
```
Then upload a GIF. Expected: status shows "GIF decode failed, showing static: filename.gif" and a static frame appears through the shader.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: decode animated GIFs with gifuct-js on upload"
```

---

### Task 4: Add drawGifFrameToCanvas and wire into render loop

**Files:**
- Modify: `index.html` (the `drawMediaToCanvas` function area and the `loop` function)

- [ ] **Step 1: Add drawGifFrameToCanvas function**

Run:
```bash
codex "In index.html, find the drawMediaToCanvas function. Add a new function immediately after it (after its closing brace), before the clearCurrentMedia function:

const drawGifFrameToCanvas = (time) => {
    if (!activeGif || activeGif.length === 0) return;

    // First call: anchor the frame clock to the current rAF timestamp
    if (gifFrameTime === 0) {
        gifFrameTime = time;
        mediaCtx.putImageData(activeGif[0].imageData, 0, 0);
        return;
    }

    let elapsed = time - gifFrameTime;
    let currentDelay = activeGif[gifFrameIndex].delay;

    // Advance frame(s) if enough time has passed
    let changed = false;
    while (elapsed >= currentDelay) {
        elapsed -= currentDelay;
        gifFrameIndex = (gifFrameIndex + 1) % activeGif.length;
        currentDelay = activeGif[gifFrameIndex].delay;
        changed = true;
    }

    // Update the frame clock to reflect consumed time
    if (changed) {
        gifFrameTime = time - elapsed;
        mediaCtx.putImageData(activeGif[gifFrameIndex].imageData, 0, 0);
    }
};

Do not change anything else."
```

- [ ] **Step 2: Wire into the render loop**

Run:
```bash
codex "In index.html, find the render loop function (named 'loop'). It currently contains this block:

if (activeMedia === sourceVideo && sourceVideo.readyState >= 2) {
    drawMediaToCanvas();
} else if (activeMedia === sourceImage) {
    drawMediaToCanvas();
}

Replace that block with:

if (activeMedia === sourceVideo && sourceVideo.readyState >= 2) {
    drawMediaToCanvas();
} else if (activeGif) {
    drawGifFrameToCanvas(time);
} else if (activeMedia === sourceImage) {
    drawMediaToCanvas();
}

Do not change anything else."
```

- [ ] **Step 3: Verify GIF plays frame-accurately**

Open `index.html`. Upload a low-framerate GIF (e.g. 10fps pixel art). Expected:
- Each frame holds for the correct duration (no rapid jitter)
- Animation loops seamlessly
- CRT shader effects apply on every frame

Upload a high-framerate GIF (e.g. 25fps clip). Expected:
- Smooth playback at approximately the correct speed through the shader

- [ ] **Step 4: Verify switching sources works**

While a GIF is playing, switch Source dropdown to "Shadertoy Scene". Expected: Shadertoy scene renders, no errors. Switch back to "Uploaded Media". Expected: GIF resumes from where it was (frame clock continues).

- [ ] **Step 5: Verify uploading a new file after a GIF clears state**

While a GIF is playing, upload a new image file. Expected: GIF stops, static image appears. Upload a video. Expected: video plays correctly.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: wire GIF frame clock into rAF loop for jitter-free CRT rendering"
```
