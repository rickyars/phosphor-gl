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

// --- Pass 2: Blur (for bloom at multiple scales) ---
const FRAG_BLUR = `#version 300 es
precision highp float;

uniform sampler2D uInput;
uniform float uBlurSize;
uniform vec2 uTexelSize;

in vec2 vUV;
out vec4 outColor;

void main() {
    vec2 d = uBlurSize * uTexelSize;
    vec3 c  = texture(uInput, vUV).rgb * 0.25;
    c += texture(uInput, vUV + vec2( d.x, 0.0)).rgb * 0.125;
    c += texture(uInput, vUV + vec2(-d.x, 0.0)).rgb * 0.125;
    c += texture(uInput, vUV + vec2(0.0,  d.y)).rgb * 0.125;
    c += texture(uInput, vUV + vec2(0.0, -d.y)).rgb * 0.125;
    c += texture(uInput, vUV + vec2( d.x,  d.y)).rgb * 0.0625;
    c += texture(uInput, vUV + vec2(-d.x, -d.y)).rgb * 0.0625;
    c += texture(uInput, vUV + vec2( d.x, -d.y)).rgb * 0.0625;
    c += texture(uInput, vUV + vec2(-d.x,  d.y)).rgb * 0.0625;
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

    // Read cell color (NEAREST filtering → whole cell = one solid color)
    vec3 cellColor = texture(uPhosphor, phosUV).rgb;

    // --- Gaussian sub-pixel mask ---
    float luma = dot(cellColor, vec3(0.299, 0.587, 0.114));
    float sigma = uDotSoftness + luma * 0.03;  // brighter → wider beam

    float pr   = gauss(cellFrac.x, 0.167, sigma);
    float pg   = gauss(cellFrac.x, 0.500, sigma);
    float pb   = gauss(cellFrac.x, 0.833, sigma);
    float slot = gauss(cellFrac.y, 0.5,   sigma * 2.5);

    vec3 mask = vec3(pr, pg, pb) * slot;
    vec3 color = cellColor * mask;

    // --- Bloom (smooth, in phosphor space) ---
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
            bloomCore: 0.5,
            bloomMid: 0.2,
            bloomHalo: 0.1,
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

        // Bloom FBOs (LINEAR, fixed sizes)
        this.bloomCoreFBO = this._createFBO(512, 512, false);
        this.bloomMidFBO  = this._createFBO(256, 256, false);
        this.bloomHaloFBO = this._createFBO(128, 128, false);

        // Compile programs
        this.progResolve   = this._compile(VERT, FRAG_PHOSPHOR_RESOLVE);
        this.progBlur      = this._compile(VERT, FRAG_BLUR);
        this.progComposite = this._compile(VERT, FRAG_COMPOSITE);

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
            blurSize:  loc(b, 'uBlurSize'),
            texelSize: loc(b, 'uTexelSize'),
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

        // ---- Pass 2: Bloom (3 scales) ----
        // All read from currPhos (the persisted phosphor FBO)
        gl.useProgram(this.progBlur);

        this._runBlur(this.bloomCoreFBO, 512, 1.5);
        this._runBlur(this.bloomMidFBO,  256, 3.0);
        this._runBlur(this.bloomHaloFBO, 128, 6.0);

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
        gl.bindTexture(gl.TEXTURE_2D, this.bloomCoreFBO.tex);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.bloomMidFBO.tex);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, this.bloomHaloFBO.tex);

        this._drawQuad(this.progComposite);

        // ---- Swap ping-pong ----
        // prevPhos now points to this frame's result (for next frame's persistence)
        [this.currPhos, this.prevPhos] = [this.prevPhos, this.currPhos];
    }

    // ----------------------------------------------------------
    //  Bloom helper
    // ----------------------------------------------------------
    _runBlur(targetFBO, size, blurSize) {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, targetFBO.fb);
        gl.viewport(0, 0, size, size);

        gl.uniform1i(this.uB.input, 0);
        gl.uniform1f(this.uB.blurSize, blurSize);
        gl.uniform2f(this.uB.texelSize, 1.0 / size, 1.0 / size);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.currPhos.tex);

        this._drawQuad(this.progBlur);
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
