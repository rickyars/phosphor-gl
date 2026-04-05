const CRT_VERT = `#version 300 es
in vec2 aPos;
out vec2 vUV;
void main() {
    vUV = aPos * 0.5 + 0.5;
    gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const CRT_EFFECT_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uSource;
uniform sampler2D uBlueNoise;
uniform vec2 uResolution;
uniform vec2 uSourceResolution;
uniform float uMaskIntensity;
uniform float uMaskSize;
uniform float uMaskBorder;
uniform float uMaskMode;
uniform vec2 uAberrationOffset;
uniform float uScreenCurvature;
uniform float uScreenVignette;
uniform float uPulseIntensity;
uniform float uPulseWidth;
uniform float uPulseRate;
uniform float uSignalWaver;
uniform float uPhosphorFlicker;
uniform float uScanlineShimmer;
uniform float uZoom;
uniform vec2 uPan;
uniform float uCellOffset;
uniform float uExposure;
uniform float uTime;
uniform float uFrame;

in vec2 vUV;
out vec4 outColor;

vec3 bn(vec2 px, float channelOffset) {
    vec2 uv = (px + channelOffset) / 64.0;
    vec3 noiseTexel = texture(uBlueNoise, uv).rgb;
    return fract(noiseTexel + 0.61803398874 * uFrame);
}

void main() {
    vec2 uv = vUV * 2.0 - 1.0;
    uv *= uZoom + (dot(uv, uv) - 1.0) * uScreenCurvature;
    vec2 pixel = (uv * 0.5 + 0.5) * uResolution;
    pixel -= uPan * uResolution;

    vec2 screenUV = pixel / uResolution;
    if (screenUV.x < 0.0 || screenUV.x > 1.0 || screenUV.y < 0.0 || screenUV.y > 1.0) {
        outColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    vec2 edge = max(1.0 - uv * uv, 0.0);
    float vignette = pow(max(edge.x * edge.y, 0.0), uScreenVignette);

    float waveNoise = bn(vec2(0.0, pixel.y), 7.0).r - 0.5;
    float wavePx = waveNoise * uSignalWaver;

    vec2 coord = (pixel + vec2(wavePx, 0.0)) / uMaskSize;
    vec2 subcoord = coord * vec2(3.0, 1.0);
    vec2 cellOffset = uMaskMode < 0.5 ? vec2(0.0, fract(floor(coord.x) * uCellOffset)) : vec2(0.0);
    vec2 maskCoord = floor(coord + cellOffset) * uMaskSize;

    vec2 sampleUV = vec2(maskCoord.x / uResolution.x, maskCoord.y / uResolution.y);
    vec3 color;
    color.r = texture(uSource, sampleUV - uAberrationOffset / uSourceResolution).r;
    color.g = texture(uSource, sampleUV).g;
    color.b = texture(uSource, sampleUV + uAberrationOffset / uSourceResolution).b;

    float ind = mod(floor(subcoord.x), 3.0);
    vec3 maskColor = vec3(ind == 0.0, ind == 1.0, ind == 2.0) * 3.0;

    vec2 cellUV = fract(subcoord + cellOffset) * 2.0 - 1.0;
    vec2 border = 1.0 - cellUV * cellUV * uMaskBorder;
    float borderMask = clamp(border.x, 0.0, 1.0) * clamp(border.y, 0.0, 1.0);
    maskColor *= borderMask;

    vec3 flickerNoise = bn(pixel, 0.0) - 0.5;
    maskColor *= 1.0 + flickerNoise * uPhosphorFlicker;

    color *= 1.0 + (maskColor - 1.0) * uMaskIntensity;
    color *= vignette;
    color *= 1.0 + uPulseIntensity * cos(pixel.x / max(uPulseWidth, 0.001) + uTime * uPulseRate);

    float shimmerNoise = bn(vec2(0.0, floor(pixel.y / uMaskSize)), 13.0).r - 0.5;
    color *= 1.0 + shimmerNoise * uScanlineShimmer;

    color *= uExposure;

    outColor = vec4(max(color, 0.0), 1.0);
}`;

