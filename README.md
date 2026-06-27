# 🎬 Gimy 追劇站

整合 [Gimy 劇迷](https://gimyai.tw) 的影劇更新資源，做成一個部署在 **GitHub Pages** 的追劇網頁。

- 🔍 **搜尋**：依劇名 / 演員 / 類型 / 地區即時搜尋
- ❤️ **加入最愛**：收藏想追的劇（儲存在你瀏覽器本機 localStorage）
- ↕️ **排序**：更新時間（新→舊 / 舊→新）、集數、名稱、評分
- 🔔 **新集數提醒**：最愛影劇有新集數時，首頁橫幅標示 + 瀏覽器通知
- 🔄 **自動更新**：GitHub Actions 每 6 小時自動抓取 Gimy 最新資料並重新部署

> 本站僅整合與索引 Gimy 公開的「更新資訊」（劇名、集數、更新時間等），
> 不儲存也不代理任何影片內容；所有「觀看 / 詳情」連結皆直接連回 Gimy 原站。

## 功能畫面

主頁顯示最新影劇、我的最愛，以及最愛有新集數時的提醒橫幅；每張卡片含海報、集數標籤、
更新時間、評分，右上角 ♡ 可一鍵收藏。

## 專案結構

```
.
├── index.html              # 網頁主頁
├── assets/
│   ├── style.css           # 樣式
│   └── app.js              # 前端邏輯（搜尋 / 最愛 / 排序 / 新集數提醒）
├── data/
│   ├── videos.json         # 影劇資料（由爬蟲產生；初始為示範資料）
│   └── meta.json           # 更新時間等中繼資訊
├── scraper/
│   └── scrape.mjs          # Node.js 爬蟲（抓 Gimy 的 maccms JSON 介面）
└── .github/workflows/
    └── deploy.yml          # 自動抓資料 + 部署到 GitHub Pages
```

## 部署到 GitHub Pages（一次性設定）

1. 進入 GitHub repo → **Settings** → **Pages**。
2. 在 **Build and deployment** → **Source** 選擇 **GitHub Actions**。
3. 到 **Actions** 分頁，手動執行一次「更新資料並部署到 GitHub Pages」工作流程
   （或推送一次 commit 觸發）。
4. 完成後網址為：`https://<你的帳號>.github.io/<repo 名稱>/`

之後 workflow 會在以下時機自動執行（跑爬蟲抓 Gimy 最新影劇 → 組裝靜態網站 → 部署）：

- 每次 **push**
- 每 **6 小時**排程
- 在 Actions 分頁**手動觸發**

> 若某次爬蟲失敗（例如 Gimy 換網域或被 Cloudflare 擋），會**沿用上一份成功的資料**，
> 網頁不會空白。

## 本機開發 / 測試

```bash
# 1. 手動跑一次爬蟲（會更新 data/videos.json）
node scraper/scrape.mjs

# 2. 用任意靜態伺服器預覽
python3 -m http.server 8099
# 開啟 http://127.0.0.1:8099
```

### 爬蟲環境變數（可選）

| 變數 | 說明 | 預設 |
|------|------|------|
| `GIMY_HOSTS` | 以逗號分隔的候選網域清單 | 內建多個 Gimy 鏡像 |
| `GIMY_PAGES` | 每個分類抓取的頁數 | `6` |
| `GIMY_MAX` | 資料總筆數上限 | `1200` |

例如 Gimy 換了新網域，只要設定 `GIMY_HOSTS=https://新網域` 即可，無需改程式碼。

## 運作原理

- **資料來源**：Gimy 採用蘋果 CMS（maccms），提供 `/api.php/provide/vod/?ac=detail`
  JSON 採集介面。爬蟲會自動探測可用的鏡像網域與介面路徑。
- **集數判斷**：從 `vod_play_url` 解析出播放片段數量作為集數，搭配 `vod_remarks`
  （如「更新至 20 集」）與 `vod_time`（更新時間）。
- **新集數偵測**：加入最愛時記錄當下的集數 / 更新時間快照；之後資料更新若集數變多
  或更新時間變新，即判定為「有新集數」，於首頁橫幅標示並（在你授權後）發出瀏覽器通知。
  點擊「觀看 / 詳情」或「全部標示已讀」即可清除標記。
- **無後端**：純靜態網站，最愛與通知狀態都存在你的瀏覽器，不需要伺服器或資料庫。

## 注意事項

- Cloudflare 等防護可能在某些情況下擋下 GitHub Actions 機房 IP 的請求。
  若長期抓不到資料，可在 `GIMY_HOSTS` 補上目前可用的鏡像，或改用自架 runner。
- 本工具僅供學習與個人追劇整理用途；請尊重各內容的著作權並遵守當地法律。
