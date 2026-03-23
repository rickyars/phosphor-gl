# CRT Shader Demo

A browser-based WebGL2 port of a multi-pass Shadertoy CRT effect.

The current demo uses a three-stage pipeline:

1. `bufferA.txt` inspired procedural scene generation
2. `bufferB.txt` inspired CRT mask pass
3. `shadertoy.txt` inspired bloom/final pass

The live demo entry point is [`index.html`](/g:/My%20Drive/Art/CRT/crt-shader/index.html), and the active renderer is [`ShadertoyCRT.js`](/g:/My%20Drive/Art/CRT/crt-shader/ShadertoyCRT.js).

## Controls

The Tweakpane controls expose the main CRT parameters:

- view: zoom, pan, curvature, vignette
- bloom: radius, glow, base
- mask: intensity, size, border, stagger, aberration
- tone: exposure and pulse animation

## Notes

- The demo now renders a shader-generated scene and also injects a live clock overlay in the bottom-right corner so text and fonts can be evaluated through the CRT effect.
- This is a WebGL2 adaptation of a Shadertoy effect, not a bit-perfect runtime clone of the Shadertoy environment.
