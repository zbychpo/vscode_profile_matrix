# Profile Extension Matrix

ローカルの VS Code プロファイルごとに、有効な拡張機能をマトリクス表示するデスクトップ用拡張機能です。

## 使い方

1. `npm install` を実行します。
2. `npm run compile` を実行します。
3. VS Code で `F5` を押し、Extension Development Host を起動します。
4. Activity Bar の **Profile Extensions** を開きます。

セルの `+` は追加、チェックマークは削除です。変更は確認ダイアログの後に `code --profile` CLI で実行します。

## 制約

- VS Code Desktop のローカルプロファイルが対象です。Web 版、リモートの拡張機能は対象外です。
- プロファイルの一覧と拡張の読み取りには VS Code のローカル保存データを利用します。VS Code の公開 API にプロファイル横断管理 API はありません。
- 既定プロファイルと一時プロファイルは初版では対象外です。