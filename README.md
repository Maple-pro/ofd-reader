# OFD 阅读器

在浏览器里直接打开 OFD 文件（GB/T 33190-2016 开放版式文档），**针对扫描件（整页图片）优化**。
文件不上传，全部在本地解析渲染。

## 功能

- 选择文件或直接拖拽 `.ofd` 到窗口即可打开
- 页面视图：上一页/下一页/首页/末页、页码跳转、缩略图导航（可折叠）
- 缩放：适合宽度、适合页面、实际大小、`Ctrl + 滚轮`以光标为中心缩放、`Ctrl + +/−/0`
- 旋转：整体顺时针/逆时针 90°
- 导出：当前页导出为 JPEG；整份文档打印（按页渲染后走浏览器打印）
- 深色模式跟随系统；快捷键 `← → PageUp PageDown Home End Space Ctrl+O`

扫描件相关的专门优化：

- 页面只在可见时解析、绘制，解析结果带缓存（LRU），缩略图懒加载
- 内嵌图片保持原始压缩字节，**解码成位图按需进行**，翻到哪页解码哪页；
  一页只看一次就离开时不会常驻大图内存
- 画布按当前缩放和屏幕像素比出图，缩放到 400% 仍从原图重采样，不糊
- 打开时只预解析前 24 页的元数据，千页文档也是秒开

## 快速开始

```bash
npm install
npm run dev          # 打开 http://127.0.0.1:5199/
```

生产构建：

```bash
npm run build        # 产物在 dist/，用任意静态服务器托管即可
npm run preview
```

`public/samples/` 里放了两份可直接打开的示例：

- `sample-scan.ofd`：7 页扫描件（本项目的参考文件）
- `sample-vector.ofd`：合成文件，覆盖文字、矢量路径、曲线、内嵌图片、模板页

也可以直接用 `?src=` 指定文件地址自动打开（便于分享和自动化测试）：

```
http://127.0.0.1:5199/?src=/samples/sample-scan.ofd
```

> `file://` 下浏览器禁止读取本地文件，用 `?src=` 请通过本地服务器访问。

## 实现方式

### 版式文档能力来自现成实现

容器解析按 `@sharp9/ofdjs`（Apache-2.0 的 JS OFD 阅读器）的模型内联实现，
章节见 `src/lib/container.ts` 顶部注释：`OFD.xml → Document.xml → DocumentRes.xml /
PublicRes.xml → Pages/*/Content.xml`，路径规则、元素名、属性名保持一致。

没有直接依赖该包的原因有两个，也是本项目相对它的主要改动：

1. 它的入口文件静态引用了 `canvas` / `linkedom` / `@xmldom/xmldom` 三个 Node 专用可选依赖，
   Vite 预打包无法解析（会直接报 `Failed to resolve import "@xmldom/xmldom"`）。
2. 它丢弃了 `PathObject/AbbreviatedData`（OFD 的路径指令），只能把矢量画成外接矩形；
   本项目自己解析（`src/render/paths.ts`，支持 `M/L/H/V/C/Q/B/Z`、相对指令与隐式连线）。

另外修正了这些实际会导致渲染错误的问题：

| 问题 | 处理 |
| --- | --- |
| DOM 实现差异：XML 元素的 `localName` 可能仍带前缀（`ofd:Page`） | 统一按本地名匹配（`tagOf`），对 `<ofd:Page>`、`<Page>`、无前缀都成立 |
| `<PhysicalBox>` 是**子元素**而非属性 | 从子元素文本读取，同时兼容写成属性的文档 |
| 图片对象的 `CTM` 对整页扫描件只是 `w 0 0 h 0 0`，与 `Boundary` 重复 | 位置用 `Boundary`，只取 `CTM` 中的旋转分量（否则尺寸会被平方） |
| 矢量对象、文字对象的 `CTM` 未应用 | 统一 `ctx.transform` 应用 |
| 一次性解码全部图片 | 按需解码 + 可用即重绘（`ImageStore`） |
| 部分文档声明的字间距远小于实际字宽，文字叠在一起 | 实测宽度明显更大时按比例放大字距（`drawText`） |

