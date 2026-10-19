/* ============================================================================
 * main.js —— 手势控制花朵在指尖绽放
 * ----------------------------------------------------------------------------
 * 模块划分：
 *   §1  配置与常量
 *   §2  通用工具（DOM、数学、存储）
 *   §3  状态（全局可变状态集中管理）
 *   §4  Three.js 场景：粒子花朵 + 自定义 ShaderMaterial
 *   §5  指针交互（鼠标/触摸，也是没有摄像头时的降级方案）
 *   §6  MediaPipe Hands 手部识别（摄像头 + 21 关键点 + 连线）
 *   §7  HUD 更新
 *   §8  主循环
 *   §9  启动流程与事件绑定
 *
 * 依赖：three（importmap 引入）、@mediapipe/hands（动态 import 的 UMD 脚本）
 * ========================================================================== */

import {
  buildFlowerGeometry,
  TensionEstimator,
  tensionToSpread,
  clamp,
  lerp,
  smoothstep,
  DEFAULT_FLOWER,
} from './flowerMath.js';

// 着色器源码单独放一个文件：既方便调参，也方便自动化测试 import 同一份代码
import { VERTEX_SHADER, FRAGMENT_SHADER } from './shaders.js';

/* ==========================================================================
 * §1 配置与常量
 * ======================================================================== */

const CONFIG = {
  /* -- CDN 源：默认走国内可达镜像（npmmirror / baomitu），避免 unpkg、jsdelivr 在境内网络被墙 -- */
  threeCdn: 'https://registry.npmmirror.com/three/0.169.0/files/build/three.module.js',
  threeCdnFallback: 'https://lib.baomitu.com/three.js/0.169.0/three.module.js',
  mediapipeCdn: 'https://registry.npmmirror.com/@mediapipe/hands/0.4.1675469240/files/hands.js',
  mediapipeCdnFallback: 'https://registry.npmmirror.com/@mediapipe/hands/0.4.1675469240/files/hands.js',
  mediapipeAssetBase: 'https://registry.npmmirror.com/@mediapipe/hands/0.4.1675469240/files/',

  /* -- 粒子规模 -- */
  particles: 12000,        // 默认粒子数（4000~18000 手机端够用，桌面可开到 40000）
  particlesMin: 3000,
  particlesMax: 40000,
  particleStep: 1000,

  /* -- 花朵形态 -- */
  flower: {
    // 直接透传 flowerMath 的默认值，这里只覆盖想改的几项
    ...DEFAULT_FLOWER,
  },

  /* -- 绽放映射阈值（需求规定：<0.32 闭合，>0.66 绽放）-- */
  tensionClosed: 0.32,
  tensionOpen: 0.66,

  /* -- 缓动：currentSpread += (targetSpread - currentSpread) * easing -- */
  // 0.1 是需求给定值；这里按帧率归一化，保证 120Hz 屏幕上速度一致
  easing: 0.1,

  /* -- 相机 -- */
  cameraFov: 42,
  cameraHeightRatio: 0.58,   // 相机高度 = 花朵半径 × 该系数
  cameraLookAtY: 0.18,
  // 花朵整体倾角（弧度）：正视/俯视都看不出花瓣层次，倾斜后是漂亮的 3/4 视角
  flowerTiltX: -0.42,
  flowerTiltZ: -0.30,

  /* -- 其他 -- */
  maxDpr: 2,                 // devicePixelRatio 上限（移动端降性能用）
  hoverStrength: 0.34,       // 指尖对粒子的牵引强度
  hoverClamp: 1.15,          // 牵引位移上限（世界单位）
  autoDemo: true,            // 没检测到手时自动演示开合
  autoDemoPeriod: 12,        // 自动演示周期（秒）
  handLostGrace: 0.55,       // 丢手后保持张力多久（秒），避免闪烁

  /* -- 超时保护：任何一步都不能无限等待，否则界面看起来像「卡死」-- */
  cameraPermissionTimeout: 8000,   // 等摄像头授权的最长时间（毫秒）
  threeLoadTimeout: 15000,         // three.js 单个 CDN 的加载超时
  handsLoadTimeout: 25000,         // MediaPipe wasm/模型加载超时
};

const STORAGE_KEY = 'gesture-bloom-flower:settings:v1';

/** 等摄像头授权的最长时间：超时就报错，而不是永远挂着（用户会以为「点了没反应」） */
const CAMERA_PERMISSION_TIMEOUT_MS = 8000;

/* ==========================================================================
 * §2 通用工具
 * ======================================================================== */

const $ = (id) => document.getElementById(id);

const dom = {
  body: document.body,
  gl: $('gl'),
  overlay: $('hand-overlay'),
  video: $('camera'),
  boot: $('boot'),
  bootHint: $('boot-hint'),
  btnStart: $('btn-start'),
  btnMouse: $('btn-mouse'),
  btnMode: $('btn-mode'),
  btnReset: $('btn-reset'),
  toggleCamera: $('toggle-camera'),
  toggleSkeleton: $('toggle-skeleton'),
  rangeParticles: $('range-particles'),
  rangeGlow: $('range-glow'),
  outParticles: $('out-particles'),
  outGlow: $('out-glow'),
  controls: $('controls'),
  statusDot: $('status-dot'),
  statusText: $('status-text'),
  statusHint: $('status-hint'),
  tensionValue: $('tension-value'),
  tensionBar: $('tension-bar'),
  tensionStage: $('tension-stage'),
  spreadValue: $('spread-value'),
  fpsValue: $('fps-value'),
  countValue: $('count-value'),
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? parsed : null;
  } catch (err) {
    console.warn('[settings] 读取失败：', err);
    return null;
  }
}

function saveSettings(partial) {
  try {
    const next = { ...(loadSettings() || {}), ...partial };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    /* 隐私模式下 localStorage 可能不可用，忽略即可 */
  }
}

