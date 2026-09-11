"use client";

// GradientWave - the Stripe mesh-gradient field, recoloured for Coorwa. Zero dependencies: one
// WebGL canvas that fills its parent, the same contract as ShaderBackground.
//
// A deformed plane is drawn once per frame. Its vertices ride a simplex-noise wave, and each
// colour after the first is a second noise field smoothstepped into a soft mask, so the colours
// read as folded sheets rather than as a blur.
//
// Four changes on the way into this project:
//   1. The colours are Coorwa's, taken from the tokens in globals.css - see WAVE.
//   2. It measures its own container, not the window. The hero is an 980px band, so a field sized
//      to window.innerHeight would be cropped at the top and stretched everywhere else.
//   3. It honours prefers-reduced-motion, and it stops when the tab is hidden or the field is
//      scrolled out of view. A background that animates behind the fold is pure battery.
//   4. Four colours, not more. u_active_colors is a vec4, so a fifth wave layer indexes it out of
//      bounds - undefined behaviour in GLSL, and in practice a layer that flickers on some drivers.

import { useEffect, useRef } from "react";
import { useTheme } from "@/lib/use-theme";

/*
 * The recipe. Everything tuneable lives here rather than in props, the way the mesh-drift shader
 * keeps its UNIFORMS block, so a change of look is a diff in one place.
 *
 * The first colour is the sheet; the rest are the layers folded over it. Warm paper, then the two
 * ambers out of the logo, then the near-white tint on top so the highlights sit above the amber
 * instead of under it.
 */
const WAVE = {
  colors: ["#f7f1e5", "#f0b860", "#f8d080", "#fdf4e6"],
  /*
   * The same recipe on the dark ground: the page's cocoa as the sheet, the two ambers turned down so
   * cream headline text still reads over the brightest fold, and a dark sheet on top where the light
   * palette has its near-white one, so the amber shows as seams between dark folds.
   */
  darkColors: ["#14100b", "#5a3514", "#a8692a", "#1c160f"],
  // Large, slow cells. Anything faster reads as a screensaver behind text.
  noiseFreq: [0.00024, 0.00052] as [number, number],
  noiseSpeed: 0.0000042,
  /*
   * How hard the edge of a fold is. Each layer is a noise field pushed through smoothstep, so a
   * wide window fades the layer in across the whole hero and reads as haze; this narrow one keeps
   * a sheet with a visible edge, which is the whole point of the effect.
   */
  layerMask: { floor: 0.24, ceil: 0.56, ceilStep: 0.05 },
  vertDeform: {
    incline: 0.42,
    offsetTop: -0.35,
    offsetBottom: -0.55,
    noiseFreq: [2.6, 3.4] as [number, number],
    noiseAmp: 210,
    noiseSpeed: 9,
    noiseFlow: 4.5,
    noiseSeed: 5,
  },
  // The top shading is for dark fields. On paper it only muddies the amber.
  darkenTop: false,
  shadowPower: 6,
  // Milliseconds of simulated time per frame, capped so a stalled tab does not jump the field.
  maxFrameMs: 1000 / 15,
  // Same budget as the mesh-drift shader: a retina hero is not worth 8M fragments.
  maxPixels: 2_000_000,
};

type UniformType = "float" | "int" | "vec2" | "vec3" | "vec4" | "mat4" | "array" | "struct";
type UniformValue = number | number[] | Uniform[] | Record<string, Uniform>;

/*
 * Uniforms describe themselves. Each one knows how to declare itself in GLSL and how to upload
 * itself, which is what lets the wave layers be an array of structs whose length is fixed at
 * compile time from the colour list.
 */
class Uniform {
  type: UniformType;
  value: UniformValue;
  excludeFrom?: "vertex" | "fragment";
  transpose: boolean;

  constructor(options: {
    type?: UniformType;
    value: UniformValue;
    excludeFrom?: "vertex" | "fragment";
    transpose?: boolean;
  }) {
    this.type = options.type ?? "float";
    this.value = options.value;
    this.excludeFrom = options.excludeFrom;
    this.transpose = options.transpose ?? false;
  }

