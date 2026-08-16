# 開発者ガイド

このドキュメントでは、Profile Extension Matrix のローカル開発、デバッグ、VSIX パッケージ作成を説明します。拡張機能の利用方法は、プロジェクトルートの [README.md](../README.md) を参照してください。

## 前提条件

- Node.js 20 以降
- npm
- VS Code Desktop 1.133 以降

## 開発環境のセットアップ

リポジトリのルートで依存関係をインストールし、TypeScript をコンパイルします。

```powershell
npm install
npm run compile
```

継続してコンパイルする場合は、次のコマンドを実行します。

```powershell
npm run watch
```

## デバッグ

1. このフォルダーを VS Code で開きます。
2. `F5` を押して **Extension Development Host** を起動します。
3. 起動したウィンドウの Activity Bar で **Profile Extensions** を開きます。
4. 実装を変更した場合は、Extension Development Host を再読み込みして動作を確認します。

## VSIX パッケージの作成

パッケージ作成前に、コンパイル済みの `out/extension.js` が最新であることを確認します。

```powershell
npm run compile
npx vsce package --allow-missing-repository --skip-license
```

コマンド完了後、プロジェクトルートに `profile-extension-matrix-<version>.vsix` が生成されます。`<version>` は `package.json` の `version` に対応します。

`.vscodeignore` には VSIX から除外する開発用ファイルを定義します。新しい実行時ファイルやメディアを追加した場合は、パッケージ内容を確認してください。

## Marketplace への公開

公開には、Visual Studio Marketplace のパブリッシャーと発行用トークンが必要です。`package.json` の `publisher` と Marketplace のパブリッシャー ID が一致していることを確認します。

```powershell
npx vsce login soranoana
npx vsce publish
```

公開前には、バージョンを更新してからコンパイルと VSIX 作成を行います。

```powershell
npm version patch
npm run compile
npx vsce package --allow-missing-repository --skip-license
```

発行トークンはターミナルの入力プロンプトでのみ入力し、ソースコード、設定ファイル、シェル履歴に保存しないでください。