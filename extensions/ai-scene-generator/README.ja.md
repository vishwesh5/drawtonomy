# AI Scene Generator

自然言語の説明、OpenSCENARIO XML、またはDSL入力からAI（Anthropic Claude / OpenAI GPT / Google Gemini）を使って編集可能な交通シーンを自動生成するdrawtonomyエクステンション。

[English version](README.md)

## デモ

### 自然言語

> *プロンプト: "A 3-lane highway going left-to-right. An ego sedan (blue) in the center lane, a truck (grey) in the right lane slightly ahead. Show a dashed path for the ego vehicle changing to the left lane."*

<video src="https://github.com/user-attachments/assets/16cb1980-c912-44f0-a606-de2b50d46287" width="80%" controls></video>

### OpenSCENARIO

[ASAM OpenSCENARIO DSL - Euro NCAPシナリオ例](https://publications.pages.asam.net/standards/ASAM_OpenSCENARIO/ASAM_OpenSCENARIO_DSL/latest/annexes/examples.html#_euro_ncap) から生成:

<video src="https://github.com/user-attachments/assets/ffcf0cff-11bf-406c-a3cb-9af49994015e" width="80%" controls></video>

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

1. **Provider選択** — Claude（Anthropic）、GPT（OpenAI）、またはGemini（Google）を選択
2. **Model選択** — 使用するモデルを選択
   - Claude: Opus 4（高性能）/ Sonnet 4（バランス）/ Haiku 4（高速・低コスト）
   - GPT: o3-mini（高性能）/ GPT-4o（バランス）/ GPT-4o mini（高速・低コスト）
   - Gemini: 2.5 Pro（高性能）/ 2.5 Flash（バランス）/ 2.0 Flash（高速・低コスト）
3. **API Key入力** — 選択したProviderのAPIキーを入力
4. **Input Mode選択** — 入力モードを選択:
   - **Natural Language** — 自然言語でシーンを説明
   - **OpenSCENARIO** — OpenSCENARIO XMLまたはDSLコードを貼り付け
   - **Text → OSC** — 自然言語から自動的にOpenSCENARIO DSLに変換
5. **プロンプト/コード入力** — シーンの説明またはOpenSCENARIOコードを入力
6. **Generate Scene** — クリックでシーンを生成。キャンバスにシェイプが描画される

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
