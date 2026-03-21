# @drawtonomy/mcp-server

drawtonomy交通シーン図のレンダリング用MCP（Model Context Protocol）サーバー。ClaudeなどのLLMがチャット内で直接交通シーン画像を生成できるようにします。

## できること

- **交通シーン画像の生成** — JSON形式のシーン仕様から画像をレンダリング
- **Webエディタで開く** — シーンをdrawtonomy Webエディタで開くURLを生成

MCP対応の全クライアントで利用可能: Claude Desktop, Claude Code, Cursor, VS Code等

## 利用可能なツール

### `generate_scene`

JSON形式のシーン仕様から交通シーンをレンダリングします。LLMが自然言語からJSONを自動生成するため、ユーザーはシーンをテキストで説明するだけでOKです。

**入力**: レーン、車両、歩行者、アノテーション、パスを含むシーン仕様JSON
**出力**: SVGまたはPNG画像

**対応要素**:

| 要素 | 説明 |
|------|------|
| レーン | 左右の境界線を持つ走行レーン。サブタイプ: `road`, `sidewalk` |
| 車両 | SVGテンプレート付きの車両 |
| 歩行者 | SVGテンプレート付きの歩行者 |
| パス | 破線パターンと矢印オプション付きのポリライン |
| アノテーション | 色・フォントサイズ指定可能なテキストラベル |

**車両テンプレート**:

| テンプレート | サイズ (w×h) |
|------------|-----------|
| sedan | 30×56 |
| bus | 37×92 |
| truck | 43×147 |
| motorcycle | 18×36 |
| bicycle | 18×36 |

**歩行者テンプレート**:

| テンプレート | サイズ (w×h) |
|------------|-----------|
| filled | 22×22 |

未対応の車両テンプレートIDはsedanに、歩行者テンプレートIDはfilledにフォールバックします。

**色の規約**: ego = 青 (#2563EB), threat = 赤 (#EF4444), caution = #F59E0B, neutral = 黒/グレー, planned paths = 緑

### `open_in_editor`

シーンを[drawtonomy Webエディタ](https://www.drawtonomy.com)で開くためのURLを生成します。

## セットアップ

### インストール

```bash
npm install @drawtonomy/mcp-server
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`（macOS）または `%APPDATA%\Claude\claude_desktop_config.json`（Windows）に以下を追加：

```json
{
  "mcpServers": {
    "drawtonomy": {
      "command": "npx",
      "args": ["@drawtonomy/mcp-server"]
    }
  }
}
```

設定後、Claude Desktopを再起動してください。

### Claude Code

```bash
claude mcp add drawtonomy npx @drawtonomy/mcp-server
```

### ローカル開発

```bash
git clone https://github.com/kosuke55/drawtonomy.git
cd drawtonomy/packages/mcp-server
npm install
npm run build
```

ローカルパスで設定：

```json
{
  "mcpServers": {
    "drawtonomy": {
      "command": "node",
      "args": ["/path/to/drawtonomy/packages/mcp-server/dist/index.js"]
    }
  }
}
```

## 使い方

設定後、Claudeに自然言語で話しかけるだけです：

- 「2車線の道路に青いセダンと歩行者を描いて」
- 「AEBシナリオで、自車両と子供の歩行者を表示して」
- 「T字路に3台の車を配置して」
- 「このシーンをdrawtonomyエディタで開いて」

Claudeが自動的に`generate_scene`ツールを呼び出し、レンダリングされた画像をチャットに表示します。

## MCP Inspectorでのテスト

LLMを介さず直接ツールをテストする場合：

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

`generate_scene`を選択し、シーンJSONを手入力して実行してください。

## シーンJSONフォーマット

```json
{
  "lanes": [
    {
      "leftPoints": [{"x": 50, "y": 350}, {"x": 1150, "y": 350}],
      "rightPoints": [{"x": 50, "y": 430}, {"x": 1150, "y": 430}],
      "attributes": {"subtype": "road", "speed_limit": "50"}
    }
  ],
  "vehicles": [
    {"x": 400, "y": 390, "rotation": 90, "templateId": "sedan", "color": "blue"}
  ],
  "pedestrians": [
    {"x": 900, "y": 350, "templateId": "filled", "color": "red"}
  ],
  "annotations": [
    {"x": 850, "y": 320, "text": "Danger Zone", "color": "red", "fontSize": 14}
  ],
  "paths": [
    {"points": [{"x": 400, "y": 390}, {"x": 600, "y": 350}], "color": "green", "dashed": true, "arrowHead": true}
  ]
}
```

**キャンバス**: 1200x800、原点左上、X→右、Y→下
**回転**: 度数（0=上、90=右、180=下、270=左）