  update(gl: WebGLRenderingContext, location: WebGLUniformLocation | null) {
    if (location === null) return;
    switch (this.type) {
      case "float":
        gl.uniform1f(location, this.value as number);
        break;
      case "int":
        gl.uniform1i(location, this.value as number);
        break;
      case "vec2":
        gl.uniform2fv(location, this.value as number[]);
        break;
      case "vec3":
        gl.uniform3fv(location, this.value as number[]);
        break;
      case "vec4":
        gl.uniform4fv(location, this.value as number[]);
        break;
      case "mat4":
        gl.uniformMatrix4fv(location, this.transpose, this.value as number[]);
        break;
      default:
        // Arrays and structs are flattened into their leaves when the program is linked.
        break;
    }
  }

  getDeclaration(name: string, shader: "vertex" | "fragment", length?: number): string {
    if (this.excludeFrom === shader) return "";

    if (this.type === "array") {
      const members = this.value as Uniform[];
      return `${members[0].getDeclaration(name, shader, members.length)}
const int ${name}_length = ${members.length};`;
    }

    if (this.type === "struct") {
      const bare = name.replace("u_", "");
      const typeName = bare.charAt(0).toUpperCase() + bare.slice(1);
      const fields = Object.entries(this.value as Record<string, Uniform>)
        .map(([field, uniform]) => uniform.getDeclaration(field, shader).replace(/^uniform/, ""))
        .join("");
      return `uniform struct ${typeName} {
${fields}
} ${name}${length ? `[${length}]` : ""};`;
    }

    return `uniform ${this.type} ${name}${length ? `[${length}]` : ""};`;
  }
}

type AttributeTarget = WebGLRenderingContext["ARRAY_BUFFER" | "ELEMENT_ARRAY_BUFFER"];

class Attribute {
  buffer: WebGLBuffer;
  values?: Float32Array | Uint16Array;

  constructor(
    private gl: WebGLRenderingContext,
    readonly target: AttributeTarget,
    readonly size: number,
    readonly type: number,
  ) {
    this.buffer = gl.createBuffer()!;
  }

  update() {
    if (!this.values) return;
    this.gl.bindBuffer(this.target, this.buffer);
    this.gl.bufferData(this.target, this.values, this.gl.STATIC_DRAW);
  }

  attach(name: string, program: WebGLProgram): number {
    const location = this.gl.getAttribLocation(program, name);
    this.use(location);
    return location;
  }

  use(location: number) {
    this.gl.bindBuffer(this.target, this.buffer);
    if (this.target !== this.gl.ARRAY_BUFFER || location < 0) return;
    this.gl.enableVertexAttribArray(location);
    this.gl.vertexAttribPointer(location, this.size, this.type, false, 0, 0);
  }
}

class Material {
  program: WebGLProgram;
  private instances: { uniform: Uniform; location: WebGLUniformLocation | null }[] = [];

  constructor(
    private gl: WebGLRenderingContext,
    common: Record<string, Uniform>,
    uniforms: Record<string, Uniform>,
    vertexBody: string,
    fragmentBody: string,
  ) {
    const declare = (set: Record<string, Uniform>, shader: "vertex" | "fragment") =>
      Object.entries(set)
        .map(([name, uniform]) => uniform.getDeclaration(name, shader))
        .join("\n");

    const vertexSource = `precision highp float;
attribute vec4 position;
attribute vec2 uv;
attribute vec2 uvNorm;
${declare(common, "vertex")}
${declare(uniforms, "vertex")}
${vertexBody}`;

    const fragmentSource = `precision highp float;
${declare(common, "fragment")}
${declare(uniforms, "fragment")}
${fragmentBody}`;

    this.program = gl.createProgram()!;
    const vertexShader = this.compile(gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = this.compile(gl.FRAGMENT_SHADER, fragmentSource);
    gl.attachShader(this.program, vertexShader);
    gl.attachShader(this.program, fragmentShader);
    gl.linkProgram(this.program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(this.program) ?? "gradient program failed to link");
    }

    gl.useProgram(this.program);
    this.bind(common);
    this.bind(uniforms);
  }

