# 指尖绽放 · Gesture Bloom

> 用摄像头识别你的手：**握拳**花朵聚为花苞，**张开五指**粒子向外绽放，**移动手掌**牵引花心。

在线体验：**https://fkr3301.github.io/gesture-bloom/**

一个纯前端、无需构建、无需服务器的实时手势交互作品。Three.js 在 GPU 上绘制上万粒子组成的花朵，MediaPipe Hands 在浏览器里识别 21 个手部关键点，二者共同驱动一个自定义 GLSL ShaderMaterial 完成从"花苞"到"绽放"的连续形变。

---

## 玩法

| 手势 | 效果 |
| --- | --- |
| 握拳 | 粒子收拢为花苞（tension → 0） |
| 张开五指 | 花瓣向外绽放（tension → 1） |
| 移动手掌 | 花心跟随牵引 |
| 旋转手腕 | 花朵随之倾斜 |

没有摄像头也可以玩——启动页选择"**不用摄像头，用指针**"，用鼠标或手指在屏幕上模拟张合。

底部控制面板可以实时调节：

- 粒子数（3000 – 40000，默认 12000）
- 光晕半径（0.4× – 2.4×）
- 关键点连线开关
- 手势 / 指针模式切换

---

## 技术栈

- **[Three.js](https://threejs.org/) 0.169** — WebGL 渲染，通过 `<script type="importmap">` 从 CDN 直接以 ES Module 引入，无需 npm 也无需打包。
- **[MediaPipe Hands](https://developers.google.com/mediapipe/solutions/vision/hand_landmarker)** — 浏览器端实时手部关键点识别（21 点 + 骨架连线），摄像头画面**只在本机处理**，不上传服务器。
- **原生 GLSL** — 自定义 `ShaderMaterial`：
  - 顶点着色器：花苞态 / 绽放态两组位置之间的 smoothstep 插值、方向向量 slerp、指尖牵引、呼吸飘动、透视点尺寸、三档调色板取色。
  - 片元着色器：把方形点精灵画成"柔核 + 外晕"的圆形光斑，配合加色混合出辉光。
- **纯 JavaScript (ES Module)** — 无框架、无构建步骤、无依赖安装。
- **原生 CSS** — HUD、启动遮罩、控制面板。
- **GitHub Pages** — 静态托管（HTTPS，满足摄像头权限要求）。

CDN 走的是 `registry.npmmirror.com`，国内访问友好；如果部署到海外，可以把 importmap 里的 URL 换成 `unpkg.com` 或 `cdn.jsdelivr.net`。

---

## 项目结构

```
.
├── index.html      # 页面骨架：摄像头层 / WebGL 层 / 关键点覆盖层 / HUD / 启动遮罩
├── main.js         # 入口：场景装配、手势接入、主循环、事件绑定
├── shaders.js      # GLSL 顶点 & 片元着色器源码
├── flowerMath.js   # 纯数学模块：张合度估算、花朵几何生成（不依赖 DOM / Three.js）
├── style.css       # 样式
└── .nojekyll       # 让 GitHub Pages 直接托管，跳过 Jekyll 处理
```

`main.js` 内部按 §1–§9 分段注释，`flowerMath.js` 可以独立在 Node 里 import，方便做数值自检。

---

## 本地运行

因为浏览器只在 `http://localhost` 或 `https://` 下允许访问摄像头，`file://` 直接打开 index.html 会拿不到权限。用任意静态服务器起一下即可：

```bash
# 任选其一
python -m http.server 8000
npx serve .
php -S localhost:8000
```

然后访问 http://localhost:8000/ 。

---

## 部署到自己的 GitHub Pages

1. Fork 或 clone 本仓库
2. 推送静态文件到 `main` 分支根目录
3. 仓库 **Settings → Pages**：Source 选 `Deploy from a branch`，Branch 选 `main` / `/ (root)`，Save
4. 约 1 分钟后即可通过 `https://<你的用户名>.github.io/<仓库名>/` 访问

`.nojekyll` 已经放在仓库根目录，GitHub Pages 会跳过 Jekyll 直接托管原始文件。

---

## 常见问题

- **点了"开始"很久没反应** — 多半是 CDN 加载失败或权限弹窗被拦截。看启动页下方的提示；也可以先点"不用摄像头，用指针"体验。
- **黑屏但能看到 HUD** — WebGL 上下文可能被禁用，检查浏览器硬件加速设置。
- **手机上很卡** — 把粒子数调低到 5000 左右，或者关闭关键点连线。

---

## 许可

个人学习 / 演示用途。基于 Three.js（MIT）与 MediaPipe（Apache-2.0）。
