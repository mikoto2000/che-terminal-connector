const keypress = require('keypress');
const WebSocket = require('ws');
const util = require('util');
const Client = require('node-rest-client').Client;
const prompts = require("prompts");

// 定数群
const CHE_URL = "https://che.openshift.io"; // TODO: 可変化
const CHE_WORKSPACE_INFO_URL_FORMAT = CHE_URL + "/api/workspace/%s?token=%s";
const CHE_WORKSPACE_ID = process.env.CHE_WORKSPACE_ID;
const CHE_MACHINE_TOKEN = process.env.CHE_MACHINE_TOKEN;
const WORKSPACE_INFO_URL = util.format(CHE_WORKSPACE_INFO_URL_FORMAT, CHE_WORKSPACE_ID, CHE_MACHINE_TOKEN);

// ワークスペース情報取得のための REST クライアント
const client = new Client();

// ワークスペース情報取得要求
client.get(WORKSPACE_INFO_URL, function (data) {

    // ワークスペース情報からターミナル接続に必要な情報を抜き出す
    const machines = data.runtime.machines;
    const machineKeys = Object.keys(machines);
    const machineKeysIndex = machineKeys.findIndex(e => e.startsWith("che-machine-exec"));
    const cheMachineExecUrl = machines[machineKeys[machineKeysIndex]].servers["che-machine-exec"].url;

    (async function () {
        // ワークスペースに紐づいているサイドカーコンテナから、ターミナルを開きたいものをひとつ選択してもらう
        // TODO: 「引数でコンテナ名渡して起動する」もできるようにしたい
        const machineName = await choiceMachineName(machineKeys);

        // サイドカーコンテナ接続要求に必要な情報群
        const machineExecConnectUrl = cheMachineExecUrl + '/connect?token=' + CHE_MACHINE_TOKEN;
        const machineExecId = 0;
        const machineExecRequest = {
            jsonrpc: "2.0",
            id: machineExecId,
            method: "create",
            params: {
                identifier: {
                    machineName: machineName,
                    workspaceId: CHE_WORKSPACE_ID
                },
                cmd: [],
                cols: 80,
                rows: 24,
                tty: true
            }
        }

        // サイドカーコンテナ接続要求のための WebSocket
        const wsMachineExecConnect = new WebSocket(machineExecConnectUrl);

        // サイドカーコンテナ接続要求
        wsMachineExecConnect.on('open', function open() {
            wsMachineExecConnect.send(JSON.stringify(machineExecRequest));
        });

        // che-machine-exec へ送信した
        // サイドカーコンテナ接続要求からの応答処理
        wsMachineExecConnect.on('message', function incoming(data) {

            // 応答確認
            // 接続に成功したら `{"jsonrpc":"2.0","id":0,"result":31}` のような応答が返ってくる。
            const json = JSON.parse(data);
            if (json.result) {

                // che-machine-exec から通知されたターミナルのコネクション ID
                const terminalId = json.result;

                // ターミナル接続のための URL
                const wsForTerminalUrl = cheMachineExecUrl + "/attach/" + terminalId + "?token=" + CHE_MACHINE_TOKEN;

                // ターミナルとして利用する WebSocket
                const wsForTerminal = new WebSocket(wsForTerminalUrl);

                // ターミナルオープン処理
                wsForTerminal.on('open', function open() {
                    // ターミナルクローズフラグ
                    let isClose = false;

                    // キープレスイベントフック開始
                    keypress(process.stdin);

                    // キープレスイベント
                    process.stdin.on('keypress', function (ch, key) {
                        // ctrl+c でプロセス終了
                        if (key && key.ctrl && key.name == 'c') {

                            // Ctrl-C 2 連続で che-terminal-connector 自体を終了
                            if (isClose) {
                                console.log();
                                console.log("Sidecar container exited.");
                                process.exit(1);
                            } else {
                                isClose = true;
                            }
                        } else {
                            isClose = false;
                        }

                        // プレスしたキーをサイドカーコンテナに送信
                        if (ch) {
                            wsForTerminal.send(ch);
                        } else {
                            wsForTerminal.send(key.sequence);
                        }
                    });

                    // おまじないたち。
                    // サンプルからそのままコピペした。
                    process.stdin.setRawMode(true);
                    process.stdin.resume();
                });

                // サイドカーコンテナ切断時の処理
                wsForTerminal.on('close', function close() {
                    process.exit(1);
                });

                // ターミナルメッセージの受信処理
                wsForTerminal.on('message', function incoming(data) {
                    process.stdout.write(data);
                });
            }
        });
    }())
});

/**
 * machineName のリストから一つを選択させるプロンプトを表示し、選択結果を返却する。
 * 
 * @param machineNames マシン名のリスト
 * @return プロンプトで選択したマシン名
 */
async function choiceMachineName(machineNames) {
    const choicePrompt = {
        type: "select",
        name: "machines",
        message: "select machine.",
        choices: machineNames
    };

    const promptResponse = await prompts(choicePrompt);
    return machineNames[promptResponse.machines]
}
