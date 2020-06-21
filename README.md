# che-terminal-connector

Eclipse Che のサイドカーコンテナを利用するためのターミナル接続アプリ。

## 前提

### 環境変数

Eclipse Che のサイドカーコンテナには以下環境変数が定義されているのでそれを使用する。

- `CHE_WORKSPACE_ID`
- `CHE_MACHINE_TOKEN`


### 必須アプリケーション

- `jq`
- `websocat`

## che-terminal-connector の使用方法

### Workspace 情報取得

```
WORKSPACE_INFO=$(curl -L https://che.openshift.io/api/workspace/$CHE_WORKSPACE_ID?token=$CHE_MACHINE_TOKEN)
```

### `che-machine-exec` の URL 取得

```sh
CHE_MACHINE_EXEC_URL=$(echo $WORKSPACE_INFO | jq -r '.["runtime"]["machines"][]["servers"]["che-machine-exec"]["url"]|select(.!=null)')
```

### ワークスペース情報取得

```sh
$ echo $WORKSPACE_INFO | ./jq -r '.["runtime"]["machines"][]["servers"] | select(. != null) | keys | .[]'
theia
theia-dev
theia-redirect-1
theia-redirect-2
theia-redirect-3
webviews
che-machine-exec
nodejs
```

この中から起動したいサービスを選ぶ。(今回は `nodejs`)


### サイドカーコンテナへ接続

#### `che-machine-exec` で `MACHINE_NAME` へのコネクションを作成

```sh
MACHINE_EXEC_CONNECT_URL=$CHE_MACHINE_EXEC_URL/connect?token=$CHE_MACHINE_TOKEN

MACHINE_EXEC_ID=0
MACHINE_NAME="nodejs"
MACHINE_EXEC_REQUEST="{\"jsonrpc\":\"2.0\",\"id\":$MACHINE_EXEC_ID,\"method\":\"create\",\"params\":{\"identifier\":{\"machineName\":\"$MACHINE_NAME\",\"workspaceId\":\"$CHE_WORKSPACE_ID\"},\"cmd\":[],\"cols\":80,\"rows\":24,\"tty\":true}}"

MACHINE_EXEC_RESPONSE=$(echo $MACHINE_EXEC_REQUEST | ./websocat --text --max-messages 2 -n "$MACHINE_EXEC_CONNECT_URL" -)
TERMINAL_ID=$(echo $MACHINE_EXEC_RESPONSE | ./jq -r '.["result"] | select(. != null)')
```


#### `che-terminal-connector` で生成したコネクションへ接続

```sh
che-terminal-connector "$CHE_MACHINE_EXEC_URL/attach/$TERMINAL_ID?token=$CHE_MACHINE_TOKEN"
```
