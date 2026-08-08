# Songloft 歌单导入器插件

识别市面音乐软件分享歌单，导入至 Songloft 歌单中，或通过洛雪音源进行下载。

## 功能特色

- **多平台歌单识别**：自动识别网易云音乐、QQ音乐、酷我音乐、酷狗音乐、汽水音乐的分享链接
- **短链接解析**：支持 163cn.tv、url.cn、qishui.douyin.com 等短链接自动重定向解析
- **两种音源模式**：
  - **内置音源**（推荐）：使用 Songloft 内置洛雪音源，无需部署任何外部服务
  - **外部 API**：自行部署洛雪音源 API 服务器，获取更稳定的下载链接
- **歌单预览**：导入前可预览歌单名称、封面、曲目列表
- **两种导入模式**：
  - **下载模式**：通过洛雪音源下载音乐文件到本地音乐目录
  - **串流模式**：以远程歌曲形式导入，不占用本地存储
- **跨平台匹配**：当歌单平台与洛雪音源平台不一致时，自动搜索匹配
- **进度追踪**：实时显示导入进度、当前处理曲目、错误列表
- **曲库去重**：导入前自动检查曲库中是否已有相同歌曲

## 前置条件

1. **Songloft** v2.0+ 已安装并运行
2. **Node.js** 18+（用于构建插件）

