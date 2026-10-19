/* ============================================================================
 * flowerMath.js —— 纯数学模块（不依赖 Three.js / MediaPipe / DOM）
 * ----------------------------------------------------------------------------
 * 提供两件事：
 *   A. 手势张合度 tension 的计算（0 = 握拳，1 = 完全张开）
 *   B. 粒子花朵的几何生成（花苞态 / 绽放态两组顶点位置）
 *
 * 之所以单独拆一个文件：
 *   1. 这部分逻辑最容易出错，抽出来可以在 Node 里直接跑数值自检；
 *   2. 浏览器和 Node 都能 import，方便调参时做可视化验证。
 * ========================================================================== */

/* ==========================================================================
 * 0. 工具函数
 * ======================================================================== */

export function clamp(v, lo = 0, hi = 1) {
  return v < lo ? lo : (v > hi ? hi : v);
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * 最大值归零归一化：与 GLSL 的 smoothstep 语义完全一致。
 * x <= e0 返回 0；x >= e1 返回 1；中间用 3t²-2t³ 平滑过渡（一阶导在两端为 0）。
 */
export function smoothstep(e0, e1, x) {
  if (e1 === e0) return x < e0 ? 0 : 1;
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

export function distance3(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * 3D 向量球面线性插值（slerp）。
 * 用于让粒子从「花苞里紧凑的朝向」平滑转到「花瓣展开后的朝向」，
 * 直接对方向向量做线性插值会在中间段变短、导致粒子往花心塌陷，slerp 不会。
 */
export function slerpDir(out, ax, ay, az, bx, by, bz, t) {
  let dot = ax * bx + ay * by + az * bz;
  dot = clamp(dot, -1, 1);

  // 夹角极小：退化为线性插值 + 重新归一化，避免 sin(θ)→0 时数值爆炸
  if (dot > 0.9995) {
    let x = lerp(ax, bx, t), y = lerp(ay, by, t), z = lerp(az, bz, t);
    const len = Math.hypot(x, y, z) || 1;
    out[0] = x / len; out[1] = y / len; out[2] = z / len;
    return out;
  }

  const theta = Math.acos(dot);
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;
  const x = ax * wa + bx * wb;
  const y = ay * wa + by * wb;
  const z = az * wa + bz * wb;
  const len = Math.hypot(x, y, z) || 1;
  out[0] = x / len; out[1] = y / len; out[2] = z / len;
  return out;
}

/** 把 (x,y,z) 归一化后写入目标数组的第 index 个三元组 */
function normalizeInto(target, index, x, y, z) {
  const len = Math.hypot(x, y, z);
  if (len < 1e-6) {
    // 退化情况：给一个朝上的默认方向，避免出现 (0,0,0) 方向导致 slerp 出错
    target[index * 3 + 0] = 0;
    target[index * 3 + 1] = 1;
    target[index * 3 + 2] = 0;
    return;
  }
  target[index * 3 + 0] = x / len;
  target[index * 3 + 1] = y / len;
  target[index * 3 + 2] = z / len;
}

/** 排序后再取反的 Halton 序列：比 Math.random() 分布均匀，适合做抖动 */
export function halton(index, base) {
  let f = 1, r = 0, i = index + 1;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

/* ==========================================================================
 * A. 手势张合度 tension
 * --------------------------------------------------------------------------
 * 【核心公式】
 *
 * 记 MediaPipe 的 21 个关键点为 P[0..20]，其中：
 *   P[0]  = 手腕 WRIST
 *   P[5]  = 食指根 MCP   P[9] = 中指根 MCP
 *   P[13] = 无名指根 MCP P[17] = 小指根 MCP
 *   P[4]、P[8]、P[12]、P[16]、P[20] = 拇指/食指/中指/无名指/小指指尖
 *
 * 第一步：掌心尺度（用来抵消远近和手大手小的影响）
 *      span   = |P[5] - P[17]|                      食指根↔小指根（掌宽）
 *      palm   = (|P[0]-P[5]| + |P[0]-P[9]| + |P[0]-P[13]|) / 3   （腕到掌指关节）
 *      size   = (palm + span) / 2                   掌心尺度
 *      兜底：size 太小（遮挡/退化）时用 span，再不行就用 1e-6 防除零
 *
 * 第二步：五指的伸展特征（尺度无关，纯粹是「指尖离手腕有多远」）
 *      dᵢ     = |P[0] - P[tipᵢ]|
 *      dᵢ_n   = dᵢ / size
 *      为压制异常帧，对 5 个值做「去掉最高最低再平均」的截尾平均：
 *      raw    = (Σ dᵢ_n - max - min) / 3
 *
 *      几何直觉（人手解剖比例）：腕→中指指尖 ≈ 1.0 倍手长，
 *      size ≈ 0.49 倍手长 ⇒ 完全张开时 raw ≈ 2.0~2.2；
 *      握拳时指尖卷向掌心，腕→指尖 ≈ 0.65 倍手长 ⇒ raw ≈ 1.25~1.4。
 *      拇指会拉高离散度，所以用截尾平均而不是普通平均。
 *    （个体差异 + 镜头透视会整体缩放这个区间，所以下面要做归一化，
 *      并且内置了「自动标定」持续学习使用者本人的两端取值）
 *
 * 第三步：归一化到 0~1
 *      tensionRaw = (raw - RAW_CLOSED) / (RAW_OPEN - RAW_CLOSED)
 *
 * 第四步：对比度压缩（让「半握」也能落在有意义的区间里）
 *      tensionRaw = clamp(tensionRaw)
 *      tensionRaw = smoothstep(0, 1, tensionRaw)  // S 型曲线
 *
 * 第五步：激活度（可选，用于抑制抖动）
 *      当 5 根手指全部蜷曲（每根都判定为「闭合」）时激活度快速趋近 0，
 *      此时强制把 tension 往 0 拉，避免握拳时数值在 0.1~0.3 之间乱跳。
 *
 * 结果：tension ∈ [0, 1]，0 = 握拳，1 = 完全张开。
 * ======================================================================== */

/**
 * 人体测量常数：默认标定区间的依据（单位 = 「腕→指尖距离 / 掌心尺度 size」）。
 *
 * 由成年手部的常见解剖比例推导：
 *   掌长（腕→中指 MCP）        ≈ 0.52 手长
 *   掌宽（MCP5 ↔ MCP17）       ≈ 0.31 手长
 *   手指长（三节之和）          ≈ 0.30 手长
 *   ⇒ size ≈ 0.42 手长
 *   ⇒ 张开：腕→中指指尖 ≈ 0.83 手长 → raw ≈ 0.83 / 0.42 ≈ 1.97
 *   ⇒ 握拳：腕→中指指尖 ≈ 0.53 手长 → raw ≈ 0.53 / 0.42 ≈ 1.26
 * 因为五指会做截尾平均（去掉最大最小），实际取值会略低于中指单指值，
 * 所以下面两个常数取 1.22 / 1.86。个体差异由 autoCalibrate 继续学习修正。
 */
export const ANATOMY = {
  tipOverSizeClosed: 1.22, // 握拳时 raw 的典型值
  tipOverSizeOpen: 1.86,   // 完全张开时 raw 的典型值
};

/** 手指闭合判定用的关键点索引：[指尖, 近端指节(PIP)] */
export const FINGER_TIP_PIP = [
  [8, 6],   // 食指
  [12, 10], // 中指
  [16, 14], // 无名指
  [20, 18], // 小指
];

export const WRIST = 0;
export const INDEX_MCP = 5;
export const MIDDLE_MCP = 9;
export const RING_MCP = 13;
export const PINKY_MCP = 17;
export const FINGER_TIPS = [4, 8, 12, 16, 20];

/**
 * 由 21 个关键点算出「尺度无关」的原始张合特征。
 * @param {Array<{x:number,y:number,z:number}>} lm 归一化关键点（0~1，z 相对手腕）
 * @returns {{raw:number,size:number,span:number,palm:number,fingerRatios:number[]}}
 */
export function computeRawFeatures(lm) {
  const wrist = lm[WRIST];
  const p5 = lm[INDEX_MCP];
  const p9 = lm[MIDDLE_MCP];
  const p13 = lm[RING_MCP];
  const p17 = lm[PINKY_MCP];

  const span = distance3(p5, p17);
  const palm = (distance3(wrist, p5) + distance3(wrist, p9) + distance3(wrist, p13)) / 3;

  // 掌心尺度：掌宽 + 掌长的平均，对单点抖动更鲁棒
  let size = (palm + span) / 2;
  if (!(size > 1e-4)) size = span > 1e-4 ? span : 1e-4;

  // 五个指尖的归一化伸展量
  const fingerRatios = FINGER_TIPS.map((tip) => distance3(wrist, lm[tip]) / size);

  // 截尾平均：排序后去掉最大最小，取中间 3 个
  const sorted = fingerRatios.slice().sort((a, b) => a - b);
  const raw = (sorted[1] + sorted[2] + sorted[3]) / 3;

  return { raw, size, span, palm, fingerRatios };
}

/**
 * 直方图峰值估计：把样本分桶，再看哪个桶的众数落在哪。
 * 用来自动学习「这个人的 raw 握拳值和 raw 张开值」，免去手动校准。
 * 视野受限（视频里的人手张合范围可能只占标定区间的一部分）时特别有用。
 */
class PeakTracker {
  constructor(bins = 14) {
    this.bins = bins;
    this.hist = new Float32Array(bins);
    this.lo = Infinity;
    this.hi = -Infinity;
    this.count = 0;
  }

  observe(raw) {
    if (!Number.isFinite(raw)) return;
    this.count++;
    // 用滑动窗口更新取值范围，避免被单帧异常值带偏
    if (this.count === 1) { this.lo = raw; this.hi = raw; }
    else {
      this.lo = Math.min(this.lo, raw);
      this.hi = Math.max(this.hi, raw);
    }
    const span = Math.max(this.hi - this.lo, 1e-4);
    const idx = clamp(Math.floor(((raw - this.lo) / span) * this.bins), 0, this.bins - 1);
    this.hist[idx] += 1;
  }

  /** 返回出现次数最多的桶的中心（还原成 raw 值） */
  peak() {
    if (this.count < 12) return null;
    let best = 0;
    for (let i = 1; i < this.bins; i++) if (this.hist[i] > this.hist[best]) best = i;
    const span = Math.max(this.hi - this.lo, 1e-4);
    return this.lo + ((best + 0.5) / this.bins) * span;
  }

  reset() {
    this.hist.fill(0);
    this.lo = Infinity;
    this.hi = -Infinity;
    this.count = 0;
  }
}

/**
 * 张合度估计器：把每帧的 raw 特征变成 0~1 的 tension，并做时间平滑。
 * 关键参数全部暴露在 options 里，方便调参。
 */
export class TensionEstimator {
  constructor(options = {}) {
    this.rawClosed = options.rawClosed ?? ANATOMY.tipOverSizeClosed; // 握拳时的典型 raw
    this.rawOpen = options.rawOpen ?? ANATOMY.tipOverSizeOpen;       // 完全张开时的典型 raw

    // 每帧的指数平滑系数：越大越跟手，越小越稳。
    // 0.18 在 60fps 下约 11 帧（≈180ms）达到 90% 响应，主观上「跟手但不抖」。
    this.smoothing = options.smoothing ?? 0.18;
    this.minRange = options.minRange ?? 0.25;   // rawOpen-rawClosed 的合法最小值
    this.autoCalibrate = options.autoCalibrate ?? true;
    this.calibrationRate = options.calibrationRate ?? 0.0015; // 自适应学习速率
    this.activationAttack = options.activationAttack ?? 0.5;   // 激活度上升速度
    this.activationRelease = options.activationRelease ?? 0.12; // 激活度下降速度

    this.tension = 0;   // 平滑后的最终值
    this.rawTension = 0;
    this.activation = 0; // 0 = 五指全蜷曲（握拳），1 = 有手指伸出
    this.lastFeatures = null;

    this._openPeak = new PeakTracker();
    this._closedPeak = new PeakTracker();
    this._calibrationTimer = 0;
  }

  /**
   * 处理一帧。
   * @param {Array} lm 21 个关键点（可以是 null，表示这一帧没检测到手）
   * @returns {number} tension ∈ [0,1]
   */
  update(lm, deltaSeconds = 1 / 60) {
    if (!lm || lm.length < 21) {
      // 丢手：张力缓慢回落到 0（花苞收拢），不要瞬间跳变
      const decay = 1 - Math.pow(0.001, deltaSeconds); // ≈ 每秒衰减到千分之一
      this.tension += (0 - this.tension) * decay;
      if (this.tension < 1e-4) this.tension = 0;
      return this.tension;
    }

    const f = computeRawFeatures(lm);
    this.lastFeatures = f;

    // ---- 激活度：几根手指是「伸出去的」 ----
    let extendedCount = 0;
    for (let i = 0; i < FINGER_TIP_PIP.length; i++) {
      const [tip, pip] = FINGER_TIP_PIP[i];
      // 指尖离手腕的距离 > 指节离手腕的距离 ⇒ 该手指基本是伸直的
      if (distance3(lm[WRIST], lm[tip]) > distance3(lm[WRIST], lm[pip]) * 1.06) {
        extendedCount++;
      }
    }
    // 捏合（拇指+食指）也算半个「张开」，符合「指尖捻花」的手势直觉
    const pinch = distance3(lm[4], lm[8]) / f.size;
    if (pinch > 0.55) extendedCount += 0.5;

    const activationTarget = clamp(extendedCount / 4.5);
    const rate = activationTarget > this.activation ? this.activationAttack : this.activationRelease;
    this.activation += (activationTarget - this.activation) * clamp(rate * deltaSeconds * 60);

    // ---- 自适应标定：学习这个人的握拳 / 张开两端 ----
    if (this.autoCalibrate && this.activation > 0.85) this._openPeak.observe(f.raw);
    if (this.autoCalibrate && this.activation < 0.12) this._closedPeak.observe(f.raw);

    this._calibrationTimer += deltaSeconds;
    if (this.autoCalibrate && this._calibrationTimer > 0.5) {
      this._calibrationTimer = 0;
      const openPeak = this._openPeak.peak();
      const closedPeak = this._closedPeak.peak();
      // 只在「张开峰值确实明显高于握拳峰值」时才吸收，避免误学习
      if (openPeak != null && closedPeak != null && openPeak - closedPeak > this.minRange) {
        const k = this.calibrationRate * 30;
        this.rawOpen += (openPeak - this.rawOpen) * clamp(k);
        this.rawClosed += (closedPeak - this.rawClosed) * clamp(k);
        // 夹紧在合理范围内，防止长时间漂移
        this.rawOpen = clamp(this.rawOpen, 1.8, 6);
        this.rawClosed = clamp(this.rawClosed, 0.8, 4.5);
        if (this.rawOpen - this.rawClosed < this.minRange) {
          this.rawOpen = this.rawClosed + this.minRange;
        }
      }
    }

    // ---- 归一化 ----
    const range = Math.max(this.rawOpen - this.rawClosed, this.minRange);
    let t = clamp((f.raw - this.rawClosed) / range);
    t = smoothstep(0, 1, t); // S 型压缩，两端更「死」，中间更灵敏

    // 全握拳时强制归零，消除「握紧了还剩 0.1」的观感问题
    t *= smoothstep(0, 0.35, this.activation);
    this.rawTension = t;

    // ---- 时间平滑（指数移动平均）----
    // 注意帧率无关：60fps 时系数就是 this.smoothing
    const a = 1 - Math.pow(1 - this.smoothing, deltaSeconds * 60);
    this.tension += (t - this.tension) * clamp(a);
    return this.tension;
  }

  reset() {
    this.tension = 0;
    this.rawTension = 0;
    this.activation = 0;
    this._openPeak.reset();
    this._closedPeak.reset();
  }
}

/* ==========================================================================
 * B. 绽放映射
 * --------------------------------------------------------------------------
 * 需求规定的三段式：
 *   tension < 0.32          → 花苞闭合（spread = 0）
 *   0.32 ≤ tension ≤ 0.66   → 平滑过渡
 *   tension > 0.66          → 完全绽放（spread = 1）
 * 用两次 smoothstep 相减即可，曲线连续且两端导数为 0。
 * ======================================================================== */
export const TENSION_CLOSED = 0.32;
export const TENSION_OPEN = 0.66;

export function tensionToSpread(tension, closed = TENSION_CLOSED, open = TENSION_OPEN) {
  return smoothstep(closed, open, clamp(tension)) ** 1.0;
}

/* ==========================================================================
 * C. 粒子花朵几何
 * --------------------------------------------------------------------------
 * 设计思路：为每个粒子预计算两组顶点位置
 *   posBud   —— tension = 0 时的位置（花苞：紧凑的叶序球）
 *   posBloom —— tension = 1 时的位置（绽放：多层极坐标花瓣 + 花心雄蕊）
 * 运行时由顶点着色器按 spread 在两者之间插值（slerp 方向 + 位置插值），
 * CPU 每帧只更新一个 uniform，1~4 万粒子也能轻松 60fps。
 *
 * 花瓣极坐标函数（极角 θ 从花瓣中轴算起）：
 *   edge(θ) = |cos(1.5·θ)|^0.45        花瓣边缘的波浪轮廓
 *   fold(θ) = sin(2.6·θ) · 0.28        沿"花瓣宽度方向"的褶皱起伏
 *   半径    = petalLen · rim^0.8       越靠近边缘的粒子铺得越外
 * ======================================================================== */

export const DEFAULT_FLOWER = {
  // ---- 粒子规模 ----
  count: 12000,

  // ---- 三层花瓣 ----
  // ringCount: 该层的花瓣数
  // pitch    : 花瓣相对竖直向上的「俯仰角」(弧度)，越大越平摊
  // lift     : 该层整体抬高，形成杯状层次
  // length   : 花瓣长度
  // width    : 花瓣宽度
  // outerBias: 0~1，把粒子更多分到花瓣外沿（让轮廓更清晰）
  rings: [
    { ringCount: 5, pitch: 1.22, lift: 0.02, length: 0.95, width: 0.44, outerBias: 0.30 },
    { ringCount: 7, pitch: 0.95, lift: 0.16, length: 1.24, width: 0.40, outerBias: 0.42 },
    { ringCount: 9, pitch: 0.68, lift: 0.30, length: 1.46, width: 0.36, outerBias: 0.52 },
  ],

  // ---- 花苞 ----
  // budRadius / budHeight 决定花苞的视觉大小与形状；它与绽放半径（约 1.83）的比例
  // 决定了「握拳 → 张开」这一下的观感反差。budHeight 越大越像尖头的花蕾。
  budRadius: 0.38,   // 花苞半径
  budHeight: 2.20,   // 花苞在 y 方向的拉伸（尖头朝上；高宽比 ~1.1 才是「花蕾」的手感）
  budCore: 0.30,     // 花苞中「花心」粒子占比
  budJitter: 0.045,  // 位置抖动，避免看出规则网格

  // ---- 花心（雄蕊/花蕊）----
  coreShare: 0.075,      // 花心粒子占比
  coreRadius: 0.20,      // 花心半径
  coreHeight: 0.34,      // 花心高度
  coreSpread: 0.64,      // 花心在完全绽放时的放大倍数（花苞时是压缩的）

  // ---- 抖动 / 光晕 ----
  jitter: 0.035,
  baseSize: 0.055,       // 单位：世界单位（约等于屏幕高度的千分比 → 由 main.js 换算）

  // ---- 调色板（三档渐变的 RGB）----
  palette: {
    core: [1.00, 0.34, 0.55],   // 花心：亮玫红
    mid:  [1.00, 0.58, 0.78],   // 花瓣中段：粉
    edge: [1.00, 0.90, 0.83],   // 花瓣外沿：奶油白
  },
};

/** 取调色板某处的颜色（t = 0 花心 → 1 外沿） */
function paletteAt(palette, t) {
  const a = clamp(t);
  if (a < 0.5) {
    const k = a / 0.5;
    return [
      lerp(palette.core[0], palette.mid[0], k),
      lerp(palette.core[1], palette.mid[1], k),
      lerp(palette.core[2], palette.mid[2], k),
    ];
  }
  const k = (a - 0.5) / 0.5;
  return [
    lerp(palette.mid[0], palette.edge[0], k),
    lerp(palette.mid[1], palette.edge[1], k),
    lerp(palette.mid[2], palette.edge[2], k),
  ];
}

/**
 * 生成粒子花朵的顶点数据。
 * @param {object} options 见 DEFAULT_FLOWER（可部分覆盖）
 * @returns {{
 *   count:number,
 *   posBud:Float32Array, posBloom:Float32Array,
 *   dirBud:Float32Array, dirBloom:Float32Array,
 *   hue:Float32Array, aSize:Float32Array, sparkle:Float32Array,
 *   colorMix:Float32Array,  // 调试用（也方便做需要 CPU 侧颜色的特效）
 *   bounds:{budRadius:number, bloomRadius:number}
 * }}
 */
export function buildFlowerGeometry(options = {}) {
  const cfg = {
    ...DEFAULT_FLOWER,
    ...options,
    palette: { ...DEFAULT_FLOWER.palette, ...(options.palette || {}) },
    rings: options.rings || DEFAULT_FLOWER.rings,
  };

  const N = Math.max(1, Math.floor(cfg.count));
  const rings = cfg.rings;
  const ringCount = rings.length;

  const posBud = new Float32Array(N * 3);
  const posBloom = new Float32Array(N * 3);
  const dirBud = new Float32Array(N * 3);
  const dirBloom = new Float32Array(N * 3);
  const hue = new Float32Array(N);
  const aSize = new Float32Array(N);
  const sparkle = new Float32Array(N);
  const colorMix = new Float32Array(N);

  // 粒子配额：花心 / 花瓣 / 花苞外层萼片
  const coreCount = Math.floor(N * cfg.coreShare);
  const sepalCount = Math.floor(N * 0.10);
  const petalCount = Math.max(0, N - coreCount - sepalCount);

  // 每层花瓣分多少粒子（按层面积近似分配）
  const ringWeights = rings.map((r) => r.ringCount * r.length * r.width);
  const weightSum = ringWeights.reduce((a, b) => a + b, 0) || 1;
  const ringBudget = ringWeights.map((w) => Math.floor((w / weightSum) * petalCount));
  // 余数补给最外层，保证总数精确
  let assigned = ringBudget.reduce((a, b) => a + b, 0);
  ringBudget[ringCount - 1] += petalCount - assigned;

  const PHI = Math.PI * (3 - Math.sqrt(5));   // 黄金角 ≈ 2.39996，叶序分布
  const tmpDir = [0, 0, 0];
  let idx = 0;

  /* ---------------- C1. 花心（雄蕊球 + 花丝）---------------- */
  for (let i = 0; i < coreCount; i++, idx++) {
    // 球体内的均匀点
    const u = halton(i, 2);
    const v = halton(i, 3);
    const w = halton(i, 5);
    const y = 1 - 2 * u;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = 2 * Math.PI * v;
    const pow = Math.cbrt(w); // cbrt 让点在球体内均匀分布
    const dir = [Math.cos(phi) * r * pow, y * pow, Math.sin(phi) * r * pow];

    // 花苞态：花心是压缩的小球（别缩到 0，否则会出现「黑点」）
    const budR = cfg.coreRadius * 0.8;
    posBud[idx * 3 + 0] = dir[0] * budR * 0.6;
    posBud[idx * 3 + 1] = dir[1] * budR * 0.6 + 0.06;
    posBud[idx * 3 + 2] = dir[2] * budR * 0.6;

    // 绽放态：拉长成花蕊柱，越靠外越张开
    const bloomR = cfg.coreRadius * cfg.coreSpread;
    const taper = 0.35 + 0.65 * Math.sqrt(Math.max(0, u));
    posBloom[idx * 3 + 0] = dir[0] * bloomR * taper;
    posBloom[idx * 3 + 1] = 0.02 + (u - 0.25) * cfg.coreHeight;
    posBloom[idx * 3 + 2] = dir[2] * bloomR * taper;

    // 方向属性必须严格归一化：着色器会用它做 slerp
    normalizeInto(dirBud, idx, dir[0], Math.abs(dir[1]) + 0.35, dir[2]);
    normalizeInto(dirBloom, idx, dir[0], 0.35 + Math.abs(dir[1]) * 0.5, dir[2]);

    colorMix[idx] = 0.02 + w * 0.22;
    hue[idx] = v;                      // 色相抖动（每颗粒子一个随机值）
    sparkle[idx] = 0.02 + u * 0.26;    // 径向位置：花心最内 → 调色板最深处
    aSize[idx] = 0.7 + w * 0.75;
  }

  /* ---------------- C2. 花瓣 ---------------- */
  for (let ring = 0; ring < ringCount; ring++) {
    const R = rings[ring];
    const budget = ringBudget[ring];
    if (budget <= 0) continue;

    const azOffset = (ring * Math.PI) / Math.max(R.ringCount, 1); // 层与层错开，避免花瓣上下对齐
    for (let i = 0; i < budget; i++, idx++) {
      const h1 = halton(i, 2);
      const h2 = halton(i, 3);
      const h3 = halton(i, 5);
      const h4 = halton(i, 7);

      // 花瓣编号 + 花瓣内的角度
      const petalIndex = Math.floor(h1 * R.ringCount) % R.ringCount;
      const t = h2;
      // 径向分布：先用 0.45 幂次把粒子往花瓣中段/外沿推，再用 outerBias 微调。
      // 幂次太大会只剩轮廓、中间空掉（看起来稀疏），太小则全挤在花心。
      const rim = Math.pow(t, 1 / (1.25 + R.outerBias));
      const theta = (h3 - 0.5) * Math.PI; // 花瓣内的极角，-90°~90°

      // 花瓣边缘轮廓：|cos(1.5θ)|^0.45 决定「花瓣在中轴最长、两侧收拢」
      const edge = Math.pow(Math.abs(Math.cos(1.5 * theta)) + 0.06, 0.45);
      // 半径：rim^0.55 让粒子更多落在花瓣外侧（轮廓清晰），但仍保证花瓣内部有足够密度
      const radius = R.length * Math.pow(rim, 0.55) * edge;

      // 沿宽度方向的褶皱（正余弦叠加，做出牡丹/玫瑰那种起伏）
      const fold = Math.sin(2.6 * theta + ring * 1.1) * 0.28 + Math.sin(4.4 * theta) * 0.12;

      // 花瓣的中轴角
      const az = (petalIndex / R.ringCount) * Math.PI * 2 + azOffset + (h4 - 0.5) * 0.16;

      // 花瓣局部坐标：u = 沿花瓣长度，v = 垂直花瓣的宽度，w = 花瓣法向
      const u = radius;
      const v = theta * R.width * (0.35 + 0.65 * rim);
      const w = fold * R.width * (0.25 + 0.75 * rim) + (h4 - 0.5) * cfg.jitter;

      // ---- 绽放态：把局部坐标旋转到花瓣方向 ----
      // 花瓣俯仰角 pitch 决定它往外摊开多少；再叠加一点随机让它不那么规整
      const pitch = R.pitch + (h1 - 0.5) * 0.18;
      const dirX = Math.sin(pitch) * Math.cos(az);
      const dirY = Math.cos(pitch);
      const dirZ = Math.sin(pitch) * Math.sin(az);
      // 花瓣的侧向量（与 dir、y 轴垂直）
      const sideX = -Math.sin(az);
      const sideZ = Math.cos(az);
      // 花瓣的法向量 = dir × side
      const nX = dirY * sideZ - dirZ * 0;
      const nY = dirZ * sideX - dirX * sideZ;
      const nZ = dirX * 0 - dirY * sideX;

      posBloom[idx * 3 + 0] = R.lift * dirX + u * dirX + v * sideX + w * nX;
      posBloom[idx * 3 + 1] = R.lift * 0.9 + u * dirY + v * 0 + w * nY;
      posBloom[idx * 3 + 2] = R.lift * dirZ + u * dirZ + v * sideZ + w * nZ;

      // ---- 花苞态：叶序分布球（斐波那契球），紧凑包裹 ----
      const fib = (idx + 1) * PHI;
      const cosT = 1 - 2 * ((idx + 0.5) / N);
      const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      const shellX = Math.cos(fib) * sinT;
      const shellY = cosT;
      const shellZ = Math.sin(fib) * sinT;
      // 5 条竖棱：让花苞有「未展开的花瓣缝」而不是一个光滑球
      const ridge = 1 + 0.13 * Math.cos(5 * Math.atan2(shellZ, shellX));
      const shellR = cfg.budRadius * ridge * (0.82 + 0.18 * h3);
      posBud[idx * 3 + 0] = shellX * shellR + (h1 - 0.5) * cfg.budJitter;
      posBud[idx * 3 + 1] = shellY * shellR * cfg.budHeight * 0.5 + 0.12 + (h2 - 0.5) * cfg.budJitter;
      posBud[idx * 3 + 2] = shellZ * shellR + (h4 - 0.5) * cfg.budJitter;

      // 方向属性：统一取「相对花心的单位方向」，用于 slerp 与光照
      normalizeInto(dirBud, idx, posBud[idx * 3], posBud[idx * 3 + 1], posBud[idx * 3 + 2]);
      normalizeInto(dirBloom, idx, posBloom[idx * 3], posBloom[idx * 3 + 1], posBloom[idx * 3 + 2]);

      // 颜色：花心深、花瓣中段粉、外沿奶油白
      colorMix[idx] = clamp(0.26 + 0.74 * Math.pow(rim, 0.85));
      hue[idx] = h4;                    // 色相抖动
      sparkle[idx] = rim;               // 径向位置 → 调色板位置
      aSize[idx] = 0.75 + h2 * 0.7;
    }
  }

  /* ---------------- C3. 花苞外层萼片（让花苞更有体积、绽放后成为花萼）------ */
  for (let i = 0; i < sepalCount && idx < N; i++, idx++) {
    const h1 = halton(i, 2);
    const h2 = halton(i, 3);
    const h3 = halton(i, 5);

    const az = h1 * Math.PI * 2;
    // 萼片要覆盖花苞的整个高度（-1 ~ +1），否则花苞上下两端会露出内部花心，看起来像缺了一块
    const up = -1 + h2 * 2;
    const r = cfg.budRadius * (0.82 + 0.34 * h3) * (1 - 0.22 * Math.abs(up)) * Math.sqrt(Math.max(0, 1 - up * up * 0.72));

    // 花苞态：贴着花苞外壁
    const budX = Math.cos(az) * r;
    const budY = up * cfg.budRadius * cfg.budHeight * 0.5 + 0.1;
    const budZ = Math.sin(az) * r;

    // 绽放态：向下/向外翻开的萼片（点缀在花底）
    const pitch = 1.75 + h3 * 0.35;
    const len = 0.5 + h2 * 0.35;
    const bloomX = Math.cos(az) * (Math.sin(pitch) * len + cfg.budRadius * 0.5);
    const bloomY = -Math.cos(pitch) * len * 0.55 - 0.06 + h1 * 0.05;
    const bloomZ = Math.sin(az) * (Math.sin(pitch) * len + cfg.budRadius * 0.5);

    posBud[idx * 3 + 0] = budX;
    posBud[idx * 3 + 1] = budY;
    posBud[idx * 3 + 2] = budZ;
    posBloom[idx * 3 + 0] = bloomX;
    posBloom[idx * 3 + 1] = bloomY;
    posBloom[idx * 3 + 2] = bloomZ;

    normalizeInto(dirBud, idx, budX, budY, budZ);
    normalizeInto(dirBloom, idx, bloomX, bloomY, bloomZ);

    colorMix[idx] = 0.16 + h3 * 0.22;
    hue[idx] = 0.25 + h1 * 0.3;        // 偏冷的色相抖动，让萼片略带青绿
    sparkle[idx] = 0.10 + h3 * 0.30;
    aSize[idx] = 0.6 + h2 * 0.5;
  }

  // 极端情况下（budget 取整误差）补齐剩余粒子，避免出现 (0,0,0) 的黑点
  for (; idx < N; idx++) {
    const h = halton(idx, 2);
    const a = idx * PHI;
    const cosT = 1 - 2 * ((idx + 0.5) / N);
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    posBud[idx * 3 + 0] = Math.cos(a) * sinT * cfg.budRadius;
    posBud[idx * 3 + 1] = cosT * cfg.budRadius * cfg.budHeight * 0.5 + 0.12;
    posBud[idx * 3 + 2] = Math.sin(a) * sinT * cfg.budRadius;
    posBloom[idx * 3 + 0] = Math.cos(a) * (0.8 + h * 0.4);
    posBloom[idx * 3 + 1] = 0.2 + h * 0.3;
    posBloom[idx * 3 + 2] = Math.sin(a) * (0.8 + h * 0.4);
    normalizeInto(dirBud, idx, Math.cos(a) * sinT, cosT, Math.sin(a) * sinT);
    normalizeInto(dirBloom, idx, Math.cos(a), 0.3, Math.sin(a));
    colorMix[idx] = 0.3;
    hue[idx] = h;
    sparkle[idx] = 0.45;
    aSize[idx] = 1;
  }

  // 统计包围盒，供 main.js 调整相机距离 / 自适应缩放
  let bloomRadius = 0;
  for (let i = 0; i < N; i++) {
    const x = posBloom[i * 3], y = posBloom[i * 3 + 1], z = posBloom[i * 3 + 2];
    bloomRadius = Math.max(bloomRadius, Math.hypot(x, y, z));
  }

  return {
    count: N,
    posBud, posBloom, dirBud, dirBloom,
    hue, aSize, sparkle, colorMix, paletteAt,
    bounds: { budRadius: cfg.budRadius * cfg.budHeight, bloomRadius },
  };
}
