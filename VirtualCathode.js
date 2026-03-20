class VirtualCathode {
    constructor(source, canvas) {
        this.source = source;
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl2', { antialias: false });

        this.settings = {
            zoom: 1.0,
            pan: { x: 0.5, y: 0.5 },
            persistence: 0.85,
            maskStrength: 0.8,
            curvature: 0.02,
            maskScale: 600.0,
            blurAmount: 0.05,
            bloomCore: 0.5,
            bloomMid: 0.2,
            bloomHalo: 0.1,
            clipExponent: 3.0,
        };

        this.init();
    }

    init() {
        const gl = this.gl;
        gl.getExtension('EXT_color_buffer_float');

        this.mainProg = this.createProgram(this.vShader, this.fShaderMain);
        this.blurProg = this.createProgram(this.vShader, this.fShaderBlur);

        const verts = new Float32Array([-1,-1, 1,-1, -1,1, 1,1]);
        this.vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

        this.res = { w: 2048, h: 2048 };
        this.fboA = this.createFBO(this.res.w, this.res.h);
        this.fboB = this.createFBO(this.res.w, this.res.h);
        this.fboBloomCore = this.createFBO(512, 512);
        this.fboBloomMid = this.createFBO(256, 256);
        this.fboBloomHalo = this.createFBO(128, 128);
        this.sourceTex = this.createTex(1024, 1024, false);

        this.currFBO = this.fboA;
        this.prevFBO = this.fboB;
    }

    render(time) {
        const gl = this.gl;

        gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.source);

        // PASS 1: Signal + persistence
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.currFBO.fb);
        gl.viewport(0, 0, this.res.w, this.res.h);
        gl.useProgram(this.mainProg);
        this.setSignalUniforms();
        this.draw(this.mainProg);

        // PASS 2: Multi-scale bloom
        gl.useProgram(this.blurProg);
        this.runBlur(this.fboBloomCore, 512, 1.5);
        this.runBlur(this.fboBloomMid, 256, 3.0);
        this.runBlur(this.fboBloomHalo, 128, 6.0);

        // PASS 3: Composite to screen
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.useProgram(this.mainProg);
        this.setCompositeUniforms();
        this.draw(this.mainProg);

        [this.currFBO, this.prevFBO] = [this.prevFBO, this.currFBO];
    }

    runBlur(targetFBO, size, blurSize) {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, targetFBO.fb);
        gl.viewport(0, 0, size, size);

        const p = this.blurProg;
        gl.uniform1i(gl.getUniformLocation(p, "uInput"), 0);
        gl.uniform1f(gl.getUniformLocation(p, "uBlurSize"), blurSize);
        gl.uniform2f(gl.getUniformLocation(p, "uResolution"), size, size);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.currFBO.tex);

        this.draw(this.blurProg);
    }

    setSignalUniforms() {
        const gl = this.gl;
        const p = this.mainProg;
        const u = (n) => gl.getUniformLocation(p, n);

        gl.uniform1i(u("uPass"), 0);
        gl.uniform1i(u("uSignal"), 0);
        gl.uniform1i(u("uPrev"), 1);
        gl.uniform1f(u("uZoom"), this.settings.zoom);
        gl.uniform2f(u("uPan"), this.settings.pan.x, this.settings.pan.y);
        gl.uniform1f(u("uCurv"), this.settings.curvature);
        gl.uniform1f(u("uPersist"), this.settings.persistence);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.prevFBO.tex);
    }

    setCompositeUniforms() {
        const gl = this.gl;
        const p = this.mainProg;
        const u = (n) => gl.getUniformLocation(p, n);

        gl.uniform1i(u("uPass"), 1);
        gl.uniform1f(u("uZoom"), this.settings.zoom);
        gl.uniform2f(u("uPan"), this.settings.pan.x, this.settings.pan.y);
        gl.uniform1f(u("uCurv"), this.settings.curvature);
        gl.uniform1f(u("uMask"), this.settings.maskStrength);
        gl.uniform1f(u("uMaskScale"), this.settings.maskScale);
        gl.uniform1f(u("uBlurAmt"), this.settings.blurAmount);
        gl.uniform1f(u("uBloomCoreW"), this.settings.bloomCore);
        gl.uniform1f(u("uBloomMidW"), this.settings.bloomMid);
        gl.uniform1f(u("uBloomHaloW"), this.settings.bloomHalo);
        gl.uniform1f(u("uClipExp"), this.settings.clipExponent);

        gl.uniform1i(u("uAccum"), 1);
        gl.uniform1i(u("uBloomCore"), 2);
        gl.uniform1i(u("uBloomMid"), 3);
        gl.uniform1i(u("uBloomHalo"), 4);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.currFBO.tex);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.fboBloomCore.tex);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, this.fboBloomMid.tex);
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, this.fboBloomHalo.tex);
    }

    draw(prog) {
        const gl = this.gl;
        const pos = gl.getAttribLocation(prog, "position");
        gl.enableVertexAttribArray(pos);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    createTex(w, h, f) {
        const gl = this.gl;
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, f ? gl.RGBA16F : gl.RGBA, w, h, 0, gl.RGBA, f ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
    }

    createFBO(w, h) {
        const gl = this.gl;
        const fb = gl.createFramebuffer();
        const tex = this.createTex(w, h, true);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        return { fb, tex };
    }

    createProgram(v, f) {
        const gl = this.gl;
        const p = gl.createProgram();
        const vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, v);
        gl.compileShader(vs);
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS))
            console.error('VS:', gl.getShaderInfoLog(vs));
        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, f);
        gl.compileShader(fs);
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS))
            console.error('FS:', gl.getShaderInfoLog(fs));
        gl.attachShader(p, vs);
        gl.attachShader(p, fs);
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS))
            console.error('Link:', gl.getProgramInfoLog(p));
        return p;
    }

    get vShader() {
        return `#version 300 es
        in vec2 position;
        out vec2 vUV;
        void main() {
            vUV = position * 0.5 + 0.5;
            gl_Position = vec4(position, 0.0, 1.0);
        }`;
    }

    get fShaderMain() {
        return `#version 300 es
        precision highp float;

        uniform float uZoom, uCurv, uPersist;
        uniform vec2 uPan;
        uniform int uPass;

        // Signal pass
        uniform sampler2D uSignal, uPrev;

        // Composite pass
        uniform sampler2D uAccum, uBloomCore, uBloomMid, uBloomHalo;
        uniform float uMask, uMaskScale, uBlurAmt;
        uniform float uBloomCoreW, uBloomMidW, uBloomHaloW;
        uniform float uClipExp;

        in vec2 vUV;
        out vec4 outColor;

        float phosphor(float x, float center, float width, float blur) {
            return smoothstep(center - width - blur, center - width + blur, x)
                 * smoothstep(center + width + blur, center + width - blur, x);
        }

        void main() {
            vec2 uv = (vUV - 0.5) * 2.0;
            float r2 = dot(uv, uv);
            uv *= 1.0 + r2 * uCurv + r2 * r2 * (uCurv * 0.5);
            uv = uv / 2.0 + 0.5;

            if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
                outColor = vec4(0, 0, 0, 1);
                return;
            }

            vec2 sUV = (uv - uPan) / uZoom + 0.5;

            if (uPass == 0) {
                // === SIGNAL + PHOSPHOR PERSISTENCE ===
                vec3 sig = texture(uSignal, vec2(sUV.x, 1.0 - sUV.y)).rgb;
                vec3 old = texture(uPrev, vUV).rgb;
                // Phosphors decay, new signal shows if brighter
                outColor = vec4(max(old * uPersist, sig), 1.0);

            } else {
                // === COMPOSITE PASS ===
                vec3 phos = texture(uAccum, vUV).rgb;
                vec3 bloomC = texture(uBloomCore, vUV).rgb;
                vec3 bloomM = texture(uBloomMid, vUV).rgb;
                vec3 bloomH = texture(uBloomHalo, vUV).rgb;

                vec3 bloom = bloomC * uBloomCoreW + bloomM * uBloomMidW + bloomH * uBloomHaloW;

                // Staggered slot mask (dot-triad / brick pattern)
                vec2 mUV = sUV * vec2(uMaskScale, uMaskScale * 0.5);
                if (mod(floor(mUV.x), 2.0) > 0.5) { mUV.y += 0.5; }
                vec2 cell = fract(mUV);

                // fwidth-based adaptive blur (auto LOD with zoom)
                float fw = length(fwidth(mUV));
                float b = uBlurAmt + fw;

                // RGB phosphor capsules
                float pr = phosphor(cell.x, 0.16, 0.12, b);
                float pg = phosphor(cell.x, 0.50, 0.12, b);
                float pb = phosphor(cell.x, 0.83, 0.12, b);

                // Vertical slot rounding
                float slot = phosphor(cell.y, 0.5, 0.42, b * 2.0);

                vec3 mask = vec3(pr, pg, pb) * slot;
                mask = mix(vec3(1.0 - uMask), vec3(1.2), mask);

                // Combine phosphor + bloom through mask
                vec3 color = (phos + bloom) * mask;

                // Energy clipping: bright spots blow out toward white
                float luma = dot(color, vec3(0.299, 0.587, 0.114));
                color = mix(color, vec3(luma), pow(clamp(luma, 0.0, 1.0), uClipExp));

                outColor = vec4(color, 1.0);
            }
        }`;
    }

    get fShaderBlur() {
        return `#version 300 es
        precision highp float;
        uniform sampler2D uInput;
        uniform float uBlurSize;
        uniform vec2 uResolution;
        in vec2 vUV;
        out vec4 color;
        void main() {
            vec2 d = uBlurSize / uResolution;
            vec3 b = texture(uInput, vUV).rgb * 0.25;
            b += texture(uInput, vUV + vec2(d.x, 0.0)).rgb * 0.125;
            b += texture(uInput, vUV - vec2(d.x, 0.0)).rgb * 0.125;
            b += texture(uInput, vUV + vec2(0.0, d.y)).rgb * 0.125;
            b += texture(uInput, vUV - vec2(0.0, d.y)).rgb * 0.125;
            b += texture(uInput, vUV + d).rgb * 0.0625;
            b += texture(uInput, vUV - d).rgb * 0.0625;
            b += texture(uInput, vUV + vec2(d.x, -d.y)).rgb * 0.0625;
            b += texture(uInput, vUV + vec2(-d.x, d.y)).rgb * 0.0625;
            color = vec4(b, 1.0);
        }`;
    }
}
