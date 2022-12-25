/**********************************************************************
 * Copyright (c) 2022 Red Hat, Inc.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 ***********************************************************************/

/* eslint-disable header/header */

import * as fs from 'fs-extra';
import * as jsYaml from 'js-yaml';
import * as WS from 'ws';

/** Client for the machine-exec server. */
export class MachineExecClient {

	/** WebSocket connection to the machine-exec server. */
	private connection: WS;

	private initPromise: Promise<void>;

	private LIST_CONTAINERS_MESSAGE_ID = -5;

	private onExecExitFunc: () => void = () => {};

	constructor() {
		let resolveInit: () => void;
		let rejectInit: (reason: any) => void;

		this.connection = new WS('ws://localhost:3333/connect')
			.on('message', async (data: WS.Data) => {
			    // TODO: ロギングフレームワーク導入
                // console.log(`[WebSocket] <<< ${data.toString()}`);

				const message = JSON.parse(data.toString());
				if (message.method === 'connected') {
					// the machine-exec server responds `connected` once it's ready to serve the clients
					resolveInit();
				} else if (message.method === 'onExecExit') {
					this.onExecExitFunc();
					// TODO: ロギングフレームワーク導入
                    // console.log("onExecExit");
				} else if (message.method === 'onExecError') {
					// TODO: エラーハンドリングをまじめにやる
                    console.log("onExecError");
				}
			})
			.on('error', (err: Error) => {
				// TODO: ロギングフレームワーク導入
                // console.log(`[WebSocket] error: ${err.message}`);

				rejectInit(err.message);
			});

		this.initPromise = new Promise<void>((resolve, reject) => {
			resolveInit = resolve;
			rejectInit = reject;
		});
	}

	/**
	 * Resolves once the machine-exec server is ready to serve the clients.
	 * Rejects if an error occurred while establishing the WebSocket connection to machine-exec server.
	 */
	init(): Promise<void> {
		return this.initPromise;
	}

	dispose() {
		this.connection.terminate();
	}

	/**
	 * Asks the machine-exec server to list all running DevWorkspace containers.
	 *
	 * @returns containers names
	 */
	async getContainers(): Promise<string[]> {
		const jsonCommand = {
			jsonrpc: '2.0',
			method: 'listContainers',
			params: [],
			id: this.LIST_CONTAINERS_MESSAGE_ID,
		};

		const command = JSON.stringify(jsonCommand);
		// TODO: ロギングフレームワーク導入
		// console.log(`[WebSocket] >>> ${command}`);
        this.connection.send(command);

		return new Promise(resolve => {
			this.connection.once('message', (data: WS.Data) => {
				const message = JSON.parse(data.toString());
				if (message.id === this.LIST_CONTAINERS_MESSAGE_ID) {
					const remoteContainers: string[] = message.result.map((containerInfo: any) => containerInfo.container);
					resolve(remoteContainers);
				}
			});
		});
	}

	/** Returns the list of the containers the user might be interested in opening a terminal to. */
	async getContributedContainers(): Promise<string[]> {
		const originalDevFileContent = fs.readFileSync('/devworkspace-metadata/original.devworkspace.yaml', 'utf8');
		const devfile = jsYaml.load(originalDevFileContent) as any;

		const devfileComponents = devfile.components || [];
		const devfileContainersNames = devfileComponents
			// we're only interested in those components that describe the contributed containers
			// so, filter out all others, e.g. volume, plugin, etc.
			.filter((component: any) => component.container)
			.map((component: any) => component.name);

		// ask machine-exec to get all running containers and
		// filter out those not declared in the devfile, e.g. che-gateway, etc.
		const runningContainers = [... await this.getContainers()];
		const runningDevfileContainers = runningContainers.filter(containerName => devfileContainersNames.includes(containerName));
		return runningDevfileContainers;
	}

	/**
	 * Asks the machine-exec server to start a new terminal session to the specified container.
	 *
	 * @param component name of the DevWorkspace component that represents a container to create a terminal session to
	 * @param commandLine optional command line to execute when starting a terminal session. If empty, machine-exec will start a default shell.
	 * @param workdir optional working directory
	 * @param columns the initial width of the new terminal
	 * @param rows the initial height of the new terminal
	 * @returns a TerminalSession object to manage the created terminal session
	 */
	async createTerminalSession(component: string, commandLine?: string, workdir?: string, columns: number = 80, rows: number = 24): Promise<TerminalSession> {
		const createTerminalSessionCall = {
			identifier: {
				machineName: component
			},
			cmd: commandLine ? ['sh', '-c', commandLine] : [],
			tty: true,
			cwd: workdir || '',
			cols: columns,
			rows: rows
		};

		const jsonCommand = {
			jsonrpc: '2.0',
			method: 'create',
			params: createTerminalSessionCall,
			id: 0
		};

		const command = JSON.stringify(jsonCommand);

        // TODO: ロギングフレーム導入
		// console.log(`[WebSocket] >>> ${command}`);
		this.connection.send(command);

		return new Promise(resolve => {
			this.connection.once('message', (data: WS.Data) => {
				const message = JSON.parse(data.toString());
				const sessionID = message.result;
				if (Number.isFinite(sessionID)) {
					resolve(new TerminalSession(this, sessionID));
				}
			});
		});
	}

	/**
	 * Asks the machine-exec server to resize the specified terminal.
	 *
	 * @param sessionID
	 * @param columns new width
	 * @param rows new height
	 */
	async resize(sessionID: number, columns: number, rows: number): Promise<void> {
		const resizeTerminalCall = {
			id: sessionID,
			cols: columns,
			rows
		};

		const jsonCommand = {
			jsonrpc: '2.0',
			method: 'resize',
			params: resizeTerminalCall,
			id: 0
		};

		const command = JSON.stringify(jsonCommand);

		// TODO: ロギングフレーム導入
		// console.log(`[WebSocket] >>> ${command}`);
		this.connection.send(command);
	}

	onExit(onExecExitFunc: () => void): void {
		this.onExecExitFunc = onExecExitFunc;
	}
}


/** Allows managing a remote terminal session. */
export class TerminalSession {
	/** This terminal session's ID that's assigned by the machine-exec server. */
	id: number;

	/** The WebSocket connection to the actual terminal. */
	private connection: WS;

	private onOpenFunc: () => void = () => {};

	/**
	 * Attaches to an existing terminal session with the given ID.
	 *
	 * @param machineExecClient client to communicate with the machine-exec server
	 * @param id the terminal session ID assigned by the machine-exec server
	 */
	constructor(private machineExecClient: MachineExecClient, id: number) {
		this.id = id;

		this.connection = new WS(`ws://localhost:3333/attach/${id}`);
		this.connection.on('message', (data: WS.Data) => {
			process.stdout.write((data as any));
		});

		this.connection.on('open', () => {
			this.onOpenFunc();
		});

	}

	onOpen(onOpenFunc: () => void) {
		this.onOpenFunc = onOpenFunc;
    }

	send(data: string): void {
		this.connection.send(data);
	}

	resize(columns: number, rows: number): void {
		this.machineExecClient.resize(this.id, columns, rows);
	}
}