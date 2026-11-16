# 議事録アプリ

録音 → 文字起こし → 議事録づくり → Notionに保存、までを行うWebアプリです。
音声はこの端末（ブラウザ内）に保存し、Notionには議事録のテキストだけを送ります。

- 文字起こし：OpenAI（gpt-4o-transcribe）または Gemini
- 議事録づくり：Claude または Gemini
- 録音は5分ごとに自動で区切ります（OpenAIの上限 25MB・25分にかからないように）

## ファイル構成

```
index.html                              アプリ本体（GitHub Pagesに置く）
supabase/functions/minutes/index.ts     AIとNotionを呼び出す関数（Supabaseに置く）
```

## セットアップ

### 1. Notionの準備
1. 議事録用のデータベースを作る（プロパティは「名前」(タイトル)と「日付」(日付)）
2. データベースの「…」→「接続」から、使っているインテグレーションを追加
3. データベースの data source ID を控える

### 2. Supabaseに関数を置く（既存プロジェクトに同居でOK）
```sh
supabase functions deploy minutes --no-verify-jwt
supabase secrets set \
  APP_PASSCODE=好きな合言葉 \
  OPENAI_API_KEY=sk-... \
  ANTHROPIC_API_KEY=sk-ant-... \
  GEMINI_API_KEY=... \
  NOTION_TOKEN=ntn_... \
  NOTION_DATA_SOURCE_ID=...
```
Geminiを使わない場合、GEMINI_API_KEY は無しでも動きます。

### 3. GitHub Pagesで公開
リポジトリに `index.html` を置いて Pages を有効にし、iPhoneのSafariで開いて「ホーム画面に追加」。

### 4. アプリの設定（右上の⚙︎）
- 関数URL：`https://<プロジェクトID>.supabase.co/functions/v1/minutes`
- パスコード：手順2で決めた合言葉
- 使うAIとモデル名、よく出る言葉（薬剤名など）、区切りの長さ

## 使い方のメモ
- 録音中は画面を開いたままにしてください（iPhoneは画面を閉じたり他のアプリに切り替えるとマイクが止まります）
- 途中でエラーになっても、もう一度ボタンを押すと終わっていない区切りから再開します
- ボイスメモなどの音声ファイル（24MBまで）も読み込めます
- 仕事の会議ではOpenAI＋Claudeがおすすめです。Geminiの無料枠は送った内容がGoogleの改善に使われることがあります