/** 把 Promise 包上超时，避免 CDN 卡住时页面永远停在 loading */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms / 1000}s）`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * 依次尝试多个 CDN 地址加载同一个 UMD 脚本。
 * 用于应对「某个 CDN 在本地网络下不可达」的情况。
 */
function loadScriptWithFallback(urls, globalName, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    let i = 0;
    const errors = [];

    const attempt = () => {
      if (i >= urls.length) {
        reject(new Error(`脚本加载失败：${errors.join(' | ')}`));
        return;
      }
      const url = urls[i++];
      const script = document.createElement('script');
      script.src = url;
      script.crossOrigin = 'anonymous';
      script.async = true;

      const cleanup = () => { script.onload = script.onerror = null; };

      script.onload = () => {
        cleanup();
        if (globalName && typeof window[globalName] === 'undefined') {
          errors.push(`${url} 加载成功但未暴露 window.${globalName}`);
          script.remove();
          attempt();
          return;
        }
        resolve(window[globalName]);
      };
      script.onerror = () => {
        cleanup();
        errors.push(`${url} 网络错误`);
        script.remove();
        attempt();
      };

      document.head.appendChild(script);
    };

    attempt();

    // 整体超时保护（不是每个 URL 单独计时，逻辑更简单）
    setTimeout(() => {
      if (i <= urls.length) reject(new Error(`${globalName || '脚本'} 加载超时`));
    }, timeoutMs);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ==========================================================================
 * §3 全局状态
 * ======================================================================== */

const state = {
  ready: false,             // Three.js 是否初始化完成
  started: false,           // 用户是否点击过开始
  mode: 'camera',           // 'camera' | 'pointer'
  cameraActive: false,      // 摄像头是否正在工作
  handDetected: false,
  handLostTimer: 0,         // 距离最后一次检测到手的时间
  tension: 0,               // 平滑后的张合度 0~1
  targetSpread: 0,
  currentSpread: 0,         // 缓动后的绽放程度（着色器 uniform）
  rawSpread: 0,             // 未经缓动的目标值（HUD 显示）
  hover: { x: 0, y: 0, z: 0 },
  hoverTarget: { x: 0, y: 0, z: 0 },
  hoverActive: false,
  pointerDown: false,
  overlayCleared: true,
  cameraHintShown: false,   // 摄像头模式下是否已经提示过「识别成功」
  autoHold: 0,              // 指针模式下松开后保持绽放的剩余秒数
  flowerData: null,         // 当前几何数据（含包围盒）
  contextLost: false,       // WebGL 上下文是否丢失
  cameraPermission: 'unknown', // 'granted' | 'denied' | 'prompt' | 'unknown'
  settings: {
    particles: CONFIG.particles,
    glow: 1,
    skeleton: true,
    cameraOn: true,
  },
};

/* ==========================================================================
 * §4 Three.js 场景
 * ======================================================================== */

const three = {
  THREE: null,
  initPromise: null,        // 幂等初始化用的 Promise（防止重复创建 WebGL 上下文）
  renderer: null,
  scene: null,
  camera: null,
  points: null,
  material: null,
  geometryCache: new Map(), // 按粒子数缓存几何体，拖动滑块时不重复计算
  keyLight: null,
  raycaster: null,
  pointerPlane: null,
  clock: null,
  elapsed: 0,
  introT: 0,
};

/** 动态加载 three（带 CDN 兜底与超时） */
async function importThree() {
  try {
    return await withTimeout(import(/* @vite-ignore */ CONFIG.threeCdn), CONFIG.threeLoadTimeout, 'three.js 主 CDN');
  } catch (err) {
    console.warn('[three] 主 CDN 失败，尝试备用 CDN：', err.message);
    setBootProgress('主 CDN 不可用，正在尝试备用 CDN…', '');
    return await withTimeout(import(/* @vite-ignore */ CONFIG.threeCdnFallback), CONFIG.threeLoadTimeout, 'three.js 备用 CDN');
  }
}

/** 初始化 Three.js 场景（幂等：重复调用只会拿到同一个 Promise，不会创建第二个 WebGL 上下文） */
function initThree() {
  if (three.initPromise) return three.initPromise;
  three.initPromise = initThreeOnce().catch((err) => {
    // 失败后清空，允许用户重新点「重试」
    three.initPromise = null;
    throw err;
  });
  return three.initPromise;
}

async function initThreeOnce() {
  const THREE = await importThree();
  three.THREE = THREE;

  /* ---- 渲染器 ---- */
  const renderer = new THREE.WebGLRenderer({
    canvas: dom.gl,
    alpha: true,                 // 透明背景，与摄像头画面叠加
    antialias: false,            // 点精灵不需要 MSAA，关掉省性能
    powerPreference: 'high-performance',
    // 透明画布必须用预乘 alpha 才能被浏览器正确合成；
    // 非预乘会让「GL 里画出来了、页面上却是黑的」。
    premultipliedAlpha: true,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CONFIG.maxDpr));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.sortObjects = true;
  three.renderer = renderer;

  /* ---- 场景 ---- */
  const scene = new THREE.Scene();
  three.scene = scene;

  /* ---- 相机 ---- */
  const camera = new THREE.PerspectiveCamera(
    CONFIG.cameraFov,
    window.innerWidth / Math.max(window.innerHeight, 1),
    0.1,
    100,
  );
  three.camera = camera;

  /* ---- 粒子花朵 ---- */
  three.material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uTime: { value: 0 },
      uSpread: { value: 0 },
      uHover: { value: new THREE.Vector3(0, 0, 0) },
      uHoverActive: { value: 0 },
      uPixelScale: { value: 800 },
      uBaseSize: { value: CONFIG.flower.baseSize },
      uGlow: { value: 1 },
      uIntro: { value: 0 },
      // 单颗粒子的基准不透明度 —— 这是控制「亮度/浓度」最重要的一个数。
      // 加色混合会把 1 万多个粒子的贡献累加：花心处往往有几十颗粒子重叠，
      // 所以单颗粒子必须很暗（0.35 左右），整体才会是「亮而不过曝」的粉花；
      // 调到 0.85 以上花心就会糊成白团（通道溢出），调到 0.2 以下又会显得灰暗。
      uOpacity: { value: 0.35 },
      uColorCore: { value: new THREE.Color(CONFIG.flower.palette.core[0], CONFIG.flower.palette.core[1], CONFIG.flower.palette.core[2]) },
      uColorMid: { value: new THREE.Color(CONFIG.flower.palette.mid[0], CONFIG.flower.palette.mid[1], CONFIG.flower.palette.mid[2]) },
      uColorEdge: { value: new THREE.Color(CONFIG.flower.palette.edge[0], CONFIG.flower.palette.edge[1], CONFIG.flower.palette.edge[2]) },
      uBgTint: { value: new THREE.Color(0.16, 0.10, 0.24) },
    },
    transparent: true,
    depthTest: true,
    depthWrite: false,            // 加色混合不需要写深度
    blending: THREE.AdditiveBlending,
  });

  rebuildParticles(state.settings.particles);

  /* ---- 光线/指针辅助 ---- */
  three.raycaster = new THREE.Raycaster();
  three.pointerPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0); // z = 0 平面
  three.clock = new THREE.Clock();

  /* ---- WebGL 上下文丢失处理 ----
   * 手机上切换应用、GPU 驱动重启、或同时存在多个 WebGL 上下文时都可能丢失上下文。
   * 丢失后 renderer.render() 会静默变成空操作（页面卡在最后一帧），所以必须监听。 */
  dom.gl.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();          // 阻止默认行为，浏览器才会尝试恢复
    state.contextLost = true;
    console.warn('[webgl] 上下文丢失，等待恢复…');
    setStatus('warn', '图形上下文丢失', '正在尝试恢复渲染，若长时间无反应请刷新页面（手机可尝试关闭其他占用 GPU 的应用）');
  });

  dom.gl.addEventListener('webglcontextrestored', () => {
    state.contextLost = false;
    console.warn('[webgl] 上下文已恢复');
    setStatus('ok', '渲染已恢复', '继续握拳 / 张开试试');
    // three.js 会自行重建 GPU 资源，这里只需要刷新尺寸相关参数
    onResize();
  });

  /* ---- 自适应相机距离 ---- */
  fitCameraToFlower();

  state.ready = true;
  window.addEventListener('resize', onResize);
  return THREE;
}

/** 根据粒子数（重新）构建几何体 */
function rebuildParticles(count) {
  if (!three.THREE) return;

  const THREE = three.THREE;
  const cached = three.geometryCache.get(count);
  const data = cached || buildFlowerGeometry({ ...CONFIG.flower, count });
  if (!cached) {
    three.geometryCache.set(count, data);
    // 缓存上限：最多保留 6 组，避免拖动滑块时内存暴涨
    if (three.geometryCache.size > 6) {
      const firstKey = three.geometryCache.keys().next().value;
      three.geometryCache.delete(firstKey);
    }
  }

  const geometry = new THREE.BufferGeometry();
  // three.js 要求有一个名为 position 的属性；这里放绽放态坐标，实际位置由着色器算出
  geometry.setAttribute('position', new THREE.BufferAttribute(data.posBloom, 3));
  geometry.setAttribute('aPosBud', new THREE.BufferAttribute(data.posBud, 3));
  geometry.setAttribute('aPosBloom', new THREE.BufferAttribute(data.posBloom, 3));
  geometry.setAttribute('aDirBud', new THREE.BufferAttribute(data.dirBud, 3));
  geometry.setAttribute('aDirBloom', new THREE.BufferAttribute(data.dirBloom, 3));
  geometry.setAttribute('aHue', new THREE.BufferAttribute(data.hue, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(data.aSize, 1));
  geometry.setAttribute('aSparkle', new THREE.BufferAttribute(data.sparkle, 1));
  // 手动给一个大包围球：顶点着色器会做位移，自动计算的包围盒可能不准
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), data.bounds.bloomRadius * 1.8);

  if (three.points) {
    three.scene.remove(three.points);
    three.points.geometry.dispose();
  }

  const points = new THREE.Points(geometry, three.material);
  points.frustumCulled = false;
  // 俯视/正视都看不出花瓣层次，给花朵一个固定倾角，形成 3/4 视角
  points.rotation.set(CONFIG.flowerTiltX, 0, CONFIG.flowerTiltZ);
  three.points = points;
  three.scene.add(points);

  state.flowerData = data;
  dom.countValue.textContent = count.toLocaleString('en-US');

  // 按花朵实际尺寸调整相机，保证任何粒子数/参数下都完整入画
  fitCameraToFlower();
}

/** 根据花朵包围盒自动设置相机位置（保持构图居中） */
function fitCameraToFlower() {
  if (!three.camera || !state.flowerData) return;

  // 考虑倾斜后的最大投影半径：花苞态小、绽放态大，取绽放态的半径
  const bloomRadius = Math.max(state.flowerData.bounds.bloomRadius, 0.9);
  const vFov = (three.camera.fov * Math.PI) / 180;
  const margin = 1.06;
  const distV = (bloomRadius * margin) / Math.tan(vFov / 2);
  // 横向：宽屏（aspect 大）时不该为了塞进宽度而把相机推远，
  // 否则花朵在宽屏上会小得可怜。用 0.9 作为纵横比下限，让花朵按「高度」撑满画面。
  const distH = (bloomRadius * margin) / (Math.tan(vFov / 2) * Math.max(three.camera.aspect, 0.9));
  const dist = Math.max(distV, distH, 3.2);

  three.cameraBaseDistance = dist;
  three.camera.position.set(0, bloomRadius * CONFIG.cameraHeightRatio, dist);
  three.camera.lookAt(0, CONFIG.cameraLookAtY, 0);
}

/** 窗口尺寸变化：同时更新渲染器、相机、覆盖层与点尺寸换算 */
function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;

  if (three.renderer) {
    three.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CONFIG.maxDpr));
    three.renderer.setSize(w, h, false);
  }
  if (three.camera) {
    three.camera.aspect = w / Math.max(h, 1);
    three.camera.updateProjectionMatrix();
    fitCameraToFlower();
  }
  sizeOverlayCanvas();
  updatePixelScale();
}

/** 覆盖层画布尺寸（按 DPR 放大，保证连线锐利） */
function sizeOverlayCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  dom.overlay.width = Math.floor(window.innerWidth * dpr);
  dom.overlay.height = Math.floor(window.innerHeight * dpr);
  dom.overlay.style.width = `${window.innerWidth}px`;
  dom.overlay.style.height = `${window.innerHeight}px`;
}

/**
 * 计算点尺寸换算系数。
 * gl_PointSize = uBaseSize * uPixelScale / 距离
 * 我们希望「baseSize = 0.055 世界单位」在任意分辨率下看起来一致，
 * 所以 uPixelScale 取「视口高度 / (2*tan(fov/2))」并归一到 800px 基准。
 */
function updatePixelScale() {
  if (!three.material || !three.camera) return;
  const h = window.innerHeight * Math.min(window.devicePixelRatio || 1, CONFIG.maxDpr);
  const vFov = (three.camera.fov * Math.PI) / 180;
  const scale = (h / (2 * Math.tan(vFov / 2))) * (window.innerHeight / 800);
  three.material.uniforms.uPixelScale.value = clamp(scale, 200, 4000);
}

/* ==========================================================================
 * §5 指针交互（鼠标 / 触摸）
 * ======================================================================== */

function screenToWorld(clientX, clientY, out) {
  if (!three.raycaster || !three.camera) return null;
  const ndc = new three.THREE.Vector2(
    (clientX / window.innerWidth) * 2 - 1,
    -(clientY / window.innerHeight) * 2 + 1,
  );
  three.raycaster.setFromCamera(ndc, three.camera);
  const hit = new three.THREE.Vector3();
  const ok = three.raycaster.ray.intersectPlane(three.pointerPlane, hit);
  if (!ok || !out) return ok ? hit : null;
  out.x = hit.x; out.y = hit.y; out.z = hit.z;
  return out;
}

function bindPointerEvents() {
  const onMove = (e) => {
    const t = e.touches && e.touches[0] ? e.touches[0] : e;
    const hit = screenToWorld(t.clientX, t.clientY, state.hoverTarget);
    if (hit) state.hoverActive = true;
  };

  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('touchmove', onMove, { passive: true });

  const down = (e) => {
    state.pointerDown = true;
    const t = e.touches && e.touches[0] ? e.touches[0] : e;
    const hit = screenToWorld(t.clientX, t.clientY, state.hoverTarget);
    if (hit) state.hoverActive = true;
  };
  const up = () => { state.pointerDown = false; };

  window.addEventListener('pointerdown', down, { passive: true });
  window.addEventListener('pointerup', up, { passive: true });
  window.addEventListener('pointercancel', up, { passive: true });
  window.addEventListener('touchend', up, { passive: true });
  window.addEventListener('pointerleave', () => { state.hoverActive = false; });
  window.addEventListener('blur', () => { state.pointerDown = false; });
}

/* ==========================================================================
 * §6 MediaPipe Hands 手部识别
 * ======================================================================== */

const hand = {
  Hands: null,
  instance: null,
  stream: null,
  estimating: false,
  frameCount: 0,
  lastError: null,
  ctx: null,          // 覆盖层 2D 上下文（懒创建）
  estimator: new TensionEstimator({
    // rawClosed / rawOpen 不在这里写死：使用 flowerMath.js 里基于人体比例推导的
    // ANATOMY 默认值，再由 autoCalibrate 在使用中学习使用者本人的两端取值。
    smoothing: 0.18,   // 每帧指数平滑：60fps 下约 180ms 达到 90%
    autoCalibrate: true,
  }),
  // 21 个关键点的骨架连线（官方 HAND_CONNECTIONS 的等价定义，防止全局变量未就绪）
  connections: [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20],
    [0, 17],
  ],
  tips: [4, 8, 12, 16, 20],
};

/** 请求摄像头权限并开始播放 */
async function startCamera() {
  // 1) 安全检查：非安全上下文（file:// 或 http 非 localhost）无法调用摄像头
  if (!window.isSecureContext) {
    throw Object.assign(new Error('INSECURE_CONTEXT'), {
      friendly: '当前页面不是安全上下文。请用 http://localhost 或 https 打开，不要直接双击 index.html。',
    });
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw Object.assign(new Error('NO_MEDIADEVICES'), {
      friendly: '这个浏览器不支持摄像头 API（getUserMedia）。建议使用 Chrome / Edge / Safari 的新版本。',
    });
  }
  // 2) 如果在 iframe / 嵌入式 WebView 里，且没有 allow="camera"，权限请求会被静默拦住，
  //    getUserMedia 既不弹窗也不报错（表现为「点了没反应」），所以提前识别这种环境。
  if (window.self !== window.top) {
    console.warn('[camera] 页面正运行在 iframe 中，若父页面没有 allow="camera" 权限，摄像头会一直处于 pending 状态');
  }

  const constraints = {
    audio: false,
    video: {
      facingMode: 'user',
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 60 },
    },
  };

  // 3) 关键：用已查到的权限状态决定等多久、能不能快速失败。
  //    实测在某些浏览器里，即使权限已经是「拒绝」，getUserMedia 也不会立刻 reject，
  //    而是一路挂到超时 —— 用户看到的就是「点了没反应」。
  const permission = state.cameraPermission;
  if (permission === 'denied') {
    throw Object.assign(new Error('NotAllowedError'), {
      friendly: '浏览器已记住「拒绝摄像头」。请点地址栏左侧图标（🔒 / ⚙ / 🎥）→ 把「摄像头」改成「允许」→ 刷新页面。',
    });
  }
  // 需要用户点弹窗时给足时间；已授权或状态未知时不必等太久
  const waitMs = permission === 'prompt' ? 20000 : 10000;

  let mediaError = null;
  // 监听权限变化：用户一点「拒绝」立刻失败，不用等超时
  let permissionWatch = null;
  try {
    if (navigator.permissions && navigator.permissions.query) {
      permissionWatch = await navigator.permissions.query({ name: 'camera' });
    }
  } catch (err) { /* 该浏览器不支持 'camera' 描述符，忽略 */ }

  let stream;
  const pending = navigator.mediaDevices.getUserMedia(constraints);
  pending.catch((e) => { mediaError = e; });   // 避免未处理的 rejection

  if (permissionWatch) {
    permissionWatch.onchange = () => {
      if (permissionWatch.state === 'denied') mediaError = { name: 'NotAllowedError' };
    };
  }

  const deadline = Date.now() + waitMs;
  try {
    while (!stream) {
      if (mediaError) throw mediaError;
      if (Date.now() > deadline) throw Object.assign(new Error('CAMERA_TIMEOUT'), { name: 'CAMERA_TIMEOUT' });
      const raced = await Promise.race([
        pending,
        sleep(250).then(() => null),
      ]);
      if (raced) stream = raced;
    }
  } catch (err) {
    const name = err && err.name;
    const isTimeout = name === 'CAMERA_TIMEOUT' || (err && err.message === 'CAMERA_TIMEOUT');
    // 只有「换套参数可能就好了」的情况才值得再试一次，权限类错误直接告诉用户
    const retryable = isTimeout || name === 'OverconstrainedError' || name === 'NotReadableError' || name === 'AbortError';
    if (!retryable) {
      throw Object.assign(new Error(name || 'CAMERA_FAILED'), { friendly: describeCameraError(err) });
    }
    try {
      stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user' } }),
        waitMs,
        'CAMERA_TIMEOUT',
      );
    } catch (err2) {
      const isTimeout2 = err2 && (err2.name === 'CAMERA_TIMEOUT' || err2.message === 'CAMERA_TIMEOUT');
      throw Object.assign(new Error(isTimeout2 ? 'CAMERA_TIMEOUT' : (err2.name || 'CAMERA_FAILED')), {
        friendly: describeCameraError(isTimeout2 ? { name: 'TimeoutError' } : err2),
      });
    }
  } finally {
    if (permissionWatch) permissionWatch.onchange = null;
  }

  hand.stream = stream;
  dom.video.srcObject = stream;
  dom.video.muted = true;
  dom.video.setAttribute('playsinline', '');

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('视频播放超时')), 12000);
    const done = () => { clearTimeout(timer); resolve(); };
    dom.video.onloadedmetadata = () => {
      dom.video.play().then(done).catch(() => {
        // iOS 上 play() 可能被拒，等一次用户交互就好，这里不致命
        clearTimeout(timer);
        resolve();
      });
    };
    if (dom.video.readyState >= 2) done();
  });

  state.cameraActive = true;
  dom.body.classList.add('is-live');
  return stream;
}

/** 把 getUserMedia 的错误翻译成中文提示 */
function describeCameraError(err) {
  const name = err && err.name ? err.name : '未知错误';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '摄像头权限被拒绝。请在浏览器地址栏的权限图标里把摄像头改为「允许」，然后刷新页面。';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return '没有找到摄像头设备。请确认设备有摄像头，或改用「指针模式」。';
    case 'NotReadableError':
    case 'TrackStartError':
      return '摄像头被其他程序占用（例如会议软件）。请关闭占用摄像头的程序后重试。';
    case 'OverconstrainedError':
      return '摄像头不支持所请求的分辨率。可以尝试改用「指针模式」。';
    case 'AbortError':
      return '摄像头启动被中止，请重试一次。';
    case 'TypeError':
      return '摄像头调用参数被拒绝，请确认页面是通过 http://localhost 或 https 打开的。';
    case 'TimeoutError':
      return `等待摄像头授权超过 ${Math.round(CAMERA_PERMISSION_TIMEOUT_MS / 1000)} 秒。` +
        '可能原因：① 权限弹窗被浏览器拦住了（注意地址栏左侧）② 页面嵌在 iframe 里且没有 allow="camera" ' +
        '③ 你还没点弹窗上的「允许」。请处理后重试。';
    default:
      return `摄像头启动失败：${name}。可以改用「指针模式」体验。`;
  }
}

/** 停止摄像头并释放资源 */
async function stopCamera() {
  if (hand.stream) {
    hand.stream.getTracks().forEach((t) => t.stop());
    hand.stream = null;
  }
  try { dom.video.pause(); } catch (e) { /* ignore */ }
  dom.video.srcObject = null;
  state.cameraActive = false;
  dom.body.classList.remove('is-live');
}

/** 初始化 MediaPipe Hands（可能耗时较久，需要下载模型） */
async function initHands() {
  setStatus('work', '正在加载手部模型…', '首次加载需下载约 8MB 的 wasm 与模型文件');

  let Hands = window.Hands;
  if (typeof Hands === 'undefined') {
    Hands = await loadScriptWithFallback(
      [CONFIG.mediapipeCdn, CONFIG.mediapipeCdnFallback],
      'Hands',
    );
  }
  hand.Hands = Hands;

  const instance = new Hands({
    // 关键：让 wasm / tflite / graph 都从同一个 CDN 目录取
    locateFile: (file) => CONFIG.mediapipeAssetBase + file,
  });
  instance.setOptions({
    maxNumHands: 1,               // 只认一只手，省算力也避免歧义
    modelComplexity: 1,           // 0 更快 / 1 更准（手机端可改 0）
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6,
    selfieMode: true,             // 镜像模式，与 CSS 镜像的 video 保持一致
  });
  instance.onResults(onHandResults);
  hand.instance = instance;

  // 预加载 wasm/模型：过程中给出提示，失败则降级
  if (typeof instance.initialize === 'function') {
    await withTimeout(instance.initialize(), CONFIG.handsLoadTimeout, 'MediaPipe 初始化');
  }
  return instance;
}

/** 每帧把摄像头画面推给 MediaPipe */
function startHandLoop() {
  let tickCount = 0;

  const tick = () => {
    tickCount++;
    if (hand.estimating) return;
    if (!hand.instance) return;
    if (!state.cameraActive) return;
    const video = dom.video;
    if (video.readyState < 2 || video.videoWidth === 0) return;

    hand.estimating = true;
    hand.frameCount++;
    hand.instance
      .send({ image: video })
      .catch((err) => {
        // 单帧失败不致命，但前几次失败必须暴露出来（否则会「静默不工作」）
        if (hand.frameCount <= 3 || hand.frameCount % 120 === 0) {
          console.warn('[hands] 推帧失败：', err && err.message ? err.message : err);
          hand.lastError = err;
        }
      })
      .finally(() => { hand.estimating = false; });
  };

  // 每 3 秒上报一次健康状态，方便排查「摄像头亮着但识别不动」的情况
  setInterval(() => {
    if (!state.cameraActive || !hand.instance) return;
    if (hand.frameCount === 0) {
      console.warn(
        `[hands] 3 秒内没有成功推过一帧：tick=${tickCount} readyState=${dom.video.readyState} ` +
        `videoSize=${dom.video.videoWidth}x${dom.video.videoHeight} estimating=${hand.estimating}`,
      );
    }
  }, 3000);

  // requestVideoFrameCallback 与视频帧同步，比 rAF 更省电；不支持就退回 rAF
  const schedule = () => {
    if (typeof dom.video.requestVideoFrameCallback === 'function') {
      dom.video.requestVideoFrameCallback(() => { tick(); schedule(); });
    } else {
      requestAnimationFrame(() => { tick(); schedule(); });
    }
  };
  schedule();
}

/**
 * MediaPipe 结果回调
 * results.multiHandLandmarks: Array<Array<{x,y,z}>> —— 归一化到 0~1 的 21 个关键点
 */
function onHandResults(results) {
  const hands = results && results.multiHandLandmarks;
  const list = Array.isArray(hands) ? hands : [];
  const lm = list.length > 0 ? list[0] : null;

  if (lm && lm.length >= 21) {
    state.handDetected = true;
    state.handLostTimer = 0;

    // ---- A. 用 21 个关键点算出张合度 ----
    // 回调由视频帧驱动（约 30fps），用一个固定步长即可；
    // 不要在这里调用 three.clock.getDelta()，那会干扰主循环的计时。
    const HANDS_DT = 1 / 30;
    state.tension = hand.estimator.update(lm, HANDS_DT);

    // ---- B. 关键点 → 世界坐标（让花朵跟随手指移动）----
    // 取掌心（0/5/9/13/17 的平均）作为「花朵被牵引」的锚点，比单点更稳
    const anchor = palmCenter(lm);
    // selfieMode 已经把 x 镜像过一次，直接映射即可
    updateHoverFromNormalized(clamp(anchor.x, 0, 1), clamp(anchor.y, 0, 1));
    state.hoverActive = true;

    // ---- C. 画关键点连线 ----
    if (state.settings.skeleton) drawHand(lm, state.tension);
    else clearOverlay();

    if (!state.cameraHintShown) {
      state.cameraHintShown = true;
      setStatus('ok', '手势识别运行中', '握拳闭合 · 张开绽放 · 移动手掌牵引花心');
    }
  } else {
    // 没检测到手：延迟一小段时间再判定「丢手」，避免眨眼式闪烁
    if (state.handDetected) {
      state.handLostTimer += 1 / 30;
      if (state.handLostTimer > CONFIG.handLostGrace) {
        state.handDetected = false;
        hand.estimator.update(null, 1 / 30);
        state.tension = hand.estimator.tension;
        clearOverlay();
      }
    } else {
      hand.estimator.update(null, 1 / 30);
      state.tension = hand.estimator.tension;
      if (state.settings.skeleton) clearOverlay();
    }
  }
}

/** 掌心中心（用 5 个掌部关键点求平均，抗抖动） */
function palmCenter(lm) {
  const ids = [0, 5, 9, 13, 17];
  let x = 0, y = 0, z = 0;
  for (const i of ids) { x += lm[i].x; y += lm[i].y; z += lm[i].z; }
  return { x: x / ids.length, y: y / ids.length, z: z / ids.length };
}

/** 归一化屏幕坐标 → 世界坐标（打到 z=0 平面） */
function updateHoverFromNormalized(nx, ny) {
  if (!three.camera) return;
  const ndc = new three.THREE.Vector2(nx * 2 - 1, -(ny * 2 - 1));
  three.raycaster.setFromCamera(ndc, three.camera);
  const hit = new three.THREE.Vector3();
  if (three.raycaster.ray.intersectPlane(three.pointerPlane, hit)) {
    state.hoverTarget.x = hit.x;
    state.hoverTarget.y = hit.y;
    state.hoverTarget.z = hit.z;
  }
}

/** 在覆盖层上画 21 个关键点与骨架连线 */
function drawHand(lm, tension) {
  if (!hand.ctx) {
    hand.ctx = dom.overlay.getContext('2d');
    if (!hand.ctx) return;
  }
  const ctx = hand.ctx;
  const w = dom.overlay.width;
  const h = dom.overlay.height;

  ctx.clearRect(0, 0, w, h);
  state.overlayCleared = false;

  // 画布坐标 = 归一化坐标 × 画布尺寸；x 镜像一次（与 video 的 CSS 镜像对应）
  const toPx = (p) => [w - p.x * w, p.y * h];

  // 颜色随张合度从「青蓝（握拳）」渐变到「粉金（张开）」
  const k = clamp(tension);
  const lineColor = `rgba(${Math.round(lerp(124, 255, k))}, ${Math.round(lerp(224, 150, k))}, 255, ${0.30 + 0.35 * k})`;
  const dotColor = `rgba(255, 245, 235, ${0.55 + 0.4 * k})`;
  const tipColor = `rgba(255, ${Math.round(lerp(200, 120, k))}, ${Math.round(lerp(180, 210, k))}, 0.95)`;

  ctx.lineWidth = Math.max(1.5, w * 0.0016);
  ctx.lineCap = 'round';
  ctx.strokeStyle = lineColor;
  ctx.shadowColor = lineColor;
  ctx.shadowBlur = w * 0.006;

  ctx.beginPath();
  for (const [a, b] of hand.connections) {
    if (!lm[a] || !lm[b]) continue;
    const [x1, y1] = toPx(lm[a]);
    const [x2, y2] = toPx(lm[b]);
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
  ctx.stroke();

  // 关键点
  ctx.shadowBlur = w * 0.004;
  const r = Math.max(2, w * 0.0028);
  for (let i = 0; i < lm.length; i++) {
    const [x, y] = toPx(lm[i]);
    const isTip = hand.tips.indexOf(i) >= 0;
    ctx.beginPath();
    ctx.fillStyle = isTip ? tipColor : dotColor;
    ctx.arc(x, y, isTip ? r * 1.7 : r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
}

function clearOverlay() {
  if (state.overlayCleared) return;
  if (!hand.ctx) hand.ctx = dom.overlay.getContext('2d');
  if (hand.ctx) hand.ctx.clearRect(0, 0, dom.overlay.width, dom.overlay.height);
  state.overlayCleared = true;
}

/* ==========================================================================
 * §7 HUD
 * ======================================================================== */

let statusTimer = 0;

function setStatus(kind, text, hint) {
  const cls = { ok: 'is-ok', work: 'is-work', warn: 'is-warn', error: 'is-error', idle: '' }[kind] ?? '';
  dom.statusDot.className = `dot ${cls}`.trim();
  dom.statusText.textContent = text;
  if (typeof hint === 'string') dom.statusHint.textContent = hint;
}

/** 把 tension 数值翻译成人话，方便用户理解阈值 */
function tensionStageLabel(tension) {
  if (tension < CONFIG.tensionClosed) return '花苞闭合';
  if (tension < 0.46) return '花苞初绽';
  if (tension < CONFIG.tensionOpen) return '花瓣舒展';
  if (tension < 0.9) return '盛放';
  return '完全绽放';
}

let hudAccum = 0;
let fpsSmoothed = 60;

function updateHud(dt) {
  hudAccum += dt;
  fpsSmoothed = lerp(fpsSmoothed, 1 / Math.max(dt, 1e-4), 0.08);
  if (hudAccum < 0.1) return;   // 最多每 100ms 刷一次 DOM，减少重排
  hudAccum = 0;

  dom.tensionValue.textContent = state.tension.toFixed(2);
  dom.tensionBar.style.width = `${(state.tension * 100).toFixed(1)}%`;
  dom.tensionStage.textContent = tensionStageLabel(state.tension);
  dom.spreadValue.textContent = state.currentSpread.toFixed(2);
  dom.fpsValue.textContent = fpsSmoothed.toFixed(0);
}

/* ==========================================================================
 * §8 主循环
 * ======================================================================== */

function animate() {
  requestAnimationFrame(animate);
  if (!state.ready) return;

  const THREE = three.THREE;
  const dt = clamp(three.clock.getDelta(), 1 / 240, 1 / 10);
  three.elapsed += dt;

  /* ---- 1. 指针模式下自己生成 tension（点击=绽放，拖动=牵引） ---- */
  if (state.mode === 'pointer') {
    if (state.pointerDown) {
      state.tension = lerp(state.tension, 1, 0.14);
      state.autoHold = 2.0;
    } else if (state.autoHold > 0) {
      state.autoHold -= dt;
    } else if (CONFIG.autoDemo) {
      // 没交互时缓慢演示开合，让人一眼看懂效果
      const target = smoothstep(0.0, 1.0, 0.5 + 0.5 * Math.sin((three.elapsed / CONFIG.autoDemoPeriod) * Math.PI * 2));
      state.tension = lerp(state.tension, target, 1 - Math.pow(0.001, dt));
    } else {
      state.tension = lerp(state.tension, 0, 1 - Math.pow(0.02, dt));
    }
  }

  /* ---- 2. 张合度 → 绽放目标（三段式映射） ---- */
  // 自动化测试用的钩子（正常使用时这些变量都不存在，无任何影响）：
  //   window.__HOLD_TENSION__  锁定张合度，便于在没有真实手部输入时截图
  //   window.__HOLD_SPREAD__   直接锁定绽放程度（跳过缓动），便于逐档对比形态
  //   window.__SKIP_INTRO__    true 时跳过入场淡入，立刻全亮
  if (typeof window !== 'undefined') {
    if (typeof window.__HOLD_TENSION__ === 'number') state.tension = window.__HOLD_TENSION__;
    if (typeof window.__HOLD_SPREAD__ === 'number') state.currentSpread = window.__HOLD_SPREAD__;
    if (window.__SKIP_INTRO__ === true) three.introT = 1;
  }
  state.targetSpread = tensionToSpread(state.tension, CONFIG.tensionClosed, CONFIG.tensionOpen);
  if (typeof window !== 'undefined' && typeof window.__HOLD_SPREAD__ === 'number') {
    state.targetSpread = window.__HOLD_SPREAD__;
  }

  /* ---- 3. 缓动：currentSpread += (targetSpread - currentSpread) * 0.1 ---- */
  // 0.1 是需求给定系数，这里按帧率归一化，保证 120Hz / 30Hz 屏幕速度一致
  const easing = 1 - Math.pow(1 - CONFIG.easing, dt * 60);
  state.currentSpread += (state.targetSpread - state.currentSpread) * easing;

  /* ---- 4. 指尖位置阻尼（跟随但不抖） ---- */
  const hoverDamp = 1 - Math.pow(0.0016, dt);
  state.hover.x = lerp(state.hover.x, state.hoverTarget.x, hoverDamp);
  state.hover.y = lerp(state.hover.y, state.hoverTarget.y, hoverDamp);
  state.hover.z = lerp(state.hover.z, state.hoverTarget.z, hoverDamp);

  /* ---- 5. 更新 uniform ---- */
  const u = three.material.uniforms;
  three.introT = Math.min(1, three.introT + dt * 0.85);
  u.uTime.value = three.elapsed;
  u.uSpread.value = state.currentSpread;
  u.uIntro.value = smoothstep(0, 1, three.introT);
  u.uHover.value.set(state.hover.x, state.hover.y, state.hover.z);
  // 指尖牵引强度：握拳（tension 小）时减弱，避免把花苞拉散；没有指尖时归零
  const hoverStrength = state.hoverActive ? smoothstep(0.05, 0.42, state.tension) : 0;
  u.uHoverActive.value = hoverStrength;

  /* ---- 6. 整体缓慢自转 + 固定倾角，让花朵有 3/4 视角的体积感 ---- */
  if (three.points) {
    three.points.rotation.y += dt * (0.08 + 0.05 * state.currentSpread);
    three.points.rotation.x = CONFIG.flowerTiltX + Math.sin(three.elapsed * 0.22) * 0.04;
    three.points.rotation.z = CONFIG.flowerTiltZ;
    // 相机轻微随指尖偏移（视差），强化「跟随手指」的感觉
    if (three.cameraBaseDistance && state.flowerData) {
      const cam = three.camera;
      const restY = state.flowerData.bounds.bloomRadius * CONFIG.cameraHeightRatio;
      const lookY = CONFIG.cameraLookAtY + state.hover.y * 0.06;
      cam.position.x = lerp(cam.position.x, state.hover.x * 0.08, 1 - Math.pow(0.02, dt));
      cam.position.y = lerp(cam.position.y, restY + state.hover.y * 0.05, 1 - Math.pow(0.05, dt));
      cam.lookAt(0, lookY, 0);
    }
  }

  /* ---- 7. 渲染 ---- */
  // 上下文丢失期间跳过渲染：renderer.render 此时是空操作，
  // 继续调用只会白跑一遍矩阵计算，还会刷屏警告
  if (!state.contextLost) {
    three.renderer.render(three.scene, three.camera);
  }

  /* ---- 8. HUD ---- */
  updateHud(dt);
}

/* ==========================================================================
 * §9 启动流程与事件绑定
 * ======================================================================== */

async function boot(mode) {
  if (state.started) return;
  state.started = true;
  state.mode = mode;

  // 关键：不立刻隐藏遮罩。遮罩里显示每一步的进度，避免「点了开始却毫无反应」。
  // 只有一切就绪之后才淡出；中途失败会把错误直接写在遮罩上，再点一次即可重试。
  dom.btnStart.disabled = true;
  dom.btnMouse.disabled = true;
  setBootProgress('正在加载 3D 引擎（three.js）…', '首次打开需要从 CDN 下载，请保持联网；若长时间无反应见下方第 3 条');

  try {
    await initThree();
  } catch (err) {
    console.error('[boot] Three.js 初始化失败：', err);
    bootFailed('3D 引擎加载失败', [
      err.message,
      '检查网络能否访问 unpkg.com / cdn.jsdelivr.net（console 里也能看到具体错误）',
      '或者按 README「方式 3」把 three 与 mediapipe 下载到 ./vendor/ 后用本地文件加载',
    ]);
    return;
  }

  onResize();
  animate();

  if (mode === 'camera' && state.settings.cameraOn) {
    const ok = await enableCameraMode();
    if (!ok) return;              // 没有真正进入手势模式：保留遮罩，让用户重试或改用指针模式
  } else {
    state.mode = 'pointer';
    setStatus('ok', '指针模式', '按住/拖动改变绽放 · 移动牵引花心');
    updateModeButton();
  }

  dom.controls.hidden = false;
  hideBoot();
}

/** 更新启动遮罩上的进度/错误文案 */
function setBootProgress(text, hint = '') {
  if (!dom.bootHint) return;
  dom.bootHint.textContent = hint ? `${text}\n${hint}` : text;
  dom.bootHint.classList.toggle('is-error', false);
}

/** 启动失败：把遮罩留在屏幕上，并写清原因与下一步该怎么做 */
function bootFailed(title, lines) {
  console.error('[boot]', title, lines);
  setStatus('error', title, lines[0]);
  if (dom.bootHint) {
    dom.bootHint.textContent = `❌ ${title}\n• ${lines.join('\n• ')}`;
    dom.bootHint.classList.add('is-error');
  }
  if (dom.btnStart) {
    dom.btnStart.disabled = false;
    dom.btnStart.textContent = '重试';
  }
  if (dom.btnMouse) {
    dom.btnMouse.disabled = false;
    dom.btnMouse.textContent = '不用摄像头，用指针';
  }
  // 允许重新启动（下次点击会重新走一遍流程）
  state.started = false;
}

function hideBoot() {
  dom.boot.classList.add('is-hidden');
}

/**
 * 进入摄像头手势模式（含完整错误处理与降级）
 * @returns {Promise<boolean>} 是否真正进入了手势模式
 */
async function enableCameraMode() {
  state.mode = 'camera';
  updateModeButton();

  // 先看一眼权限状态：如果之前被「拒绝」过，浏览器不会再弹窗，getUserMedia 会直接失败。
  // 提前告诉用户去哪儿改，比让他对着没反应的按钮强得多。
  const permission = await queryCameraPermission();
  state.cameraPermission = permission;
  if (permission === 'denied') {
    setStatus('error', '摄像头权限被拒绝',
      '浏览器不会再自动弹窗。请点地址栏左侧的图标（🔒 / ⚙）→ 把「摄像头」改为「允许」→ 刷新页面。');
    bootFailed('摄像头权限被拒绝', [
      '浏览器已记住「拒绝」，不会再自动弹窗',
      '点地址栏左侧的图标（🔒 / ⚙ / 🎥）→ 把「摄像头」改为「允许」→ 刷新页面后重试',
      '想立刻开始玩：点下面的「不用摄像头，用指针」',
    ]);
    await fallbackToPointer('摄像头权限被拒绝');
    return false;
  }

  setBootProgress('正在请求摄像头权限…', '浏览器会弹出授权询问，请选择「允许」');
  setStatus('work', '正在请求摄像头权限…', '浏览器会弹出权限询问，请选择「允许」');

  try {
    await startCamera();
  } catch (err) {
    console.error('[camera]', err);
    setStatus('error', '摄像头不可用', err.friendly || err.message || '未知错误');
    await fallbackToPointer('摄像头不可用');
    bootFailed('摄像头不可用', [
      err.friendly || err.message || '未知错误',
      '想先用鼠标玩：点下面的「不用摄像头，用指针」',
      '修好权限后想重试：点「重试」',
    ]);
    return false;
  }

  setBootProgress('正在加载手部识别模型…', '首次需要下载约 8MB 的 wasm 与模型文件，请稍候');
  setStatus('work', '正在加载手部模型…', '首次加载需下载约 8MB 的 wasm 与模型文件');

  try {
    await initHands();
  } catch (err) {
    console.error('[hands] 初始化失败：', err);
    setStatus('warn', '手势模型加载失败', `${err.message}。已切换为指针模式，或用鼠标/触摸体验。`);
    await stopCamera();
    await fallbackToPointer('模型加载失败');
    bootFailed('手部识别模型加载失败', [
      err.message,
      '通常是网络无法访问 unpkg.com / cdn.jsdelivr.net',
      '点下面的「不用摄像头，用指针」可以立即开始玩',
    ]);
    return false;
  }

  state.cameraHintShown = false;
  setStatus('work', '手部模型就绪', '把手放进画面中央试试：握拳 → 张开');
  startHandLoop();
  return true;
}

/**
 * 查询摄像头权限状态（Permissions API 在部分浏览器 / 隐私模式下不可用，失败就算了）
 * @returns {Promise<'granted'|'denied'|'prompt'|'unknown'>}
 */
async function queryCameraPermission() {
  try {
    if (!navigator.permissions || !navigator.permissions.query) return 'unknown';
    const status = await withTimeout(
      navigator.permissions.query({ name: 'camera' }),
      3000,
      '权限查询',
    );
    return status.state || 'unknown';
  } catch (err) {
    // Safari / Firefox 可能不支持 'camera' 这个 name，或超时
    return 'unknown';
  }
}

/** 降级到指针模式 */
async function fallbackToPointer(reason) {
  state.mode = 'pointer';
  state.tension = 0.75;          // 给一个「盛开」的初始状态，至少能看到花
  state.hoverActive = true;
  state.hoverTarget.x = 0;
  state.hoverTarget.y = 0;
  updateModeButton();
  if (reason) {
    dom.statusHint.textContent = `${reason}。已切换为指针模式：按住屏幕绽放、移动牵引花心。`;
  }
}

function updateModeButton() {
  if (!dom.btnMode) return;
  dom.btnMode.textContent = state.mode === 'camera' ? '切换为指针模式' : '切换为手势模式';
}

/** 退出摄像头模式（释放摄像头、关闭模型） */
async function disableCameraMode() {
  if (hand.instance) {
    try { hand.instance.close(); } catch (e) { /* ignore */ }
    hand.instance = null;
  }
  await stopCamera();
  clearOverlay();
  hand.estimator.reset();
  state.handDetected = false;
}

function bindUi() {
  /* ---- 启动按钮 ----
   * 三种语义：
   *   1. 首次点击        → 正常启动
   *   2. 上次启动失败后再点 → 重试（重新走完整流程）
   *   3. 3D 已就绪、只是摄像头失败后再点 → 直接跳过摄像头，用指针模式开始
   * 这样「点了没反应」的按钮永远有下一步可走。 */
  dom.btnStart.addEventListener('click', () => {
    if (state.started) return;                 // 正在进行中，忽略重复点击
    if (state.ready) {                        // 3D 已经跑起来了，只是上次摄像头失败
      setStatus('ok', '指针模式', '按住/拖动改变绽放 · 移动牵引花心');
      dom.btnMouse.disabled = false;
      dom.controls.hidden = false;
      state.mode = 'pointer';
      updateModeButton();
      hideBoot();
      return;
    }
    state.settings.cameraOn = dom.toggleCamera.checked;
    saveSettings({ cameraOn: state.settings.cameraOn });
    boot(state.settings.cameraOn ? 'camera' : 'pointer');
  });

  dom.btnMouse.addEventListener('click', () => {
    state.settings.cameraOn = false;
    saveSettings({ cameraOn: false });
    // 3D 已就绪（例如摄像头失败后）时不必重新加载，直接切到指针模式开始
    if (state.ready) {
      state.mode = 'pointer';
      state.hoverActive = true;
      setStatus('ok', '指针模式', '按住/拖动改变绽放 · 移动牵引花心');
      updateModeButton();
      dom.controls.hidden = false;
      hideBoot();
      return;
    }
    boot('pointer');
  });

  /* ---- 模式切换 ---- */
  dom.btnMode.addEventListener('click', async () => {
    if (state.mode === 'camera') {
      await disableCameraMode();
      state.mode = 'pointer';
      state.hoverActive = true;
      setStatus('ok', '指针模式', '按住/拖动改变绽放 · 移动牵引花心');
      updateModeButton();
    } else {
      dom.btnMode.disabled = true;
      await enableCameraMode();
      dom.btnMode.disabled = false;
    }
  });

  /* ---- 关键点连线开关 ---- */
  dom.toggleSkeleton.addEventListener('change', () => {
    state.settings.skeleton = dom.toggleSkeleton.checked;
    dom.overlay.classList.toggle('is-hidden', !state.settings.skeleton);
    if (!state.settings.skeleton) clearOverlay();
    saveSettings({ skeleton: state.settings.skeleton });
  });

  /* ---- 粒子数滑块（拖动结束后再重建，避免卡顿） ---- */
  let particleTimer = 0;
  dom.rangeParticles.addEventListener('input', () => {
    const value = clamp(parseInt(dom.rangeParticles.value, 10) || CONFIG.particles, CONFIG.particlesMin, CONFIG.particlesMax);
    state.settings.particles = value;
    dom.outParticles.textContent = value.toLocaleString('en-US');
    clearTimeout(particleTimer);
    particleTimer = setTimeout(() => {
      if (three.THREE) rebuildParticles(value);
      saveSettings({ particles: value });
    }, 160);
  });

  /* ---- 光晕滑块 ---- */
  dom.rangeGlow.addEventListener('input', () => {
    const value = parseFloat(dom.rangeGlow.value) || 1;
    state.settings.glow = value;
    dom.outGlow.textContent = value.toFixed(2);
    if (three.material) three.material.uniforms.uGlow.value = value;
    saveSettings({ glow: value });
  });

  /* ---- 恢复默认 ---- */
  dom.btnReset.addEventListener('click', () => {
    state.settings.particles = CONFIG.particles;
    state.settings.glow = 1;
    state.settings.skeleton = true;
    dom.rangeParticles.value = String(CONFIG.particles);
    dom.rangeGlow.value = '1';
    dom.outParticles.textContent = CONFIG.particles.toLocaleString('en-US');
    dom.outGlow.textContent = '1.00';
    dom.toggleSkeleton.checked = true;
    dom.overlay.classList.remove('is-hidden');
    if (three.material) three.material.uniforms.uGlow.value = 1;
    if (three.THREE) rebuildParticles(CONFIG.particles);
    hand.estimator.reset();
    saveSettings({ particles: CONFIG.particles, glow: 1, skeleton: true });
  });

  /* ---- 页面隐藏时暂停时钟，回来不会因为 dt 过大而跳变 ---- */
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && three.clock) three.clock.getDelta();
  });

  /* ---- 全局错误兜底 ---- */
  window.addEventListener('error', (e) => {
    console.error('[window error]', e.error || e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[unhandled rejection]', e.reason);
  });
}

/** 恢复上次的设置 */
function restoreSettings() {
  const saved = loadSettings();
  if (!saved) return;
  if (typeof saved.particles === 'number') {
    state.settings.particles = clamp(saved.particles, CONFIG.particlesMin, CONFIG.particlesMax);
    dom.rangeParticles.value = String(state.settings.particles);
    dom.outParticles.textContent = state.settings.particles.toLocaleString('en-US');
  }
  if (typeof saved.glow === 'number') {
    state.settings.glow = clamp(saved.glow, 0.4, 2.4);
    dom.rangeGlow.value = String(state.settings.glow);
    dom.outGlow.textContent = state.settings.glow.toFixed(2);
  }
  if (typeof saved.skeleton === 'boolean') {
    state.settings.skeleton = saved.skeleton;
    dom.toggleSkeleton.checked = saved.skeleton;
    dom.overlay.classList.toggle('is-hidden', !saved.skeleton);
  }
  if (typeof saved.cameraOn === 'boolean') {
    state.settings.cameraOn = saved.cameraOn;
    dom.toggleCamera.checked = saved.cameraOn;
  }
}

/* ---- 入口 ---- */
(function main() {
  // 摄像头列表可能为空（无设备），提前给出提示
  restoreSettings();
  sizeOverlayCanvas();
  bindUi();
  bindPointerEvents();

  // 移动端默认降一档粒子数，保证 60fps
  const isMobile = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(navigator.userAgent);
  if (isMobile && state.settings.particles > 16000) {
    state.settings.particles = 12000;
    dom.rangeParticles.value = '12000';
    dom.outParticles.textContent = '12,000';
  }

  setStatus('idle', '待启动', '点击「开始」并允许摄像头');

  if (!window.isSecureContext) {
    setStatus('warn', '非安全上下文', '请通过 http://localhost 或 https 打开页面，否则无法调用摄像头；也可以直接使用指针模式。');
  }

  // 页面卸载时主动释放摄像头
  window.addEventListener('pagehide', () => { stopCamera(); });
})();
