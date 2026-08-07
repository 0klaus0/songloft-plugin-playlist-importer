# Songloft 歌單匯入器插件

識別市面音樂軟件分享歌單，匯入至 Songloft 歌單中，或通過配置洛雪音源進行下載。

## 功能特色

- **多平台歌單識別**：自動識別網易雲音樂、QQ音樂、酷我音樂、酷狗音樂的分享連結
- **短連結解析**：支援 163cn.tv、url.cn 等短連結自動重定向解析
- **歌單預覽**：匯入前可預覽歌單名稱、封面、曲目列表
- **兩種匯入模式**：
  - **下載模式**：通過洛雪音源下載音樂檔案到本地音樂目錄
  - **串流模式**：以遠端歌曲形式匯入，不佔用本地儲存
- **跨平台匹配**：當歌單平台與洛雪音源平台不一致時，自動搜尋匹配
- **進度追蹤**：即時顯示匯入進度、當前處理曲目、錯誤列表
- **曲庫去重**：匯入前自動檢查曲庫中是否已有相同歌曲

## 前置條件

1. **Songloft** v2.0+ 已安裝並運行
2. **Node.js** 18+（用於建置插件）
3. **洛雪音源 API 伺服器**（以下任一）：
   - [lx-source](https://github.com/ZxwyWebSite/lx-source)（Go 實現，推薦）
   - [lx-music-api-server](https://github.com/MeoProject/lx-music-api-server)（Python 實現）

## 建置與安裝

### 1. 安裝依賴

```bash
cd songloft-playlist-importer
npm install
```

### 2. 建置插件

```bash
npm run build
```

建置完成後，`dist/` 目錄下會生成 `playlist-importer.jsplugin.zip`。

### 3. 安裝到 Songloft

**方式一：設定頁面上傳**
- 開啟 Songloft Web 介面 → 設定 → 插件管理
- 上傳 `dist/playlist-importer.jsplugin.zip`

**方式二：開發模式熱重載**
```bash
npm run dev
```
自動構建、上傳並監聽檔案變更，適合開發除錯。

**方式三：手動放置**
- 將 zip 解壓到 Songloft 的 `data/jsplugins/playlist-importer/` 目錄
- 重啟 Songloft

## 使用指南

### 步驟 1：配置洛雪音源

1. 在 Songloft 中開啟「歌單匯入器」插件頁面
2. 切換到「設定」標籤
3. 填入洛雪音源 API 伺服器位址（如 `http://192.168.1.100:8080`）
4. 如伺服器有密鑰驗證，填入 API 密鑰
5. 點擊「測試連接」確認伺服器可達
6. 點擊「儲存設定」

### 步驟 2：配置匯入選項

- **匯入模式**：
  - 下載模式：將音樂檔案下載到 Songloft 音樂目錄（需重新掃描音樂庫）
  - 串流模式：以遠端 URL 形式匯入，直接串流播放
- **預設音質**：128k / 320k / flac / flac24bit
- **預設搜尋來源**：跨平台匹配時使用的搜尋平台

### 步驟 3：匯入歌單

1. 切換到「匯入歌單」標籤
2. 將音樂 App 的分享連結或文字貼入輸入框
3. 點擊「預覽歌單」查看歌單資訊
4. 確認無誤後點擊「開始匯入」
5. 等待匯入完成，查看進度和結果

## 支援的分享連結格式

| 平台 | 範例 |
|------|------|
| 網易雲音樂 | `https://music.163.com/playlist?id=123456` |
| 網易雲音樂（短） | `https://y.music.163.com/m/playlist?id=123456` |
| QQ音樂 | `https://y.qq.com/n/ryqq/playlist/abc123` |
| 酷我音樂 | `http://www.kuwo.cn/playlist_detail/123456` |
| 酷狗音樂 | `https://www.kugou.com/yy/special/single/123456.html` |

也支援包含 URL 的分享文字，如：
```
我分享了一個歌單 https://y.music.163.com/m/playlist?id=123456 一起聽吧
```

## 專案結構

```
songloft-playlist-importer/
├── package.json              # 專案配置與建置腳本
├── tsconfig.json             # TypeScript 配置
├── plugin.json               # Songloft 插件清單
├── src/
│   ├── main.ts               # 主入口 — 生命週期 + HTTP 路由
│   ├── types.ts              # 型別定義與常數
│   ├── config.ts             # 配置管理（songloft.storage）
│   ├── utils.ts              # 工具函數
│   ├── parsers.ts            # 分享連結解析器（4 平台）
│   ├── fetchers.ts           # 歌單抓取器 + 跨平台搜尋
│   ├── luoxue.ts             # 洛雪音源客戶端
│   └── songloft-api.ts       # Songloft REST API 客戶端
├── static/
│   ├── index.html            # 前端 UI 頁面
│   ├── style.css             # 樣式表
│   └── app.js                # 前端邏輯
└── dist/                     # 建置輸出（自動生成）
    └── playlist-importer.jsplugin.zip
```

## 架構說明

```
使用者貼上分享連結
        │
        ▼
  ┌─────────────┐
  │  解析器      │  識別平台 + 提取歌單 ID
  │ parsers.ts  │  支援短連結重定向
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │  抓取器      │  從平台 API 獲取歌單曲目列表
  │ fetchers.ts │  網易雲 / QQ / 酷我 / 酷狗
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │  洛雪音源    │  獲取下載/串流 URL
  │ luoxue.ts   │  自動跨平台搜尋匹配
  └──────┬──────┘
         │
         ▼
  ┌──────────────┐
  │ Songloft API │  建立歌單 → 匹配/下載/新增歌曲 → 加入歌單
  │songloft-api  │
  └──────────────┘
```

## 插件 API 端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/config` | 取得當前配置 |
| POST | `/api/config` | 儲存配置 |
| GET | `/api/platforms` | 取得支援平台列表 |
| POST | `/api/parse` | 解析分享連結 |
| POST | `/api/preview` | 解析 + 抓取歌單（預覽） |
| POST | `/api/import` | 啟動歌單匯入任務 |
| GET | `/api/status` | 取得匯入進度 |
| POST | `/api/test-luoxue` | 測試洛雪音源伺服器連通性 |

## 洛雪音源伺服器部署

### lx-source（Go，推薦）

```bash
# Docker 部署
docker run -d \
  --name lx-source \
  -p 8080:8080 \
  -v ./data:/app/data \
  ghcr.io/zxwy/lx-source:latest
```

部署後在插件設定中填入 `http://伺服器IP:8080`。

### lx-music-api-server（Python）

```bash
git clone https://github.com/MeoProject/lx-music-api-server.git
cd lx-music-api-server
pip install -r requirements.txt
python main.py
```

## 常見問題

**Q: 匯入時提示「無法識別此分享連結」？**
A: 確認連結來自支援的四個平台之一。如果是短連結，可能需要等待重定向解析。

**Q: 下載模式匯入後聽不到歌？**
A: 下載模式需要手動在 Songloft 設定中重新掃描音樂庫，掃描完成後歌曲才會出現。

**Q: 串流模式提示「無法新增遠端歌曲」？**
A: 串流模式依賴 Songloft 的遠端歌曲 API，請確認 Songloft 版本支援此功能。

**Q: 跨平台匹配不準確？**
A: 跨平台搜尋基於歌名+藝術家模糊匹配，可能出現誤匹配。建議將預設搜尋來源設為與歌單相同的平台。

**Q: 洛雪音源 API 回應異常？**
A: 各音樂平台 API 可能隨時變更導致失效。請確保洛雪音源伺服器使用最新版本。

## 授權

Apache-2.0
