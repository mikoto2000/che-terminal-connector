# che-terminal-connector

Eclipse Che のサイドカーコンテナを利用するためのターミナル接続アプリ。

## 前提

Eclipse Che のサイドカーコンテナ内で実行すること。

## che-terminal-connector の使用方法

```sh
che-terminal-connector
```

1. サイドカーコンテナ選択プロンプトが表示されるので、ターミナルを利用したいサイドカーコンテナを選択する
2. 選択したサイドカーコンテナのターミナルが開く

## ビルド

```sh
npm install
./node_modules/.bin/tsc
```