  private compile(type: number, source: string): WebGLShader {
    const shader = this.gl.createShader(type)!;
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);
    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      // A lost context answers null to every query, so name that case rather than reporting an
      // empty compile error nobody can act on.
      const log = this.gl.getShaderInfoLog(shader);
      throw new Error(log || "gradient shader failed to compile (context lost?)");
    }
    return shader;
  }

  // Walks structs and arrays down to their leaves, because GLSL has a location per leaf and none
  // for the aggregate.
  private bind(uniforms: Record<string, Uniform>, prefix?: string) {
    for (const [name, uniform] of Object.entries(uniforms)) {
      const path = prefix ? `${prefix}.${name}` : name;
      if (uniform.type === "array") {
        (uniform.value as Uniform[]).forEach((member, index) => {
          this.bind({ [`${path}[${index}]`]: member });
        });
      } else if (uniform.type === "struct") {
        this.bind(uniform.value as Record<string, Uniform>, path);
      } else {
        this.instances.push({
          uniform,
          location: this.gl.getUniformLocation(this.program, path),
        });
      }
    }
  }

  upload() {
    for (const { uniform, location } of this.instances) uniform.update(this.gl, location);
  }
}

/*
 * A subdivided quad. The subdivision is the point: the wave is a vertex displacement, so the
 * plane needs enough rows to bend smoothly and no more than that.
 */
class PlaneGeometry {
  attributes: Record<"position" | "uv" | "uvNorm" | "index", Attribute>;
  private xSegCount = 0;
  private ySegCount = 0;
  private vertexCount = 0;

  constructor(private gl: WebGLRenderingContext) {
    this.attributes = {
      position: new Attribute(gl, gl.ARRAY_BUFFER, 3, gl.FLOAT),
      uv: new Attribute(gl, gl.ARRAY_BUFFER, 2, gl.FLOAT),
      uvNorm: new Attribute(gl, gl.ARRAY_BUFFER, 2, gl.FLOAT),
      index: new Attribute(gl, gl.ELEMENT_ARRAY_BUFFER, 3, gl.UNSIGNED_SHORT),
    };
  }

  setTopology(xSegs: number, ySegs: number) {
    this.xSegCount = xSegs;
    this.ySegCount = ySegs;
    this.vertexCount = (xSegs + 1) * (ySegs + 1);

    const uv = new Float32Array(2 * this.vertexCount);
    const uvNorm = new Float32Array(2 * this.vertexCount);
    const index = new Uint16Array(3 * xSegs * ySegs * 2);

    for (let y = 0; y <= ySegs; y++) {
      for (let x = 0; x <= xSegs; x++) {
        const i = y * (xSegs + 1) + x;
        uv[2 * i] = x / xSegs;
        uv[2 * i + 1] = 1 - y / ySegs;
        uvNorm[2 * i] = (x / xSegs) * 2 - 1;
        uvNorm[2 * i + 1] = 1 - (y / ySegs) * 2;

        if (x < xSegs && y < ySegs) {
          const quad = y * xSegs + x;
          index[6 * quad] = i;
          index[6 * quad + 1] = i + 1 + xSegs;
          index[6 * quad + 2] = i + 1;
          index[6 * quad + 3] = i + 1;
          index[6 * quad + 4] = i + 1 + xSegs;
          index[6 * quad + 5] = i + 2 + xSegs;
        }
      }
    }

    this.attributes.uv.values = uv;
    this.attributes.uvNorm.values = uvNorm;
    this.attributes.index.values = index;
    this.attributes.uv.update();
    this.attributes.uvNorm.update();
    this.attributes.index.update();
  }

  setSize(width: number, height: number) {
    const position = new Float32Array(3 * this.vertexCount);
    const segWidth = width / this.xSegCount;
    const segHeight = height / this.ySegCount;

    for (let y = 0; y <= this.ySegCount; y++) {
      const posY = height / -2 + y * segHeight;
      for (let x = 0; x <= this.xSegCount; x++) {
        const i = y * (this.xSegCount + 1) + x;
        position[3 * i] = width / -2 + x * segWidth;
        position[3 * i + 1] = -posY;
        position[3 * i + 2] = 0;
      }
    }

    this.attributes.position.values = position;
    this.attributes.position.update();
  }