const CRT_BLOOM_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uInput;
uniform vec2 uResolution;
uniform float uBloomRadius;
uniform float uBloomGlow;
uniform float uBloomBase;

in vec2 vUV;
out vec4 outColor;

void main() {
    vec2 fragCoord = vUV * uResolution;
    vec2 texel = 1.0 / uResolution;
    const float BLOOM_SAMPLES = 32.0;

    vec4 bloom = vec4(0.0);
    vec2 point = vec2(uBloomRadius, 0.0) * inversesqrt(BLOOM_SAMPLES);
    mat2 rot = mat2(0.7374, 0.6755, -0.6755, 0.7374);

    for (float i = 0.0; i < BLOOM_SAMPLES; i++) {
        point *= -rot;
        vec2 coord = (fragCoord + point * sqrt(i)) * texel;
        bloom += texture(uInput, coord) * (1.0 - i / BLOOM_SAMPLES);
    }

    bloom *= uBloomGlow / BLOOM_SAMPLES;
    bloom += texture(uInput, fragCoord * texel) * uBloomBase;
    outColor = bloom;
}`;

const CRT_PRESENT_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uInput;
uniform float uGammaEnabled;
in vec2 vUV;
out vec4 outColor;

void main() {
    vec3 color = texture(uInput, vUV).rgb;
    color = clamp(color, 0.0, 1.0);
    color = mix(color, pow(color, vec3(1.0 / 2.2)), uGammaEnabled);
    outColor = vec4(color, 1.0);
}`;

class CRTShader {
    constructor(sourceCanvas, canvas) {
        this.sourceCanvas = sourceCanvas;
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl2', { antialias: false });
        if (!this.gl) throw new Error('WebGL2 required');

        this.settings = {
            zoom: 1.0,
            pan: { x: 0.0, y: 0.0 },
            maskIntensity: 1.0,
            maskSize: 12.0,
            maskBorder: 0.8,
            maskMode: 0.0,
            cellOffset: 0.5,
            aberrationX: 2.0,
            aberrationY: 0.0,
            screenCurvature: 0.08,
            screenVignette: 0.4,
            pulseIntensity: 0.03,
            pulseWidth: 60.0,
            pulseRate: 20.0,
            signalWaver: 0.8,
            phosphorFlicker: 0.12,
            scanlineShimmer: 0.1,
            bloomRadius: 16.0,
            bloomGlow: 3.0,
            bloomBase: 0.5,
            exposure: 1.0,
            gammaEnabled: 0.0,
        };
        this._frame = 0;

        this._init();
    }

    _init() {
        const gl = this.gl;
        gl.getExtension('EXT_color_buffer_float');

        this.vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

        this.sourceTex = this._createTex(2, 2, false, false);
        this.blueNoiseTex = this._generateBlueNoise(64);
        this._buildFBOs();

        this.progCRT = this._compile(CRT_VERT, CRT_EFFECT_FRAG);
        this.progBloom = this._compile(CRT_VERT, CRT_BLOOM_FRAG);
        this.progPresent = this._compile(CRT_VERT, CRT_PRESENT_FRAG);

        const loc = (prog, name) => gl.getUniformLocation(prog, name);
        this.uCRT = {
            source: loc(this.progCRT, 'uSource'),
            blueNoise: loc(this.progCRT, 'uBlueNoise'),
            resolution: loc(this.progCRT, 'uResolution'),
            sourceResolution: loc(this.progCRT, 'uSourceResolution'),
            maskIntensity: loc(this.progCRT, 'uMaskIntensity'),
            maskSize: loc(this.progCRT, 'uMaskSize'),
            maskBorder: loc(this.progCRT, 'uMaskBorder'),
            maskMode: loc(this.progCRT, 'uMaskMode'),
            aberrationOffset: loc(this.progCRT, 'uAberrationOffset'),
            screenCurvature: loc(this.progCRT, 'uScreenCurvature'),
            screenVignette: loc(this.progCRT, 'uScreenVignette'),
            pulseIntensity: loc(this.progCRT, 'uPulseIntensity'),
            pulseWidth: loc(this.progCRT, 'uPulseWidth'),
            pulseRate: loc(this.progCRT, 'uPulseRate'),
            signalWaver: loc(this.progCRT, 'uSignalWaver'),
            phosphorFlicker: loc(this.progCRT, 'uPhosphorFlicker'),
            scanlineShimmer: loc(this.progCRT, 'uScanlineShimmer'),
            zoom: loc(this.progCRT, 'uZoom'),
            pan: loc(this.progCRT, 'uPan'),
            cellOffset: loc(this.progCRT, 'uCellOffset'),
            exposure: loc(this.progCRT, 'uExposure'),
            time: loc(this.progCRT, 'uTime'),
            frame: loc(this.progCRT, 'uFrame'),
        };
        this.uBloom = {
            input: loc(this.progBloom, 'uInput'),
            resolution: loc(this.progBloom, 'uResolution'),
            bloomRadius: loc(this.progBloom, 'uBloomRadius'),
            bloomGlow: loc(this.progBloom, 'uBloomGlow'),
            bloomBase: loc(this.progBloom, 'uBloomBase'),
        };
        this.uPresent = {
            input: loc(this.progPresent, 'uInput'),
            gammaEnabled: loc(this.progPresent, 'uGammaEnabled'),
        };
    }

