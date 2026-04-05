const SHADERTOY_SCENE_VERT = `#version 300 es
in vec2 aPos;
out vec2 vUV;
void main() {
    vUV = aPos * 0.5 + 0.5;
    gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const SHADERTOY_SCENE_FRAG = `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uTime;
uniform sampler2D uOverlay;

in vec2 vUV;
out vec4 outColor;

void main() {
    vec2 fragCoord = vUV * uResolution;
    vec4 O = vec4(0.0);
    vec2 r = uResolution;
    vec2 p = (fragCoord - r * vec2(0.53, 0.58)) * mat2(1.0, -1.0, 2.0, 2.0);

    for (float i = 0.0, a = 0.0; i < 10.0; i += 1.0) {
        vec2 I = p / (r + r - p).y * 30.0;
        float ring = 1.0 / (abs(length(I) - i) + 40.0 / r.y);
        a = atan(I.y, I.x) * ceil(i * 0.2) + uTime * sin(i * i) + i * i;
        float arc = clamp(cos(a), 0.0, 0.1);
        O += ring * arc * (cos(a - i + vec4(0.0, 2.0, 3.0, 0.0)) + 1.0);
    }

    vec2 overlayUV = fragCoord / uResolution;
    vec4 overlay = texture(uOverlay, vec2(overlayUV.x, 1.0 - overlayUV.y));
    vec3 color = clamp(O.rgb, 0.0, 1.0);
    color = mix(color, overlay.rgb, overlay.a);
    outColor = vec4(color, 1.0);
}`;

class ShadertoyScene {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false });
        if (!this.gl) throw new Error('WebGL2 required');

        this.overlayCanvas = document.createElement('canvas');
        this.overlayCanvas.width = canvas.width;
        this.overlayCanvas.height = canvas.height;
        this.overlayCtx = this.overlayCanvas.getContext('2d');

        this._init();
    }

    _init() {
        const gl = this.gl;

        this.vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

        this.overlayTex = this._createTex(2, 2);
        this.program = this._compile(SHADERTOY_SCENE_VERT, SHADERTOY_SCENE_FRAG);
        this.uniforms = {
            resolution: gl.getUniformLocation(this.program, 'uResolution'),
            time: gl.getUniformLocation(this.program, 'uTime'),
            overlay: gl.getUniformLocation(this.program, 'uOverlay'),
        };
    }

    render(time) {
        const gl = this.gl;
        if (this.overlayCanvas.width !== this.canvas.width || this.overlayCanvas.height !== this.canvas.height) {
            this.overlayCanvas.width = this.canvas.width;
            this.overlayCanvas.height = this.canvas.height;
        }

        this._drawOverlay(time);

        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.useProgram(this.program);
        gl.uniform2f(this.uniforms.resolution, this.canvas.width, this.canvas.height);
        gl.uniform1f(this.uniforms.time, time * 0.001);
        gl.uniform1i(this.uniforms.overlay, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.overlayTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.overlayCanvas);
        this._drawQuad();
    }

    _drawOverlay(time) {
        const ctx = this.overlayCtx;
        const w = this.overlayCanvas.width;
        const h = this.overlayCanvas.height;
        const now = new Date();
        const timeText = now.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });

        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(0, 0, 0, 0)';
        ctx.fillRect(0, 0, w, h);

        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.font = '600 22px "Trebuchet MS", "Gill Sans", sans-serif';
        ctx.fillStyle = 'rgba(210, 236, 248, 0.86)';
        ctx.fillText('Shadertoy CRT Scene', 20, 20);

        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.font = '600 28px "Trebuchet MS", "Gill Sans", sans-serif';
        ctx.fillStyle = 'rgba(245, 250, 255, 0.96)';
        ctx.shadowColor = 'rgba(255, 255, 255, 0.2)';
        ctx.shadowBlur = 4;
        ctx.fillText(timeText, w - 22, h - 18);
        ctx.shadowBlur = 0;

        const pulse = 0.5 + 0.5 * Math.sin(time * 0.0012);
        ctx.strokeStyle = `rgba(177, 228, 255, ${0.28 + pulse * 0.18})`;
        ctx.lineWidth = 2;
        ctx.strokeRect(26, h - 74, 180, 28);
        ctx.fillStyle = 'rgba(187, 236, 255, 0.55)';
        ctx.fillRect(30, h - 70, 172 * pulse, 20);
    }

    _drawQuad() {
        const gl = this.gl;
        const pos = gl.getAttribLocation(this.program, 'aPos');
        gl.enableVertexAttribArray(pos);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    _createTex(w, h) {
        const gl = this.gl;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return tex;
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