### 数据流

```
File ─► container.ts      ZIP → OFD.xml / Document.xml / DocumentRes.xml / PublicRes.xml
       ├─ resources.ts    图片 → Blob/objectURL（保留压缩字节）；字体 → 查找表
       ├─ page-parser.ts  页面 XML → 毫米单位的渲染 IR（含模板层合并、扫描页识别）
       └─ renderer.ts     IR → Canvas 2D（一次 mm→px 变换，分辨率无关）
                          ImageStore 按需提供位图
React  ── viewerStore ── Toolbar / OutlineRail / Viewport / PageCanvas
```

几个关键点：

- **坐标系**：IR 全部用毫米（OFD 原生单位），渲染时只做一次 `ctx.scale(pxPerMm, pxPerMm)`，
  所以缩略图、屏幕、导出/打印（150/200 dpi）共用同一条渲染路径。
- **扫描页识别**：页面只有一个图片对象、覆盖 ≥97% 页面、且无明显旋转时标记为“扫描件”，
  状态栏与缩略图会显示；渲染路径不变，仍是同一套画布绘制。
- **内存**：`ImageStore` 用 `createImageBitmap` 解码，解码完成后通知订阅者重绘；
  页面对象缓存上限 48 页，超出后按插入顺序淘汰。

## 开发脚本

| 命令 | 用途 |
| --- | --- |
| `npm run check` | 纯 Node 单测：`AbbreviatedData` 解析、字间距展开、矩阵/坐标辅助函数 |
| `npm run inspect <file.ofd> [页] [dpi]` | 用真实模块跑完整解析 + 渲染，打印页面 IR 与每一条绘制调用 |
| `npm run sample` | 重新生成 `public/samples/sample-vector.ofd` |
| `npm run probe <url> [表达式文件]` | 用 Chrome DevTools 协议在无头浏览器里检查画布像素、控制台报错 |

`npm run inspect` 是最快的排查手段，例如：

```bash
npm run inspect -- public/samples/sample-scan.ofd 0 96
```

会输出页面尺寸、图片/文字/路径对象明细，以及两轮绘制的调用列表（第一轮请求解码，
第二轮位图就绪后真正画出来）。

## 已知限制

- 不支持 JBIG2 / TIFF / BMP 内嵌图片（浏览器不能直接解码），这些图片会被跳过并在控制台提示；
  可用 `npm run inspect` 确认是哪个资源
- 不支持 OFD 加密 / 签名校验；印章是按普通图片/路径绘制的
- 文字只做绘制，不可选中、复制、搜索（没有做字形到文本的映射）
- `A/S/T` 路径指令不解析，这类对象退化为绘制其 `Boundary` 矩形
- 尚未实现连续滚动模式（当前是单页 + 缩略图导航）

## 目录

```
src/
  lib/container.ts     OFD 容器解析（ZIP / OFD.xml / Document.xml / 资源表）
  lib/resources.ts     图片资源 → Blob/objectURL，字体表
  lib/image-store.ts   位图按需解码、缓存与通知
  lib/page-parser.ts   页面 XML → 毫米 IR（含临时补丁与模板合并）
  lib/document.ts      文档装载编排、页面元数据、页面缓存
  lib/export.ts        JPEG 导出与打印
  render/paths.ts      AbbreviatedData 解析
  render/types.ts      几何与 IR 类型
  render/renderer.ts   Canvas 2D 渲染器
  components/          Toolbar / OutlineRail / Viewport / PageCanvas / EmptyState
  hooks/               文档装载、视图变换、可见性观察
  state/viewerStore.ts 视图状态（页码/缩放/旋转/缩略图开关）
scripts/               生成示例、单测、渲染检查、无头浏览器探针
```