  get indexCount() {
    return this.attributes.index.values?.length ?? 0;
  }

  dispose() {
    for (const attribute of Object.values(this.attributes)) {
      this.gl.deleteBuffer(attribute.buffer);
    }
  }
}

const VERTEX_BODY = `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

varying vec3 v_color;

void main() {
  float time = u_time * u_global.noiseSpeed;
  vec2 noiseCoord = resolution * uvNorm * u_global.noiseFreq;
  float tilt = resolution.y / 2.0 * uvNorm.y;
  float incline = resolution.x * uvNorm.x / 2.0 * u_vertDeform.incline;
  float offset = resolution.x / 2.0 * u_vertDeform.incline
    * mix(u_vertDeform.offsetBottom, u_vertDeform.offsetTop, uv.y);

  float noise = snoise(vec3(
    noiseCoord.x * u_vertDeform.noiseFreq.x + time * u_vertDeform.noiseFlow,
    noiseCoord.y * u_vertDeform.noiseFreq.y,
    time * u_vertDeform.noiseSpeed + u_vertDeform.noiseSeed
  )) * u_vertDeform.noiseAmp;

  noise *= 1.0 - pow(abs(uvNorm.y), 2.0);
  noise = max(0.0, noise);

  vec3 pos = vec3(position.x, position.y + tilt + incline + noise - offset, position.z);

  v_color = u_baseColor;

  for (int i = 0; i < u_waveLayers_length; i++) {
    WaveLayers layer = u_waveLayers[i];
    float layerNoise = smoothstep(
      layer.noiseFloor,
      layer.noiseCeil,
      snoise(vec3(
        noiseCoord.x * layer.noiseFreq.x + time * layer.noiseFlow,
        noiseCoord.y * layer.noiseFreq.y,
        time * layer.noiseSpeed + layer.noiseSeed
      )) / 2.0 + 0.5
    );
    v_color = mix(v_color, layer.color, pow(layerNoise, 4.0));
  }

  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}`;

const FRAGMENT_BODY = `
varying vec3 v_color;

void main() {
  vec3 color = v_color;
  if (u_darken_top == 1.0) {
    vec2 st = gl_FragCoord.xy / resolution.xy;
    color.g -= pow(st.y + sin(-12.0) * st.x, u_shadow_power) * 0.4;
  }
  gl_FragColor = vec4(color, 1.0);
}`;

