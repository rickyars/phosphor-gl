// ============================================================
//  VirtualCathode — CRT phosphor emulation via phosphor-space FBO
// ============================================================
//
//  Architecture:
//    Source Canvas (1024x1024)
//        ↓
//    [Pass 1: Phosphor Resolve + Persistence]
//        → Phosphor FBO (maskScale × maskScale/2, NEAREST)
//        Each texel = one triad cell, sampled at cell center
//        Blended with previous frame: max(old * decay, new)
//        ↓
//    [Pass 2: Bloom]  → 3 blur FBOs (512, 256, 128)
//        Read from persisted phosphor FBO
//        ↓
//    [Pass 3: Screen Composite] → Screen
//        Read phosphor cell (NEAREST), apply gaussian mask,
//        add bloom, apply curvature + energy clipping
// ============================================================

// --- Shared vertex shader ---
const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUV;
void main() {
    vUV = aPos * 0.5 + 0.5;
    gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// --- Pass 1: Phosphor Resolve + Persistence ---
// Each texel in this FBO IS one phosphor triad cell.
// vUV maps 0–1 across the phosphor grid, which also maps 0–1 across the source.
// No coordinate inversion needed — the FBO resolution does the snapping.
const FRAG_PHOSPHOR_RESOLVE = `#version 300 es
precision highp float;

uniform sampler2D uSource;
uniform sampler2D uPrev;
uniform float uPersist;

in vec2 vUV;
out vec4 outColor;

void main() {
    // Sample source at this cell's center (Y-flip for canvas coordinates)
    vec3 newCol = texture(uSource, vec2(vUV.x, 1.0 - vUV.y)).rgb;
    // Previous persisted phosphor value
    vec3 oldCol = texture(uPrev, vUV).rgb;
    // Persistence: phosphor decays, but re-excitation takes the max
    outColor = vec4(max(oldCol * uPersist, newCol), 1.0);
}`;

// --- Pass 2: Separable Gaussian Blur (horizontal or vertical) ---
// 13-tap gaussian, run H then V for a proper 2D blur.
// Multiple iterations widen the effective radius.
const FRAG_BLUR = `#version 300 es
precision highp float;

uniform sampler2D uInput;
uniform vec2 uDirection;  // (1/w, 0) for H or (0, 1/h) for V

in vec2 vUV;
out vec4 outColor;

void main() {
    // 13-tap gaussian weights (sigma ~4)
    vec3 c = vec3(0.0);
    c += texture(uInput, vUV - 6.0 * uDirection).rgb * 0.002216;
    c += texture(uInput, vUV - 5.0 * uDirection).rgb * 0.008764;
    c += texture(uInput, vUV - 4.0 * uDirection).rgb * 0.026995;
    c += texture(uInput, vUV - 3.0 * uDirection).rgb * 0.064759;
    c += texture(uInput, vUV - 2.0 * uDirection).rgb * 0.120985;
    c += texture(uInput, vUV - 1.0 * uDirection).rgb * 0.176033;
    c += texture(uInput, vUV                    ).rgb * 0.199471;
    c += texture(uInput, vUV + 1.0 * uDirection).rgb * 0.176033;
    c += texture(uInput, vUV + 2.0 * uDirection).rgb * 0.120985;
    c += texture(uInput, vUV + 3.0 * uDirection).rgb * 0.064759;
    c += texture(uInput, vUV + 4.0 * uDirection).rgb * 0.026995;
    c += texture(uInput, vUV + 5.0 * uDirection).rgb * 0.008764;
    c += texture(uInput, vUV + 6.0 * uDirection).rgb * 0.002216;
    outColor = vec4(c, 1.0);
}`;

// --- Pass 3: Screen Composite ---
// For each screen pixel: find which phosphor cell it's in,
// read the cell color, apply gaussian sub-pixel mask, add bloom,
// apply curvature and energy clipping.
const FRAG_COMPOSITE = `#version 300 es
precision highp float;

uniform sampler2D uPhosphor;
uniform sampler2D uBloomCoreTex;
uniform sampler2D uBloomMidTex;
uniform sampler2D uBloomHaloTex;

uniform float uZoom;
uniform vec2  uPan;
uniform float uCurvature;
uniform float uDotSoftness;
uniform float uClipExp;
uniform float uBloomCoreW;
uniform float uBloomMidW;
uniform float uBloomHaloW;
uniform vec2  uPhosphorRes;  // (maskScale, maskScale * 0.5)
in vec2 vUV;
out vec4 outColor;

float gauss(float x, float center, float sigma) {
    float d = x - center;
    return exp(-0.5 * d * d / (sigma * sigma));
}

void main() {
    // --- Barrel distortion (curvature) ---
    vec2 c = vUV * 2.0 - 1.0;
    float r2 = dot(c, c);
    c *= 1.0 + r2 * uCurvature + r2 * r2 * uCurvature * 0.5;
    vec2 curved = c * 0.5 + 0.5;

    if (curved.x < 0.0 || curved.x > 1.0 || curved.y < 0.0 || curved.y > 1.0) {
        outColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    // --- Zoom / pan → phosphor UV ---
    // pan=(0,0) = centered, zoom=1 = full CRT visible
    vec2 phosUV = (curved - 0.5) / uZoom - uPan + 0.5;

    if (phosUV.x < 0.0 || phosUV.x > 1.0 || phosUV.y < 0.0 || phosUV.y > 1.0) {
        outColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    // --- Phosphor cell position ---
    vec2 cellCoord = phosUV * uPhosphorRes;   // position in cell units
    vec2 cellFrac  = fract(cellCoord);         // 0–1 within the cell
    vec2 cellIndex = floor(cellCoord);         // integer cell ID
    vec2 texelSize = 1.0 / uPhosphorRes;      // one cell in UV space

    // --- Gaussian sub-pixel mask with neighbor bleeding ---
    // Each phosphor dot's glow extends beyond its cell boundary.
    // Sample a 3x3 neighborhood: for each neighbor, its R/G/B dots
    // contribute gaussian tails at our pixel position.
    vec3 color = vec3(0.0);

    for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
            vec2 neighborIdx = cellIndex + vec2(float(dx), float(dy));
            vec2 neighborUV  = (neighborIdx + 0.5) * texelSize;

            // Skip out-of-bounds neighbors
            if (neighborUV.x < 0.0 || neighborUV.x > 1.0 ||
                neighborUV.y < 0.0 || neighborUV.y > 1.0) continue;

            vec3 nColor = texture(uPhosphor, neighborUV).rgb;
            float nLuma = dot(nColor, vec3(0.299, 0.587, 0.114));
            float sigma = uDotSoftness + nLuma * 0.03;

            // Our position relative to this neighbor's cell origin
            float fx = cellFrac.x - float(dx);
            float fy = cellFrac.y - float(dy);

            float pr   = gauss(fx, 0.167, sigma);
            float pg   = gauss(fx, 0.500, sigma);
            float pb   = gauss(fx, 0.833, sigma);
            float slot = gauss(fy, 0.5,   sigma * 2.5);

            color += nColor * vec3(pr, pg, pb) * slot;
        }
    }

    // --- Bloom ---
    vec3 bloom = texture(uBloomCoreTex, phosUV).rgb * uBloomCoreW
               + texture(uBloomMidTex,  phosUV).rgb * uBloomMidW
               + texture(uBloomHaloTex, phosUV).rgb * uBloomHaloW;
    color += bloom;

    // --- Energy clipping: bright phosphors blow out toward white ---
    float lumaOut = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(color, vec3(lumaOut), pow(clamp(lumaOut, 0.0, 1.0), uClipExp));

    outColor = vec4(color, 1.0);
}`;


// ============================================================
//  Main class
// ============================================================
class VirtualCathode {
    constructor(source, canvas) {
        this.source = source;
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl2', { antialias: false });
        if (!this.gl) throw new Error('WebGL2 required');

        this.settings = {
            zoom: 1.0,
            pan: { x: 0.0, y: 0.0 },
            maskScale: 600,
            dotSoftness: 0.06,
            persistence: 0.85,
            bloomCore: 0.06,
            bloomMid: 0.03,
            bloomHalo: 0.015,
            clipExponent: 3.0,
            curvature: 0.02,
        };

        this._init();
    }

    // ----------------------------------------------------------
    //  Initialization
    // ----------------------------------------------------------
    _init() {
        const gl = this.gl;
        gl.getExtension('EXT_color_buffer_float');

        // Fullscreen quad geometry
        this.vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferData(gl.ARRAY_BUFFER,
            new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

        // Source texture (re-uploaded each frame from 2D canvas)
        this.sourceTex = this._createTex(1024, 1024, false, false);

        // Phosphor FBOs (ping-pong, NEAREST, sized to maskScale)
        this._buildPhosphorFBOs();

        // Bloom FBOs (fixed sizes)
        this.bloomCore = [this._createFBO(512, 512, false), this._createFBO(512, 512, false)];
        this.bloomMid  = [this._createFBO(256, 256, false), this._createFBO(256, 256, false)];
        this.bloomHalo = [this._createFBO(128, 128, false), this._createFBO(128, 128, false)];

        // Compile programs
        this.progResolve   = this._compile(VERT, FRAG_PHOSPHOR_RESOLVE);
        this.progBlur      = this._compile(VERT, FRAG_BLUR);
        this.progComposite    = this._compile(VERT, FRAG_COMPOSITE);

        // Cache uniform locations
        this._cacheUniforms();

        this._lastMaskScale = Math.round(this.settings.maskScale);
    }

    _cacheUniforms() {
        const gl = this.gl;
        const loc = (prog, name) => gl.getUniformLocation(prog, name);

        // Resolve pass
        const r = this.progResolve;
        this.uR = {
            source:  loc(r, 'uSource'),
            prev:    loc(r, 'uPrev'),
            persist: loc(r, 'uPersist'),
        };

        // Blur pass
        const b = this.progBlur;
        this.uB = {
            input:     loc(b, 'uInput'),
            direction: loc(b, 'uDirection'),
        };

        // Composite pass
        const c = this.progComposite;
        this.uC = {
            phosphor:     loc(c, 'uPhosphor'),
            bloomCore:    loc(c, 'uBloomCoreTex'),
            bloomMid:     loc(c, 'uBloomMidTex'),
            bloomHalo:    loc(c, 'uBloomHaloTex'),
            zoom:         loc(c, 'uZoom'),
            pan:          loc(c, 'uPan'),
            curvature:    loc(c, 'uCurvature'),
            dotSoftness:  loc(c, 'uDotSoftness'),
            clipExp:      loc(c, 'uClipExp'),
            bloomCoreW:   loc(c, 'uBloomCoreW'),
            bloomMidW:    loc(c, 'uBloomMidW'),
            bloomHaloW:   loc(c, 'uBloomHaloW'),
            phosphorRes:  loc(c, 'uPhosphorRes'),
        };
    }

    _buildPhosphorFBOs() {
        const gl = this.gl;
        const pw = Math.round(this.settings.maskScale);
        const ph = Math.round(pw * 0.5);

        // Destroy old FBOs if they exist
        if (this.phosA) {
            gl.deleteTexture(this.phosA.tex);
            gl.deleteFramebuffer(this.phosA.fb);
            gl.deleteTexture(this.phosB.tex);
            gl.deleteFramebuffer(this.phosB.fb);
        }

        this.phosA = this._createFBO(pw, ph, true);  // NEAREST
        this.phosB = this._createFBO(pw, ph, true);   // NEAREST
        this.phosW = pw;
        this.phosH = ph;

        // Clear both to black
        for (const fbo of [this.phosA, this.phosB]) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fb);
            gl.viewport(0, 0, pw, ph);
            gl.clearColor(0, 0, 0, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        // Ping-pong: currPhos receives this frame, prevPhos has last frame
        this.currPhos = this.phosA;
        this.prevPhos = this.phosB;
    }

    // ----------------------------------------------------------
    //  Render — called once per animation frame
    // ----------------------------------------------------------
    render(time) {
        const gl = this.gl;
        const s = this.settings;

        // Rebuild phosphor FBOs if maskScale changed
        const ms = Math.round(s.maskScale);
        if (ms !== this._lastMaskScale) {
            this._buildPhosphorFBOs();
            this._lastMaskScale = ms;
        }

        // Upload source canvas to texture
        gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA,
                      gl.UNSIGNED_BYTE, this.source);

        // ---- Pass 1: Phosphor Resolve + Persistence ----
        // Writes to currPhos. Reads source + prevPhos.
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.currPhos.fb);
        gl.viewport(0, 0, this.phosW, this.phosH);
        gl.useProgram(this.progResolve);

        gl.uniform1i(this.uR.source, 0);
        gl.uniform1i(this.uR.prev, 1);
        gl.uniform1f(this.uR.persist, s.persistence);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.prevPhos.tex);

        this._drawQuad(this.progResolve);

        // currPhos now has the persisted phosphor data for this frame.

        // ---- Pass 2: Bloom (3 scales, separable H+V blur) ----
        gl.useProgram(this.progBlur);

        this._blurScale(this.bloomCore, 512, 1);
        this._blurScale(this.bloomMid,  256, 2);
        this._blurScale(this.bloomHalo, 128, 2);

        // ---- Pass 3: Screen Composite ----
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.useProgram(this.progComposite);

        gl.uniform1i(this.uC.phosphor, 0);
        gl.uniform1i(this.uC.bloomCore, 1);
        gl.uniform1i(this.uC.bloomMid, 2);
        gl.uniform1i(this.uC.bloomHalo, 3);

        gl.uniform1f(this.uC.zoom, s.zoom);
        gl.uniform2f(this.uC.pan, s.pan.x, s.pan.y);
        gl.uniform1f(this.uC.curvature, s.curvature);
        gl.uniform1f(this.uC.dotSoftness, s.dotSoftness);
        gl.uniform1f(this.uC.clipExp, s.clipExponent);
        gl.uniform1f(this.uC.bloomCoreW, s.bloomCore);
        gl.uniform1f(this.uC.bloomMidW, s.bloomMid);
        gl.uniform1f(this.uC.bloomHaloW, s.bloomHalo);
        gl.uniform2f(this.uC.phosphorRes, this.phosW, this.phosH);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.currPhos.tex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.bloomCore[0].tex);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.bloomMid[0].tex);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, this.bloomHalo[0].tex);

        this._drawQuad(this.progComposite);

        // ---- Swap ping-pong ----
        // prevPhos now points to this frame's result (for next frame's persistence)
        [this.currPhos, this.prevPhos] = [this.prevPhos, this.currPhos];
    }

    // ----------------------------------------------------------
    //  Bloom helper
    // ----------------------------------------------------------
    // Blur a bloom scale: blit phosphor into fbo[0], then ping-pong
    // H/V separable gaussian passes for `iterations` rounds.
    _blurScale(fboPair, size, iterations) {
        const gl = this.gl;
        const tx = 1.0 / size;

        // Step 1: Blit (downsample) currPhos → fboPair[0]
        // We reuse the blur shader with direction=0 as a passthrough isn't needed;
        // instead just do one H pass directly from phosphor source.
        gl.uniform1i(this.uB.input, 0);
        gl.activeTexture(gl.TEXTURE0);

        // First H pass reads from thresholded bloom extract
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboPair[1].fb);
        gl.viewport(0, 0, size, size);
        gl.uniform2f(this.uB.direction, tx, 0.0);
        gl.bindTexture(gl.TEXTURE_2D, this.currPhos.tex);
        this._drawQuad(this.progBlur);

        // First V pass
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboPair[0].fb);
        gl.uniform2f(this.uB.direction, 0.0, tx);
        gl.bindTexture(gl.TEXTURE_2D, fboPair[1].tex);
        this._drawQuad(this.progBlur);

        // Additional iterations ping-pong between [0] and [1]
        for (let i = 1; i < iterations; i++) {
            // H pass: read [0] → write [1]
            gl.bindFramebuffer(gl.FRAMEBUFFER, fboPair[1].fb);
            gl.uniform2f(this.uB.direction, tx, 0.0);
            gl.bindTexture(gl.TEXTURE_2D, fboPair[0].tex);
            this._drawQuad(this.progBlur);

            // V pass: read [1] → write [0]
            gl.bindFramebuffer(gl.FRAMEBUFFER, fboPair[0].fb);
            gl.uniform2f(this.uB.direction, 0.0, tx);
            gl.bindTexture(gl.TEXTURE_2D, fboPair[1].tex);
            this._drawQuad(this.progBlur);
        }
        // Result always ends up in fboPair[0]
    }

    // ----------------------------------------------------------
    //  WebGL helpers
    // ----------------------------------------------------------
    _drawQuad(prog) {
        const gl = this.gl;
        const pos = gl.getAttribLocation(prog, 'aPos');
        gl.enableVertexAttribArray(pos);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    _createTex(w, h, isFloat, nearest) {
        const gl = this.gl;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        const fmt  = isFloat ? gl.RGBA16F : gl.RGBA;
        const type = isFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
        gl.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, gl.RGBA, type, null);
        const filt = nearest ? gl.NEAREST : gl.LINEAR;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filt);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return tex;
    }

    _createFBO(w, h, nearest) {
        const gl = this.gl;
        const tex = this._createTex(w, h, true, nearest);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                                gl.TEXTURE_2D, tex, 0);
        return { fb, tex };
    }

    _compile(vsrc, fsrc) {
        const gl = this.gl;

        const vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, vsrc);
        gl.compileShader(vs);
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS))
            console.error('Vertex shader error:', gl.getShaderInfoLog(vs));

        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, fsrc);
        gl.compileShader(fs);
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS))
            console.error('Fragment shader error:', gl.getShaderInfoLog(fs));

        const prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
            console.error('Program link error:', gl.getProgramInfoLog(prog));

        return prog;
    }
}