> **音源说明**：默认使用 Songloft 内置洛雪音源，无需额外部署。如需使用外部洛雪音源 API 服务器，可选配以下任一：
> - [lx-source](https://github.com/ZxwyWebSite/lx-source)（Go 实现，推荐）
> - [lx-music-api-server](https://github.com/MeoProject/lx-music-api-server)（Python 实现）

## 构建与安装

### 1. 安装依赖

```bash
cd songloft-playlist-importer
npm install
```

### 2. 构建插件

```bash
npm run build
```

构建完成后，`dist/` 目录下会生成 `playlist-importer.jsplugin.zip`。

### 3. 安装到 Songloft

**方式一：设置页面上传**
- 打开 Songloft Web 界面 → 设置 → 插件管理
- 上传 `dist/playlist-importer.jsplugin.zip`

**方式二：开发模式热重载**
```bash
npm run dev
```
自动构建、上传并监听文件变更，适合开发调试。

**方式三：手动放置**
- 将 zip 解压到 Songloft 的 `data/jsplugins/playlist-importer/` 目录
- 重启 Songloft

## 使用指南

### 步骤 1：配置音源

1. 在 Songloft 中打开「歌单导入器」插件页面
2. 切换到「设置」标签
3. 选择音源模式：
   - **内置音源**（推荐）：使用 Songloft 内置洛雪音源，无需额外配置
   - **外部 API**：填入洛雪音源 API 服务器地址（如 `http://192.168.1.100:8080`），如有密钥验证则填入 API 密钥
4. 点击「测试连接」确认音源可用
5. 点击「保存设置」

### 步骤 2：配置导入选项

- **导入模式**：
  - 下载模式：将音乐文件下载到 Songloft 音乐目录（需重新扫描音乐库）
  - 串流模式：以远程 URL 形式导入，直接串流播放
- **默认音质**：128k / 320k / flac / flac24bit
- **默认搜索来源**：跨平台匹配时使用的搜索平台

### 步骤 3：导入歌单

1. 切换到「导入歌单」标签
2. 将音乐 App 的分享链接或文字贴入输入框
3. 点击「预览歌单」查看歌单信息
4. 确认无误后点击「开始导入」
5. 等待导入完成，查看进度和结果

## 支持的分享链接格式

| 平台 | 示例 |
|------|------|
| 网易云音乐 | `https://music.163.com/playlist?id=123456` |
| 网易云音乐（短） | `https://y.music.163.com/m/playlist?id=123456` |
| QQ音乐 | `https://y.qq.com/n/ryqq/playlist/abc123` |
| 酷我音乐 | `http://www.kuwo.cn/playlist_detail/123456` |
| 酷狗音乐 | `https://www.kugou.com/yy/special/single/123456.html` |
| 汽水音乐 | `https://qishui.douyin.com/s/xxxxx` |

也支持包含 URL 的分享文字，如：
```
我分享了一个歌单 https://y.music.163.com/m/playlist?id=123456 一起听吧
```

> **汽水音乐说明**：汽水音乐无直接对应的洛雪音源，导入时会自动在其他平台（酷我/QQ/网易云等）搜索匹配同名歌曲进行下载。

## 项目结构

```
songloft-playlist-importer/
├── package.json              # 项目配置与构建脚本
├── tsconfig.json             # TypeScript 配置
├── plugin.json               # Songloft 插件清单
├── src/
│   ├── main.ts               # 主入口 — 生命周期 + HTTP 路由
│   ├── types.ts              # 类型定义与常量
│   ├── config.ts             # 配置管理（songloft.storage）
│   ├── utils.ts              # 工具函数
│   ├── parsers.ts            # 分享链接解析器（5 平台）
│   ├── fetchers.ts           # 歌单抓取器 + 跨平台搜索
│   ├── luoxue.ts             # 洛雪音源客户端
│   └── songloft-api.ts       # Songloft REST API 客户端
├── static/
│   ├── index.html            # 前端 UI 页面（内联 CSS/JS）
│   └── icon.jpg              # 插件图标
└── dist/                     # 构建输出（自动生成）
    └── playlist-importer.jsplugin.zip
```

## 架构说明

```
用户贴上分享链接
        │
        ▼
  ┌─────────────┐
  │  解析器      │  识别平台 + 提取歌单 ID
  │ parsers.ts  │  支持短链接重定向
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │  抓取器      │  从平台 API 获取歌单曲目列表
  │ fetchers.ts │  网易云 / QQ / 酷我 / 酷狗 / 汽水
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │  音源处理    │  内置音源：生成 sourceData 交给 Songloft 解析
  │ luoxue.ts   │  外部 API：获取下载/串流 URL
  │             │  自动跨平台搜索匹配
  └──────┬──────┘
         │
         ▼
  ┌──────────────┐
  │ Songloft API │  创建歌单 → 匹配/下载/新增歌曲 → 加入歌单
  │songloft-api  │
  └──────────────┘
```

## 插件 API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/config` | 取得当前配置 |
| POST | `/api/config` | 保存配置 |
| GET | `/api/platforms` | 取得支持平台列表 |
| POST | `/api/parse` | 解析分享链接 |
| POST | `/api/preview` | 解析 + 抓取歌单（预览） |
| POST | `/api/import` | 启动歌单导入任务 |
| GET | `/api/status` | 取得导入进度 |
| POST | `/api/test-luoxue` | 测试洛雪音源服务器连通性 |

## 洛雪音源服务器部署

### lx-source（Go，推荐）

```bash
# Docker 部署
docker run -d \
  --name lx-source \
  -p 8080:8080 \
  -v ./data:/app/data \
  ghcr.io/zxwy/lx-source:latest
```

部署后在插件设置中填入 `http://服务器IP:8080`。

### lx-music-api-server（Python）

```bash
git clone https://github.com/MeoProject/lx-music-api-server.git
cd lx-music-api-server
pip install -r requirements.txt
python main.py
```

## 常见问题

**Q: 导入时提示「无法识别此分享链接」？**
A: 确认链接来自支持的五个平台之一。如果是短链接，可能需要等待重定向解析。

**Q: 下载模式导入后听不到歌？**
A: 下载模式需要手动在 Songloft 设置中重新扫描音乐库，扫描完成后歌曲才会出现。

**Q: 串流模式提示「无法新增远程歌曲」？**
A: 串流模式依赖 Songloft 的远程歌曲 API，请确认 Songloft 版本支持此功能。

**Q: 跨平台匹配不准确？**
A: 跨平台搜索基于歌名+艺术家模糊匹配，可能出现误匹配。建议将默认搜索来源设为与歌单相同的平台。

**Q: 汽水音乐导入失败？**
A: 汽水音乐通过解析分享页面提取曲目信息，依赖页面结构。若汽水音乐更新页面结构，可能需要更新插件。此外，汽水音乐的歌曲需在其他平台搜索匹配后才能下载，匹配率可能不如原生平台。

**Q: 洛雪音源 API 回应异常？**
A: 各音乐平台 API 可能随时变更导致失效。请确保洛雪音源服务器使用最新版本。

## 授权

Apache-2.0
