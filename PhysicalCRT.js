class PhysicalCRT {
    constructor(source, canvas) {
        this.source = source;
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl2');
        this.settings = {
            zoom: 1.0,
            pan: { x: 0, y: 0 },
            maskStren: 0.8,
            maskBlur: 0.1, // This is your Focus
            convergence: 0.3,
            scanline: 0.4,
            vignette: 2.0
        };
        this._init();
    }

    _init() {
        const gl = this.gl;
        const vsSource = `#version 300 es
        in vec2 aPos;
        out vec2 vUV;
        void main() {
            vUV = aPos * 0.5 + 0.5;
            gl_Position = vec4(aPos, 0.0, 1.0);
        }`;

        const fsSource = `#version 300 es
        precision highp float;
        uniform sampler2D uTex;
        uniform vec2 uTexSize;
        uniform float uZoom;
        uniform vec2 uPan;
        uniform float uMaskStren;
        uniform float uMaskBlur; 
        uniform float uScanline;
        uniform float uConvergence;
        uniform float uVignette;
        in vec2 vUV;
        out vec4 outColor;

        void main() {
            // 1. Coordinates
            vec2 centered = vUV * 2.0 - 1.0;
            float r2 = dot(centered, centered);
            centered *= 1.0 + r2 * 0.015; 
            vec2 uv = centered * 0.5 + 0.5;

            if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
                outColor = vec4(0.0, 0.0, 0.0, 1.0); return;
            }

            vec2 coords = (uv - 0.5) / uZoom + 0.5;
            coords += uPan;

            // 2. Point-Sampled Beam (Sharpness Restoration)
            float shift = uConvergence * 0.0008;
            vec3 beam;
            beam.r = texture(uTex, vec2(coords.x + shift, coords.y)).r;
            beam.g = texture(uTex, coords).g;
            beam.b = texture(uTex, vec2(coords.x - shift, coords.y)).b;
            beam = pow(beam, vec3(2.2));

            // 3. Physical Mask Logic
            vec2 pixelCoord = coords * uTexSize;
            vec2 f = fract(pixelCoord);
            
            // Vertical (Scanlines)
            float scan = exp(-pow((f.y - 0.5) / 0.4, 2.0));
            beam *= mix(1.0, scan, uScanline);

            // Horizontal (Aperture Grille)
            // We use a sharper cosine power to prevent the rainbow overlap
            float px = f.x * 6.283185;
            
            // Focus control (uMaskBlur) now controls the width of the phosphor "hit"
            // High focus (low value) = narrow phosphor hit
            float pWidth = 1.0 + (uMaskBlur * 5.0); 
            
            vec3 mask;
            mask.g = pow(max(0.0, cos(px)), pWidth);
            mask.r = pow(max(0.0, cos(px + 2.0944)), pWidth);
            mask.b = pow(max(0.0, cos(px - 2.0944)), pWidth);
            
            // Normalize mask energy so focus doesn't kill brightness
            mask *= (1.0 + uMaskBlur * 2.0);
            
            beam *= mix(vec3(1.0), mask * 2.0, uMaskStren);

            // 4. Final Output
            float vign = pow(cos(clamp(length(centered) * 0.5, 0.0, 1.57)), uVignette);
            outColor = vec4(pow(beam * vign, vec3(1.0 / 2.2)), 1.0);
        }`;

        this.prog = gl.createProgram();
        const vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, vsSource); gl.compileShader(vs);
        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, fsSource); gl.compileShader(fs);
        gl.attachShader(this.prog, vs); gl.attachShader(this.prog, fs);
        gl.linkProgram(this.prog);

        this.vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
        this.tex = gl.createTexture();
    }

    render() {
        const gl = this.gl;
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.source);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.useProgram(this.prog);
        const loc = (n) => gl.getUniformLocation(this.prog, n);
        gl.uniform2f(loc('uTexSize'), this.source.width, this.source.height);
        gl.uniform1f(loc('uZoom'), this.settings.zoom);
        gl.uniform2f(loc('uPan'), this.settings.pan.x, this.settings.pan.y);
        gl.uniform1f(loc('uMaskStren'), this.settings.maskStren);
        gl.uniform1f(loc('uMaskBlur'), this.settings.maskBlur);
        gl.uniform1f(loc('uScanline'), this.settings.scanline);
        gl.uniform1f(loc('uConvergence'), this.settings.convergence);
        gl.uniform1f(loc('uVignette'), this.settings.vignette);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
}