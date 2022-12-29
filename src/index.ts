import { MachineExecClient, TerminalSession } from './machine-exec-client';

import { PromptObject, Choice } from 'prompts';

import prompts = require('prompts');
const keypress = require('keypress');

async function main() {
    const machineExecClient = new MachineExecClient();
    await machineExecClient.init();

    const containers: string[] = await machineExecClient.getContributedContainers();

    // console.log(containers);

    const choicedContainerName: string = await choiceContainer(containers);

    // console.log(choiicedContainerName);

    const terminal: TerminalSession = await machineExecClient.createTerminalSession(
        choicedContainerName,
        undefined,
        undefined,
        process.stdout.columns,
        process.stdout.rows);

    terminal.onClose(() => {
        process.exit(0);
    });
    
    // console.log(`terminal.id: ${terminal.id}`);


    terminal.onOpen(() => {
        console.log(`${choicedContainerName} terminal(id: ${terminal.id}) opened.`);

        process.stdout.on('resize', function () {
            // console.log(`terminal size: { cols: ${process.stdout.columns}, rows: ${process.stdout.rows} }`);

            terminal.resize(process.stdout.columns, process.stdout.rows);
        });

        // キープレスイベントフック開始
        keypress(process.stdin);

        // キープレスイベント
        process.stdin.on('keypress', function (ch, key) {

            // プレスしたキーをサイドカーコンテナに送信
            if (ch) {
                terminal.send(ch);
            } else {
                terminal.send(key.sequence);
            }
        });

        // おまじないたち。
        // サンプルからそのままコピペした。
        process.stdin.setRawMode(true);
        process.stdin.resume();
    });
}

async function choiceContainer(containers: string[]): Promise<string> {

    const choices: Choice[] = containers.map((container) => ({
        title: container
    }));

    const choicePrompt: PromptObject = {
        type: "select",
        name: "container",
        message: "select machine.",
        choices: choices
    };

    const promptResponse = await prompts(choicePrompt);

    return containers[promptResponse.container];
}

main();