    _buildFBOs() {
        const gl = this.gl;
        const w = this.canvas.width;
        const h = this.canvas.height;

        if (this.crtFBO) {
            gl.deleteTexture(this.crtFBO.tex);
            gl.deleteFramebuffer(this.crtFBO.fb);
            gl.deleteTexture(this.bloomFBO.tex);
            gl.deleteFramebuffer(this.bloomFBO.fb);
        }

        this.crtFBO = this._createFBO(w, h, false);
        this.bloomFBO = this._createFBO(w, h, false);
        this.fboW = w;
        this.fboH = h;
    }

    render(time) {
        const gl = this.gl;
        const s = this.settings;

        const canvasKey = `${this.canvas.width}x${this.canvas.height}`;
        if (canvasKey !== this._canvasKey) {
            this._canvasKey = canvasKey;
            this._buildFBOs();
        }

        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.sourceCanvas);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.crtFBO.fb);
        gl.viewport(0, 0, this.fboW, this.fboH);
        gl.useProgram(this.progCRT);
        gl.uniform1i(this.uCRT.source, 0);
        gl.uniform1i(this.uCRT.blueNoise, 1);
        gl.uniform2f(this.uCRT.resolution, this.fboW, this.fboH);
        gl.uniform2f(this.uCRT.sourceResolution, this.sourceCanvas.width, this.sourceCanvas.height);
        gl.uniform1f(this.uCRT.maskIntensity, s.maskIntensity);
        gl.uniform1f(this.uCRT.maskSize, s.maskSize);
        gl.uniform1f(this.uCRT.maskBorder, s.maskBorder);
        gl.uniform1f(this.uCRT.maskMode, s.maskMode);
        gl.uniform2f(this.uCRT.aberrationOffset, s.aberrationX, s.aberrationY);
        gl.uniform1f(this.uCRT.screenCurvature, s.screenCurvature);
        gl.uniform1f(this.uCRT.screenVignette, s.screenVignette);
        gl.uniform1f(this.uCRT.pulseIntensity, s.pulseIntensity);
        gl.uniform1f(this.uCRT.pulseWidth, s.pulseWidth);
        gl.uniform1f(this.uCRT.pulseRate, s.pulseRate);
        gl.uniform1f(this.uCRT.signalWaver, s.signalWaver);
        gl.uniform1f(this.uCRT.phosphorFlicker, s.phosphorFlicker);
        gl.uniform1f(this.uCRT.scanlineShimmer, s.scanlineShimmer);
        gl.uniform1f(this.uCRT.zoom, s.zoom);
        gl.uniform2f(this.uCRT.pan, s.pan.x, s.pan.y);
        gl.uniform1f(this.uCRT.cellOffset, s.cellOffset);
        gl.uniform1f(this.uCRT.exposure, s.exposure);
        gl.uniform1f(this.uCRT.time, time * 0.001);
        gl.uniform1f(this.uCRT.frame, this._frame);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.blueNoiseTex);
        this._drawQuad(this.progCRT);
        this._frame++;

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFBO.fb);
        gl.viewport(0, 0, this.fboW, this.fboH);
        gl.useProgram(this.progBloom);
        gl.uniform1i(this.uBloom.input, 0);
        gl.uniform2f(this.uBloom.resolution, this.fboW, this.fboH);
        gl.uniform1f(this.uBloom.bloomRadius, s.bloomRadius);
        gl.uniform1f(this.uBloom.bloomGlow, s.bloomGlow);
        gl.uniform1f(this.uBloom.bloomBase, s.bloomBase);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.crtFBO.tex);
        this._drawQuad(this.progBloom);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.useProgram(this.progPresent);
        gl.uniform1i(this.uPresent.input, 0);
        gl.uniform1f(this.uPresent.gammaEnabled, s.gammaEnabled);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.bloomFBO.tex);
        this._drawQuad(this.progPresent);
    }

    _drawQuad(program) {
        const gl = this.gl;
        const pos = gl.getAttribLocation(program, 'aPos');
        gl.enableVertexAttribArray(pos);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    _generateBlueNoise(size) {
        const gl = this.gl;
        const n = size * size;
        const data = new Uint8Array(n * 4);
        const sigma2 = 2.0 * 1.5 * 1.5;
        const r = 3;

        const makeChannel = (seed) => {
            let s = seed >>> 0;
            const wn = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                s = Math.imul(s, 1664525) + 1013904223 >>> 0;
                wn[i] = (s >>> 8) / 16777216.0;
            }

            const energy = new Float32Array(n);
            const rank = new Uint8Array(n);
            const order = Array.from({ length: n }, (_, i) => i);
            order.sort((a, b) => wn[a] - wn[b]);

            for (let step = 0; step < n; step++) {
                let best = -1;
                let bestE = Infinity;
                for (let j = step; j < n; j++) {
                    const idx = order[j];
                    if (energy[idx] < bestE) {
                        bestE = energy[idx];
                        best = j;
                    }
                }
                const tmp = order[step];
                order[step] = order[best];
                order[best] = tmp;
                const idx = order[step];
                rank[idx] = step;

                const px = idx % size;
                const py = (idx / size) | 0;
                for (let dy = -r; dy <= r; dy++) {
                    for (let dx = -r; dx <= r; dx++) {
                        const nx = (px + dx + size) % size;
                        const ny = (py + dy + size) % size;
                        energy[ny * size + nx] += Math.exp(-(dx * dx + dy * dy) / sigma2);
                    }
                }
            }

            const out = new Uint8Array(n);
            for (let i = 0; i < n; i++) out[i] = Math.round((rank[i] / (n - 1)) * 255);
            return out;
        };

        const rCh = makeChannel(0xDEADBEEF);
        const gCh = makeChannel(0xCAFEBABE);
        const bCh = makeChannel(0x12345678);

        for (let i = 0; i < n; i++) {
            data[i * 4 + 0] = rCh[i];
            data[i * 4 + 1] = gCh[i];
            data[i * 4 + 2] = bCh[i];
            data[i * 4 + 3] = 255;
        }

        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        return tex;
    }

    _createTex(w, h, isFloat, nearest) {
        const gl = this.gl;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        const internal = isFloat ? gl.RGBA16F : gl.RGBA;
        const type = isFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
        const filter = nearest ? gl.NEAREST : gl.LINEAR;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return tex;
    }

    _createFBO(w, h, nearest) {
        const gl = this.gl;
        const tex = this._createTex(w, h, true, nearest);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        return { fb, tex };
    }

    _compile(vsrc, fsrc) {
        const gl = this.gl;
        const vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, vsrc);
        gl.compileShader(vs);
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
            console.error('Vertex shader error:', gl.getShaderInfoLog(vs));
        }

        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, fsrc);
        gl.compileShader(fs);
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
            console.error('Fragment shader error:', gl.getShaderInfoLog(fs));
        }

        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error('Program link error:', gl.getProgramInfoLog(program));
        }
        return program;
    }
}


