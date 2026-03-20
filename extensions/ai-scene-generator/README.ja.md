# AI Scene Generator

自然言語の説明からAI（Anthropic Claude / OpenAI GPT）を使って交通シーンを自動生成するdrawtonomyエクステンション。

[English version](README.md)

---

## ユーザーガイド

### セットアップ

```bash
# ターミナル1: drawtonomy dev serverを起動
npm install -g @drawtonomy/dev-server
drawtonomy-dev-server

# ターミナル2: サンプルエクステンションを起動
cd extensions/ai-scene-generator
npm install
npm run dev
```

ブラウザで以下にアクセス:
```
http://localhost:3000/?ext=http://localhost:3001/manifest.json
```

### 使い方

1. **Provider選択** — Claude（Anthropic）または GPT（OpenAI）を選択
2. **Model選択** — 使用するモデルを選択
   - Claude: Opus 4（高性能）/ Sonnet 4（バランス）/ Haiku 4（高速・低コスト）
   - GPT: o3-mini（高性能）/ GPT-4o（バランス）/ GPT-4o mini（高速・低コスト）
3. **API Key入力** — 選択したProviderのAPIキーを入力
4. **Scene Description** — 生成したいシーンを説明
5. **Generate Scene** — クリックでシーンを生成。キャンバスにシェイプが描画される

### プロンプト例

```
A two-lane road with two cars and a pedestrian crossing
```
```
An intersection with four lanes, traffic lights, and a bus turning right
```
```
A parking lot with 5 cars and a pedestrian walking
```

### 注意事項

- APIキーはブラウザのlocalStorageに保存される（sandboxed iframeでは保存されない）
- 既存のキャンバスにシェイプがある場合、コンテキストとしてAIに渡される
- 生成されたシェイプはCtrl+Z / Cmd+Zで取り消し可能
