// ============================================================
//  VirtualCathode — CRT phosphor emulation
// ============================================================
//
//  Pass 1: Phosphor Resolve + Persistence -> Phosphor FBO (source size, NEAREST)
//  Pass 2: Bloom Extract -> 512x512 FBO
//  Pass 3: Bloom Blur -> 3 scales (512, 256, 128)
//  Pass 4: Screen Composite -> Screen (phosphor mask, scanlines, bloom, curvature)
// ============================================================

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUV;
void main() {
    vUV = aPos * 0.5 + 0.5;
    gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG_PHOSPHOR_RESOLVE = `#version 300 es
precision highp float;

uniform sampler2D uSource;
uniform sampler2D uPrev;
uniform float uPersist;
uniform float uFocus;
uniform vec2  uSourceTexel;

in vec2 vUV;
out vec4 outColor;

void main() {
    vec2 uv = vec2(vUV.x, 1.0 - vUV.y);

    // Horizontal beam spread (directional, not symmetric blur)
    vec2 t = uSourceTexel;
    vec3 newCol =
        texture(uSource, uv - vec2(2.0 * t.x, 0.0)).rgb * 0.10 +
        texture(uSource, uv - vec2(1.0 * t.x, 0.0)).rgb * 0.20 +
        texture(uSource, uv).rgb                         * 0.40 +
        texture(uSource, uv + vec2(1.0 * t.x, 0.0)).rgb * 0.20 +
        texture(uSource, uv + vec2(2.0 * t.x, 0.0)).rgb * 0.10;

    // Horizontal sharpening: 3-tap Laplacian
    vec3 left  = texture(uSource, uv + vec2(-uSourceTexel.x, 0.0)).rgb;
    vec3 right = texture(uSource, uv + vec2( uSourceTexel.x, 0.0)).rgb;
    newCol = max(newCol + uFocus * (newCol * 2.0 - left - right), vec3(0.0));

    // sRGB -> linear before persistence accumulation
    newCol = pow(newCol, vec3(2.2));

    // Energy-conserving persistence: steady state converges to newCol, not infinity
    vec3 oldCol = texture(uPrev, vUV).rgb;
    outColor = vec4(oldCol * uPersist + newCol * (1.0 - uPersist), 1.0);
}`;

const FRAG_BLOOM_EXTRACT = `#version 300 es
precision highp float;

uniform sampler2D uInput;
uniform float uThreshold;

in vec2 vUV;
out vec4 outColor;

void main() {
    vec3 c = texture(uInput, vUV).rgb;
    float luma = dot(c, vec3(0.299, 0.587, 0.114));
    // Tight knee: only content significantly above threshold blooms
    float knee = uThreshold * 0.1;
    float w = smoothstep(uThreshold - knee, uThreshold + knee, luma);
    // Scale by how far above threshold — brighter = more bloom
    w *= (luma - uThreshold) / max(1.0 - uThreshold, 0.001);
    w = max(w, 0.0);
    outColor = vec4(c * w, 1.0);
}`;

const FRAG_BLUR = `#version 300 es
precision highp float;

uniform sampler2D uInput;
uniform vec2 uDirection;

in vec2 vUV;
out vec4 outColor;

void main() {
    // 13-tap gaussian (sigma ~4)
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

const FRAG_COMPOSITE = `#version 300 es
precision highp float;

uniform sampler2D uPhosphor;
uniform sampler2D uBloomCoreTex;
uniform sampler2D uBloomMidTex;
uniform sampler2D uBloomHaloTex;

uniform float uZoom;
uniform vec2  uPan;
uniform float uCurvature;
uniform float uSlotExponent;
uniform float uScanlineStr;
uniform float uClipExp;
uniform float uExposure;
uniform float uBloomCoreW;
uniform float uBloomMidW;
uniform float uBloomHaloW;
uniform float uBloomStrength;
uniform vec2  uPhosphorRes;
uniform float uScreenAspect;
uniform float uScreenHeight;
uniform float uMaskLODStart;
uniform float uMaskLODEnd;
uniform float uTime;

in vec2 vUV;
out vec4 outColor;

// Phosphor core: super-gaussian, exponent is luma-dependent
float phosphorCore(float d, float sigma, float exponent) {
    float n = d / sigma;
    return exp(-pow(abs(n), exponent));
}

// Light leakage: Lorentzian — physically models glow through CRT glass
float phosphorHalo(float d, float radius) {
    return 1.0 / (1.0 + pow(d / radius, 2.0));
}

void main() {
    // Barrel distortion
    vec2 c = vUV * 2.0 - 1.0;
    float r2 = dot(c, c);
    c *= 1.0 + r2 * uCurvature + r2 * r2 * uCurvature * 0.5;
    vec2 curved = c * 0.5 + 0.5;

    if (curved.x < 0.0 || curved.x > 1.0 || curved.y < 0.0 || curved.y > 1.0) {
        outColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    // Zoom/pan to phosphor UV (aspect-corrected)
    vec2 phosUV = (curved - 0.5) / uZoom;
    phosUV.x *= uScreenAspect;
    phosUV -= uPan;
    phosUV += 0.5;

    if (phosUV.x < 0.0 || phosUV.x > 1.0 || phosUV.y < 0.0 || phosUV.y > 1.0) {
        outColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    vec3 cellColor = texture(uPhosphor, phosUV).rgb;

    // Mask LOD: blend between full mask and zoomed-out tint
    float pixelsPerCell = (uScreenHeight / uPhosphorRes.y) * uZoom;
    float maskLOD = smoothstep(uMaskLODStart, uMaskLODEnd, pixelsPerCell);

    // Zoomed-out CRT tint: subtle per-cell color and inter-cell dimming
    // This keeps some CRT character even when cells are sub-pixel
    vec2 cellCoord = phosUV * uPhosphorRes;
    vec2 cellBase  = floor(cellCoord);
    vec2 cellFrac  = cellCoord - cellBase;

    // Inter-cell gap dimming (visible at all zoom levels)
    float gapX = smoothstep(0.0, 0.05, cellFrac.x) * smoothstep(1.0, 0.95, cellFrac.x);
    float gapY = smoothstep(0.0, 0.05, cellFrac.y) * smoothstep(1.0, 0.95, cellFrac.y);
    float cellGap = mix(1.0, gapX * gapY, 0.15 * (1.0 - maskLOD));

    // Subtle RGB fringing when zoomed out (approximates unresolved phosphor triad)
    float fx = cellFrac.x;
    vec3 tintWeights = vec3(
        smoothstep(0.5, 0.0, abs(fx - 0.167)),
        smoothstep(0.5, 0.0, abs(fx - 0.500)),
        smoothstep(0.5, 0.0, abs(fx - 0.833))
    );
    tintWeights = mix(vec3(1.0), tintWeights * 2.5, 0.12 * (1.0 - maskLOD));
    vec3 tintedColor = cellColor * tintWeights * cellGap;

    vec3 color;

    if (maskLOD > 0.01) {
        // Shared energy field: beam energy excites ALL phosphors
        float energy = dot(cellColor, vec3(0.299, 0.587, 0.114));

        // Dynamic slot exponent: bright areas soften, dark areas stay sharp
        float dynamicExp = mix(uSlotExponent, 2.0, energy);

        // Beam blooming: bright phosphors physically expand
        float baseSigmaX = 0.18;
        float baseSigmaY = 0.55;
        float sigmaX = baseSigmaX * (1.0 + energy * 0.25);
        float sigmaY = baseSigmaY * (1.0 + energy * 0.25);

        // Positional jitter: break perfect vertical alignment
        cellFrac.x += sin(cellCoord.y * 3.1415) * 0.002;

        // Vertical bar shape
        float vCore = phosphorCore(abs(cellFrac.y - 0.5), sigmaY, dynamicExp);

        // Sub-pixel slot positions
        float posR = 0.167, posG = 0.500, posB = 0.833;

        // Sample all neighbors: left, right, top, bottom
        float texelX = 1.0 / uPhosphorRes.x;
        float texelY = 1.0 / uPhosphorRes.y;
        vec3 leftCell  = texture(uPhosphor, phosUV - vec2(texelX, 0.0)).rgb;
        vec3 rightCell = texture(uPhosphor, phosUV + vec2(texelX, 0.0)).rgb;
        vec3 topCell   = texture(uPhosphor, phosUV - vec2(0.0, texelY)).rgb;
        vec3 botCell   = texture(uPhosphor, phosUV + vec2(0.0, texelY)).rgb;

        // Horizontal core weights (same for all rows at this column)
        vec3 hCur = vec3(
            phosphorCore(abs(cellFrac.x - posR), sigmaX, dynamicExp),
            phosphorCore(abs(cellFrac.x - posG), sigmaX, dynamicExp),
            phosphorCore(abs(cellFrac.x - posB), sigmaX, dynamicExp)
        );
        vec3 hLeft = vec3(
            phosphorCore(cellFrac.x + 0.833, sigmaX, dynamicExp),
            phosphorCore(cellFrac.x + 0.500, sigmaX, dynamicExp),
            phosphorCore(cellFrac.x + 0.167, sigmaX, dynamicExp)
        );
        vec3 hRight = vec3(
            phosphorCore(abs(cellFrac.x - 1.167), sigmaX, dynamicExp),
            phosphorCore(abs(cellFrac.x - 1.500), sigmaX, dynamicExp),
            phosphorCore(abs(cellFrac.x - 1.833), sigmaX, dynamicExp)
        );

        // Vertical core weights: current row, top row, bottom row
        float vCur = phosphorCore(abs(cellFrac.y - 0.5), sigmaY, dynamicExp);
        float vTop = phosphorCore(cellFrac.y + 0.5, sigmaY, dynamicExp);
        float vBot = phosphorCore(1.0 - cellFrac.y + 0.5, sigmaY, dynamicExp);

        // Sum all emitter contributions
        // Current row: 3 cells (left, center, right)
        vec3 result = (cellColor * hCur + leftCell * hLeft + rightCell * hRight) * vCur;
        // Top row: center column (horizontal neighbors are 2nd order)
        result += topCell * hCur * vTop;
        // Bottom row: center column
        result += botCell * hCur * vBot;

        vec3 maskedColor = result;

        // Luma-dependent scanline: bright areas punch through the gaps
        float dynamicStr = uScanlineStr * (1.0 - pow(energy, 0.5));
        float edgeDist = min(cellFrac.y, 1.0 - cellFrac.y);
        float scanline = smoothstep(0.0, 0.1, edgeDist);
        maskedColor *= mix(1.0, scanline, dynamicStr);

        color = mix(tintedColor, maskedColor, maskLOD);
    } else {
        color = tintedColor;
    }

    // Bloom: modulate by existing color to preserve chromaticity (no white fog)
    vec3 bloom = texture(uBloomCoreTex, phosUV).rgb * uBloomCoreW
               + texture(uBloomMidTex,  phosUV).rgb * uBloomMidW
               + texture(uBloomHaloTex, phosUV).rgb * uBloomHaloW;
    color += bloom * sqrt(max(color, vec3(0.0))) * uBloomStrength;

    // White-hot clipping: exposure + power curve crushes highlights to solid white
    color = pow(color * uExposure, vec3(uClipExp));
    color = clamp(color, 0.0, 1.0);

    // CRT flicker
    color *= 1.0 + 0.005 * sin(uTime * 60.0 * 6.28);

    // Linear -> sRGB for display
    color = pow(color, vec3(1.0 / 2.2));
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
            focus: 0.4,
            slotExponent: 2.5,
            scanlineStr: 0.3,
            persistence: 0.85,
            bloomThreshold: 0.4,
            bloomStrength: 1.2,
            bloomCore: 0.04,
            bloomMid: 0.02,
            bloomHalo: 0.01,
            exposure: 1.0,
            clipExponent: 0.8,
            curvature: 0.02,
            maskLODStart: 3.0,
            maskLODEnd: 6.0,
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

        // Phosphor FBOs (ping-pong, NEAREST, 1:1 with source)
        this._buildPhosphorFBOs();

        // Bloom extract FBO (512x512, LINEAR)
        this.bloomExtractFBO = this._createFBO(512, 512, false);

        // Bloom FBOs (fixed sizes, ping-pong pairs)
        this.bloomCoreFBOs = [this._createFBO(512, 512, false), this._createFBO(512, 512, false)];
        this.bloomMidFBOs  = [this._createFBO(256, 256, false), this._createFBO(256, 256, false)];
        this.bloomHaloFBOs = [this._createFBO(128, 128, false), this._createFBO(128, 128, false)];

        // Compile programs
        this.progResolve   = this._compile(VERT, FRAG_PHOSPHOR_RESOLVE);
        this.progExtract   = this._compile(VERT, FRAG_BLOOM_EXTRACT);
        this.progBlur      = this._compile(VERT, FRAG_BLUR);
        this.progComposite = this._compile(VERT, FRAG_COMPOSITE);

        // Cache uniform locations
        this._cacheUniforms();
    }

    _cacheUniforms() {
        const gl = this.gl;
        const loc = (prog, name) => gl.getUniformLocation(prog, name);

        // Resolve pass
        const r = this.progResolve;
        this.uR = {
            source:      loc(r, 'uSource'),
            prev:        loc(r, 'uPrev'),
            persist:     loc(r, 'uPersist'),
            focus:       loc(r, 'uFocus'),
            sourceTexel: loc(r, 'uSourceTexel'),
        };

        // Extract pass
        const e = this.progExtract;
        this.uE = {
            input:     loc(e, 'uInput'),
            threshold: loc(e, 'uThreshold'),
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
            phosphor:      loc(c, 'uPhosphor'),
            bloomCore:     loc(c, 'uBloomCoreTex'),
            bloomMid:      loc(c, 'uBloomMidTex'),
            bloomHalo:     loc(c, 'uBloomHaloTex'),
            zoom:          loc(c, 'uZoom'),
            pan:           loc(c, 'uPan'),
            curvature:     loc(c, 'uCurvature'),
            slotExponent:  loc(c, 'uSlotExponent'),
            scanlineStr:   loc(c, 'uScanlineStr'),
            clipExp:       loc(c, 'uClipExp'),
            bloomCoreW:    loc(c, 'uBloomCoreW'),
            bloomMidW:     loc(c, 'uBloomMidW'),
            bloomHaloW:    loc(c, 'uBloomHaloW'),
            bloomStrength: loc(c, 'uBloomStrength'),
            phosphorRes:   loc(c, 'uPhosphorRes'),
            screenAspect:  loc(c, 'uScreenAspect'),
            screenHeight:  loc(c, 'uScreenHeight'),
            maskLODStart:  loc(c, 'uMaskLODStart'),
            maskLODEnd:    loc(c, 'uMaskLODEnd'),
            exposure:      loc(c, 'uExposure'),
            time:          loc(c, 'uTime'),
        };
    }

    _buildPhosphorFBOs() {
        const gl = this.gl;
        const pw = this.source.width;
        const ph = this.source.height;

        if (this.phosA) {
            gl.deleteTexture(this.phosA.tex);
            gl.deleteFramebuffer(this.phosA.fb);
            gl.deleteTexture(this.phosB.tex);
            gl.deleteFramebuffer(this.phosB.fb);
        }

        this.phosA = this._createFBO(pw, ph, true);   // NEAREST
        this.phosB = this._createFBO(pw, ph, true);   // NEAREST
        this.phosW = pw;
        this.phosH = ph;

        for (const fbo of [this.phosA, this.phosB]) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fb);
            gl.viewport(0, 0, pw, ph);
            gl.clearColor(0, 0, 0, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        this.currPhos = this.phosA;
        this.prevPhos = this.phosB;
    }

    // ----------------------------------------------------------
    //  Render
    // ----------------------------------------------------------
    render(time) {
        const gl = this.gl;
        const s = this.settings;

        // Upload source canvas to texture
        gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA,
                      gl.UNSIGNED_BYTE, this.source);

        // Rebuild phosphor FBOs if source size changed
        const msKey = `${this.source.width}_${this.source.height}`;
        if (msKey !== this._lastMsKey) {
            this._buildPhosphorFBOs();
            this._lastMsKey = msKey;
        }

        // ---- Pass 1: Phosphor Resolve + Persistence ----
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.currPhos.fb);
        gl.viewport(0, 0, this.phosW, this.phosH);
        gl.useProgram(this.progResolve);

        gl.uniform1i(this.uR.source, 0);
        gl.uniform1i(this.uR.prev, 1);
        gl.uniform1f(this.uR.persist, s.persistence);
        gl.uniform1f(this.uR.focus, s.focus);
        gl.uniform2f(this.uR.sourceTexel, 1.0 / this.source.width, 1.0 / this.source.height);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.prevPhos.tex);

        this._drawQuad(this.progResolve);

        // ---- Pass 2: Bloom Extract (threshold) ----
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomExtractFBO.fb);
        gl.viewport(0, 0, 512, 512);
        gl.useProgram(this.progExtract);

        gl.uniform1i(this.uE.input, 0);
        gl.uniform1f(this.uE.threshold, s.bloomThreshold);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.currPhos.tex);

        this._drawQuad(this.progExtract);

        // ---- Pass 3: Bloom Blur (3 scales from extracted source) ----
        gl.useProgram(this.progBlur);

        this._blurScale(this.bloomCoreFBOs, 512, 1, this.bloomExtractFBO.tex);
        this._blurScale(this.bloomMidFBOs,  256, 2, this.bloomExtractFBO.tex);
        this._blurScale(this.bloomHaloFBOs, 128, 2, this.bloomExtractFBO.tex);

        // ---- Pass 4: Screen Composite ----
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
        gl.uniform1f(this.uC.slotExponent, s.slotExponent);
        gl.uniform1f(this.uC.scanlineStr, s.scanlineStr);
        gl.uniform1f(this.uC.clipExp, s.clipExponent);
        gl.uniform1f(this.uC.bloomCoreW, s.bloomCore);
        gl.uniform1f(this.uC.bloomMidW, s.bloomMid);
        gl.uniform1f(this.uC.bloomHaloW, s.bloomHalo);
        gl.uniform1f(this.uC.bloomStrength, s.bloomStrength);
        gl.uniform2f(this.uC.phosphorRes, this.phosW, this.phosH);
        gl.uniform1f(this.uC.screenAspect, this.canvas.width / this.canvas.height);
        gl.uniform1f(this.uC.screenHeight, this.canvas.height);
        gl.uniform1f(this.uC.maskLODStart, s.maskLODStart);
        gl.uniform1f(this.uC.maskLODEnd, s.maskLODEnd);
        gl.uniform1f(this.uC.exposure, s.exposure);
        gl.uniform1f(this.uC.time, time * 0.001);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.currPhos.tex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.bloomCoreFBOs[0].tex);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.bloomMidFBOs[0].tex);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, this.bloomHaloFBOs[0].tex);

        this._drawQuad(this.progComposite);

        // Swap ping-pong
        [this.currPhos, this.prevPhos] = [this.prevPhos, this.currPhos];
    }

    // ----------------------------------------------------------
    //  Bloom helper: blur from a source texture into a ping-pong pair
    // ----------------------------------------------------------
    _blurScale(fboPair, size, iterations, sourceTex) {
        const gl = this.gl;
        const tx = 1.0 / size;

        gl.uniform1i(this.uB.input, 0);
        gl.activeTexture(gl.TEXTURE0);

        // H pass: 20% wider to simulate horizontal beam travel
        const hx = tx * 1.2;

        // First H pass reads from sourceTex
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboPair[1].fb);
        gl.viewport(0, 0, size, size);
        gl.uniform2f(this.uB.direction, hx, 0.0);
        gl.bindTexture(gl.TEXTURE_2D, sourceTex);
        this._drawQuad(this.progBlur);

        // First V pass
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboPair[0].fb);
        gl.uniform2f(this.uB.direction, 0.0, tx);
        gl.bindTexture(gl.TEXTURE_2D, fboPair[1].tex);
        this._drawQuad(this.progBlur);

        // Additional iterations ping-pong
        for (let i = 1; i < iterations; i++) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, fboPair[1].fb);
            gl.uniform2f(this.uB.direction, hx, 0.0);
            gl.bindTexture(gl.TEXTURE_2D, fboPair[0].tex);
            this._drawQuad(this.progBlur);

            gl.bindFramebuffer(gl.FRAMEBUFFER, fboPair[0].fb);
            gl.uniform2f(this.uB.direction, 0.0, tx);
            gl.bindTexture(gl.TEXTURE_2D, fboPair[1].tex);
            this._drawQuad(this.progBlur);
        }
        // Result in fboPair[0]
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
