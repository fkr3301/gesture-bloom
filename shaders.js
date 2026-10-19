/* ============================================================================
 * shaders.js —— 粒子花朵的 GLSL 着色器源码
 * ----------------------------------------------------------------------------
 * 单独成文件的目的：
 *   1. 着色器是这套效果的核心，独立出来便于调参和复用；
 *   2. 自动化测试可以 import 同一份源码，保证「测的就是线上跑的那份」。
 *
 * 顶点着色器负责：
 *   · 花苞态 / 绽放态位置插值（smoothstep 缓动）
 *   · 方向向量 slerp（避免线性插值让粒子在中间段向花心塌陷）
 *   · 指尖牵引、呼吸、飘动
 *   · 透视点尺寸 + 三档调色板取色 + 顶光/指尖高光
 *
 * 片元着色器负责：
 *   · 把方形点精灵画成「柔核 + 外晕」的圆形光斑（加色混合）
 * ========================================================================== */

export const VERTEX_SHADER = /* glsl */`
  // ---- 几何属性 ----
  attribute vec3 aPosBud;     // 花苞态位置（spread = 0）
  attribute vec3 aPosBloom;   // 绽放态位置（spread = 1）
  attribute vec3 aDirBud;     // 花苞态单位方向（用于 slerp 与光照）
  attribute vec3 aDirBloom;   // 绽放态单位方向
  attribute float aHue;       // 色相偏移 0~1
  attribute float aSize;      // 单粒子尺寸倍率
  attribute float aSparkle;   // 闪烁/飘动相位

  // ---- uniform ----
  uniform float uTime;        // 累计时间（秒）
  uniform float uSpread;      // 缓动后的绽放程度 0~1
  uniform vec3  uHover;       // 指尖（或指针）在世界空间的位置
  uniform float uHoverActive; // 指尖牵引强度 0~1
  uniform float uPixelScale;  // 屏幕高度 / tan(fov/2)，把世界尺寸换成像素
  uniform float uBaseSize;    // 单粒子基础尺寸（世界单位）
  uniform float uGlow;        // 光晕倍率（UI 可调）
  uniform float uIntro;       // 入场渐显 0~1
  uniform vec3  uColorCore;   // 调色板：花心
  uniform vec3  uColorMid;    // 调色板：花瓣中段
  uniform vec3  uColorEdge;   // 调色板：外沿

  // ---- 传给片元 ----
  varying vec3  vColor;
  varying float vIntensity;
  varying float vFade;
  varying float vGlowBoost;

  void main() {
    // 1. 绽放插值：smoothstep 让两端更柔和
    float b = smoothstep(0.0, 1.0, uSpread);

    // 花瓣「回卷」：b 在中间段时花瓣尖端向外卷，模拟花苞刚裂开的瞬间
    float curl = sin(b * 3.14159265) * 0.07;
    vec3 bloomPos = aPosBloom + aDirBloom * curl;

    vec3 pos = mix(aPosBud, bloomPos, b);

    // 2. 方向：球面插值（线性插值在中间段会变短，导致粒子向花心塌陷）
    vec3 dir = normalize(mix(aDirBud, aDirBloom, b));

    // 3. 呼吸：整体随 spread 轻微起伏，让花朵「活着」
    pos *= 1.0 + 0.020 * sin(uTime * 0.85 + pos.y * 2.2) * (0.35 + 0.65 * b);

    // 4. 指尖牵引：越靠近花心，受指尖影响越大
    vec3 toHover = uHover - pos;
    float hoverDist = length(toHover);
    float hold = exp(-hoverDist * 1.05);
    float anchor = mix(0.30, 1.0, smoothstep(1.25, 0.0, length(pos)));
    pos += toHover * hold * anchor * 0.34 * uHoverActive;

    // 5. 飘动：每颗粒子一点独立的低频抖动
    float wob = sin(uTime * 1.35 + aSparkle * 6.2831 + pos.x * 3.1);
    pos += dir * wob * 0.012 * (0.4 + 0.6 * b);

    // 6. 投影
    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    // 7. 点尺寸：透视缩放 × 尺寸倍率 × 闪烁 × 绽放后收缩
    // 绽放时花瓣铺开、中心变密，收缩 12% 可以避免花心糊成一团白
    float twinkle = 1.0 + 0.22 * wob;
    float sizeFalloff = 1.0 - 0.12 * b;
    gl_PointSize = max(1.0, uBaseSize * uGlow * aSize * twinkle * sizeFalloff * uPixelScale / max(-mvPosition.z, 0.05));

    // 8. 颜色：三档调色板取渐变
    //    aSparkle 编码「粒子在花朵里的径向位置」→ 决定调色板位置（花心深红 → 外沿奶油白）
    //    aHue     编码每颗粒子的随机相位 → 让相邻粒子有细微色差，形成自然色斑
    float pal = clamp(aSparkle * 0.62 + 0.38, 0.0, 1.0);
    vec3 colA = mix(uColorCore, uColorMid, smoothstep(0.0, 0.58, pal));
    vec3 colB = mix(colA, uColorEdge, smoothstep(0.46, 1.0, pal));
    // 每颗粒子的色相抖动（在暖粉区间内小幅偏移）
    vec3 warmShift = vec3(0.03, -0.02, 0.02) * (aHue - 0.5);
    vec3 colC = clamp(colB + warmShift, 0.0, 1.0);
    // 花苞时整体偏暗更「实」，绽放后外沿更亮（模拟受光）
    vec3 color = mix(colC * 0.88, colC, b);

    // 9. 指尖高光（放低一点，避免花瓣整体过曝）
    float boost = 1.0 + hold * 0.6 * uHoverActive;

    // 10. 顶光：朝上的粒子稍亮
    float lightDot = dot(dir, normalize(vec3(0.35, 0.9, 0.28)));
    float shade = 0.62 + 0.38 * clamp(lightDot * 0.5 + 0.5, 0.0, 1.0);

    vColor = color * shade * boost;
    vIntensity = 0.55 + 0.45 * twinkle;
    vFade = uIntro * (1.0 - 0.35 * smoothstep(1.6, 3.0, length(pos)));
    vGlowBoost = boost;
  }
`;

