#!/usr/bin/env node
const keypress = require('keypress');
const WebSocket = require('ws');
const prompts = require("prompts");
import WorkspaceClient, { IRestAPIConfig } from '@eclipse-che/workspace-client';
import { che } from '@eclipse-che/api';

// ワークスペース情報取得のための REST クライアント
const restAPIConfig: IRestAPIConfig = {};
restAPIConfig.baseUrl = process.env.CHE_API;

const CHE_MACHINE_TOKEN = process.env.CHE_MACHINE_TOKEN;
if (CHE_MACHINE_TOKEN) {
    restAPIConfig.headers = {};
    restAPIConfig.headers['Authorization'] = 'Bearer ' + CHE_MACHINE_TOKEN;
}
const restApiClient = WorkspaceClient.getRestApi(restAPIConfig);

const CHE_WORKSPACE_ID:string = process.env.CHE_WORKSPACE_ID || ""
// ワークスペース情報取得要求
const promise:Promise<che.workspace.Workspace> = restApiClient.getById<che.workspace.Workspace>(CHE_WORKSPACE_ID);


promise.then((data:che.workspace.Workspace) => {

    // ワークスペース情報からターミナル接続に必要な情報を抜き出す
    const runtime:che.workspace.Runtime|undefined = data.runtime;
    const machines:{[key:string]:che.workspace.Machine}|undefined = runtime?.machines;
    const machineKeys:string[] = Object.keys(machines || {});
    const machineKeysIndex:number = machineKeys.findIndex(e => e.startsWith("che-machine-exec"));

    // TODO: 例外
    if (!machines) {return}
    const servers:{[key:string]:che.workspace.Server}|undefined = machines[machineKeys[machineKeysIndex]].servers;

    // TODO: 例外
    if (!servers) {return}
    let server = servers["che-machine-exec"] ?? servers["terminal"];
    const cheMachineExecUrl:string|undefined = server.url;

    (async function() {
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
        wsMachineExecConnect.on('message', function incoming(data:string) {

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
                wsForTerminal.on('message', function incoming(data:string) {
                    process.stdout.write(data);
                });
            }
        });
    })();
});

/**
 * machineName のリストから一つを選択させるプロンプトを表示し、選択結果を返却する。
 * 
 * @param machineNames マシン名のリスト
 * @return プロンプトで選択したマシン名
 */
async function choiceMachineName(machineNames:string[]) {
    const choicePrompt = {
        type: "select",
        name: "machines",
        message: "select machine.",
        choices: machineNames
    };

    const promptResponse = await prompts(choicePrompt);
    return machineNames[promptResponse.machines];
}