function normalizeColor(hex: string): number[] {
  const value = parseInt(hex.replace("#", ""), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

class Gradient {
  private common: Record<string, Uniform>;
  private uniforms: Record<string, Uniform>;
  private material: Material;
  private geometry: PlaneGeometry;
  private attributeLocations: { attribute: Attribute; location: number }[] = [];

  constructor(
    private gl: WebGLRenderingContext,
    colors: string[],
  ) {
    const sectionColors = colors.slice(0, 4).map(normalizeColor);

    this.common = {
      projectionMatrix: new Uniform({ type: "mat4", value: IDENTITY }),
      modelViewMatrix: new Uniform({ type: "mat4", value: IDENTITY }),
      resolution: new Uniform({ type: "vec2", value: [1, 1] }),
      aspectRatio: new Uniform({ type: "float", value: 1 }),
    };

    const waveLayers = sectionColors.slice(1).map(
      (color, index) =>
        new Uniform({
          type: "struct",
          value: {
            color: new Uniform({ type: "vec3", value: color }),
            noiseFreq: new Uniform({
              type: "vec2",
              value: [
                2 + (index + 1) / sectionColors.length,
                3 + (index + 1) / sectionColors.length,
              ],
            }),
            noiseSpeed: new Uniform({ value: 11 + 0.3 * (index + 1) }),
            noiseFlow: new Uniform({ value: 6.5 + 0.3 * (index + 1) }),
            noiseSeed: new Uniform({ value: 5 + 10 * (index + 1) }),
            noiseFloor: new Uniform({ value: WAVE.layerMask.floor }),
            noiseCeil: new Uniform({
              value: WAVE.layerMask.ceil + WAVE.layerMask.ceilStep * index,
            }),
          },
        }),
    );

    this.uniforms = {
      u_time: new Uniform({ value: 0 }),
      u_shadow_power: new Uniform({ value: WAVE.shadowPower }),
      u_darken_top: new Uniform({ value: WAVE.darkenTop ? 1 : 0 }),
      u_global: new Uniform({
        type: "struct",
        value: {
          noiseFreq: new Uniform({ type: "vec2", value: [...WAVE.noiseFreq] }),
          noiseSpeed: new Uniform({ value: WAVE.noiseSpeed }),
        },
      }),
      u_vertDeform: new Uniform({
        type: "struct",
        excludeFrom: "fragment",
        value: {
          incline: new Uniform({ value: WAVE.vertDeform.incline }),
          offsetTop: new Uniform({ value: WAVE.vertDeform.offsetTop }),
          offsetBottom: new Uniform({ value: WAVE.vertDeform.offsetBottom }),
          noiseFreq: new Uniform({ type: "vec2", value: [...WAVE.vertDeform.noiseFreq] }),
          noiseAmp: new Uniform({ value: WAVE.vertDeform.noiseAmp }),
          noiseSpeed: new Uniform({ value: WAVE.vertDeform.noiseSpeed }),
          noiseFlow: new Uniform({ value: WAVE.vertDeform.noiseFlow }),
          noiseSeed: new Uniform({ value: WAVE.vertDeform.noiseSeed }),
        },
      }),
      u_baseColor: new Uniform({
        type: "vec3",
        excludeFrom: "fragment",
        value: sectionColors[0],
      }),
      u_waveLayers: new Uniform({ type: "array", excludeFrom: "fragment", value: waveLayers }),
    };

    this.material = new Material(gl, this.common, this.uniforms, VERTEX_BODY, FRAGMENT_BODY);
    this.geometry = new PlaneGeometry(gl);
    for (const [name, attribute] of Object.entries(this.geometry.attributes)) {
      this.attributeLocations.push({
        attribute,
        location: attribute.attach(name, this.material.program),
      });
    }
  }

  /*
   * Colours are uniforms, uploaded on every frame, so a new palette needs no new program. It does
   * need the same number of colours: the layer count is compiled into the shader, so extra colours
   * are ignored and missing ones keep their old value.
   */
  setColors(colors: string[]) {
    const [base, ...layers] = colors.slice(0, 4).map(normalizeColor);
    if (base) this.uniforms.u_baseColor.value = base;
    (this.uniforms.u_waveLayers.value as Uniform[]).forEach((layer, i) => {
      if (layers[i]) (layer.value as Record<string, Uniform>).color.value = layers[i];
    });
  }

  // `width` and `height` are CSS pixels and drive the camera, the plane and the noise field, so
  // the field looks the same on a retina display. `scale` only sizes the framebuffer under it.
  resize(width: number, height: number, scale: number) {
    this.gl.viewport(0, 0, Math.round(width * scale), Math.round(height * scale));
    this.common.resolution.value = [width, height];
    this.common.aspectRatio.value = width / height;
    // prettier-ignore
    this.common.projectionMatrix.value = [
      2 / width, 0,          0,      0,
      0,         2 / height, 0,      0,
      0,         0,          -0.001, 0,
      0,         0,          0,      1,
    ];

    this.geometry.setTopology(Math.ceil(width * 0.02), Math.ceil(height * 0.05));
    this.geometry.setSize(width, height);
  }

  render(timeMs: number) {
    this.uniforms.u_time.value = timeMs;
    this.gl.useProgram(this.material.program);
    this.material.upload();
    for (const { attribute, location } of this.attributeLocations) attribute.use(location);
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.gl.drawElements(this.gl.TRIANGLES, this.geometry.indexCount, this.gl.UNSIGNED_SHORT, 0);
  }

  dispose() {
    this.geometry.dispose();
    this.gl.deleteProgram(this.material.program);
  }
}

/*
 * Releasing the context is deferred by a tick, and a remount cancels the release. React mounts an
 * effect twice in development and keeps the same <canvas> node across the remount, so a synchronous
 * loseContext() in the cleanup hands the second mount back the same dead context - which then fails
 * to compile anything, with a null info log because a lost context answers null to everything.
 * ShaderBackground carries the same guard for the same reason.
 */
const pendingContextReleases = new WeakMap<HTMLCanvasElement, number>();

export function GradientWave({ className, colors }: { className?: string; colors?: string[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const theme = useTheme();
  // The colour list arrives as a fresh array literal on every render, so everything keys off the
  // joined string instead.
  const colorKey = (colors ?? (theme === "dark" ? WAVE.darkColors : WAVE.colors)).join(",");
  // What the GL effect starts from, and a handle on the running field, so a new palette reaches it
  // without tearing down the context. A theme switch then recolours the waves mid-motion instead
  // of restarting them from the first frame.
  const colorKeyRef = useRef(colorKey);
  const live = useRef<{ gradient: Gradient; redraw: () => void } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pendingRelease = pendingContextReleases.get(canvas);
    if (pendingRelease !== undefined) window.clearTimeout(pendingRelease);
    pendingContextReleases.delete(canvas);
    const gl = canvas.getContext("webgl", { antialias: true });
    if (!gl) return;

    let gradient: Gradient;
    try {
      gradient = new Gradient(gl, colorKeyRef.current.split(","));
    } catch (error) {
      // A field that will not compile is not worth a blank hero. Leave the page's own background.
      console.error("GradientWave failed to initialise", error);
      return;
    }

    // A background that moves on its own is the textbook case for this query. It still renders,
    // it just holds one frame.
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let raf = 0;
    let time = 0;
    let last: number | null = null;
    let visible = document.visibilityState === "visible";
    let inView = true;
    let disposed = false;

    const applySize = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const budget = Math.min(1, Math.sqrt(WAVE.maxPixels / (width * height * dpr * dpr)));
      const scale = dpr * budget;
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      gradient.resize(width, height, scale);
    };

    function frame(now: number) {
      raf = 0;
      if (disposed || !visible || !inView) return;
      // Reduced motion holds the field still, so scrolling it back into view must not advance it.
      time += calm || last === null ? 0 : Math.min(now - last, WAVE.maxFrameMs);
      last = now;
      gradient.render(time);
      if (!calm) request();
    }

    function request() {
      if (disposed || !visible || !inView || raf !== 0) return;
      raf = requestAnimationFrame(frame);
    }

    const pause = () => {
      if (raf === 0) return;
      cancelAnimationFrame(raf);
      raf = 0;
      last = null;
    };

    const onResize = () => {
      applySize();
      // Reduced motion holds one frame, so a resize has to redraw it explicitly.
      if (calm && visible && inView) gradient.render(time);
      else request();
    };
    const onVisibility = () => {
      visible = document.visibilityState === "visible";
      if (visible) request();
      else pause();
    };

    applySize();
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(canvas);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      inView = entry?.isIntersecting ?? true;
      if (inView) request();
      else pause();
    });
    intersectionObserver.observe(canvas);
    document.addEventListener("visibilitychange", onVisibility);
    request();

    // A running loop picks new colours up on its next frame; a held one has to be drawn again.
    live.current = {
      gradient,
      redraw: () => {
        if (calm && visible && inView) gradient.render(time);
      },
    };

    return () => {
      disposed = true;
      live.current = null;
      pause();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      gradient.dispose();
      const release = window.setTimeout(() => {
        if (pendingContextReleases.get(canvas) !== release) return;
        pendingContextReleases.delete(canvas);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
        canvas.width = 1;
        canvas.height = 1;
      }, 0);
      pendingContextReleases.set(canvas, release);
    };
  }, []);

  useEffect(() => {
    colorKeyRef.current = colorKey;
    live.current?.gradient.setColors(colorKey.split(","));
    live.current?.redraw();
  }, [colorKey]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ display: "block", width: "100%", height: "100%" }}
    />
  );
}