export const FRAGMENT_SHADER = /* glsl */`
  precision highp float;

  uniform vec3  uBgTint;    // 背景色调，让光晕与背景融合
  uniform float uOpacity;   // 全局透明度

  varying vec3  vColor;
  varying float vIntensity;
  varying float vFade;
  varying float vGlowBoost;

  void main() {
    // gl_PointCoord：点精灵内 0~1 坐标；换算成以圆心为原点的半径 d
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv) * 2.0;
    if (d > 1.0) discard;              // 裁成圆形

    // 柔核 + 外晕：两段衰减，视觉上像发光的花粉
    float core = pow(1.0 - d, 3.2);
    float halo = smoothstep(1.0, 0.0, d) * 0.42;
    float alpha = (core + halo) * vIntensity * uOpacity * vFade * vGlowBoost;

    // 加色混合下颜色会被累加，所以这里压低一点避免过曝。
    // 注意：预乘 alpha 之后单颗粒子的实际贡献 ≈ 颜色 × alpha，
    //       这个系数要与 uOpacity 一起调（见 main.js 里的说明）。
    vec3 col = vColor * (0.66 + 0.5 * core) + uBgTint * halo * 0.14;

    // 饱和度提升：加色叠加会把通道推向白色，这里按亮度做一次轻微的「去灰」，
    // 让花朵在大面积重叠后仍然保持粉红色调，而不是糊成白团。
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = clamp(lum + (col - lum) * 1.35, 0.0, 1.0);

    // 输出「预乘 alpha」颜色：
    // 画布是透明的（alpha: true），浏览器在合成时会用 canvas 的 alpha 做混合。
    // 实测若写成非预乘（vec4(col, alpha) 且 premultipliedAlpha: false），
    // 加色混合后 alpha 很低而颜色很高，部分浏览器/驱动会把这层在页面上显示为全黑，
    // 于是「GL 缓冲区里有画面、页面上却什么都看不到」。预乘形式最稳。
    gl_FragColor = vec4(col * alpha, alpha);
  }
`;
