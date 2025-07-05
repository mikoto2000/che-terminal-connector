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
import { URL } from 'url';

/** Client for the machine-exec server. */
export class MachineExecClient {

	private cheHost: string;
	private workspaceId: string;
	private baseWsUrl: string;
	private machineToken: string;

	constructor() {
		const cheDashboardUrl = process.env.CHE_DASHBOARD_URL;
		if (!cheDashboardUrl) {
			throw new Error('CHE_DASHBOARD_URL environment variable not set');
		}
		this.cheHost = new URL(cheDashboardUrl).host;

		const workspaceId = process.env.DEVWORKSPACE_ID;
		if (!workspaceId) {
			throw new Error('DEVWORKSPACE_ID environment variable not set');
		}
		this.workspaceId = workspaceId;

		try {
			this.machineToken = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8');
			if (!this.machineToken) {
				throw new Error('Service account token file is empty.');
			}
		} catch (error) {
			throw new Error(`Failed to read service account token: ${error.message}`);
		}

		this.baseWsUrl = `wss://${this.cheHost}/api/dev-workspace/v2/exec/${this.workspaceId}`;
	}

	/**
	 * Resolves once the machine-exec server is ready to serve the clients.
	 * Rejects if an error occurred while establishing the WebSocket connection to machine-exec server.
	 */
	async init(): Promise<void> {
		// No-op in the new implementation, but kept for API compatibility
		return Promise.resolve();
	}

	dispose() {
		// No-op
	}

	/** Returns the list of the containers the user might be interested in opening a terminal to. */
	async getContributedContainers(): Promise<string[]> {
		const devfilePath = process.env.DEVWORKSPACE_ORIGINAL_DEVFILE || '/devworkspace-metadata/original.devworkspace.yaml';
		const originalDevFileContent = fs.readFileSync(devfilePath, 'utf8');
		const devfile = jsYaml.load(originalDevFileContent) as any;

		const devfileComponents = devfile.components || [];
		const devfileContainersNames = devfileComponents
			// we're only interested in those components that describe the contributed containers
			// so, filter out all others, e.g. volume, plugin, etc.
			.filter((component: any) => component.container)
			.map((component: any) => component.name);

		return devfileContainersNames;
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
		const wsUrl = `${this.baseWsUrl}/${component}`;
		const options: WS.ClientOptions = {
			headers: {
				'Authorization': `Bearer ${this.machineToken}`
			}
		};
		const connection = new WS(wsUrl, options);

		return new Promise((resolve, reject) => {
			connection.on('open', () => {
				const createTerminalSessionCall = {
					command: commandLine ? ['sh', '-c', commandLine] : [],
					tty: true,
					cwd: workdir || '',
					cols: columns,
					rows: rows,
				};

				const jsonCommand = {
					jsonrpc: '2.0',
					method: 'exec',
					params: createTerminalSessionCall,
					id: 1 // Use a specific ID for the exec call
				};
				connection.send(JSON.stringify(jsonCommand));
			});

			connection.once('message', (data: WS.Data) => {
				const message = JSON.parse(data.toString());
				// The first message should be the confirmation of the exec
				// In the new API, there isn't a separate session ID. The WebSocket connection itself is the session.
				// We can resolve with a new TerminalSession that encapsulates this connection.
				if (message.id === 1 && message.result === null) { // Assuming successful exec returns null result
					resolve(new TerminalSession(this, connection, wsUrl));
				} else if (message.error) {
					reject(new Error(`Failed to create terminal session: ${message.error.message}`));
				}
			});

			connection.on('error', (err: Error) => {
				reject(err);
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
	async resize(connection: WS, columns: number, rows: number): Promise<void> {
		const resizeTerminalCall = {
			cols: columns,
			rows
		};

		const jsonCommand = {
			jsonrpc: '2.0',
			method: 'resize',
			params: resizeTerminalCall,
			id: 2 // Use a different ID for resize
		};
		connection.send(JSON.stringify(jsonCommand));
	}
}


/** Allows managing a remote terminal session. */
export class TerminalSession {
	/** The WebSocket connection to the actual terminal. */
	private connection: WS;

	private onOpenFunc: () => void = () => { };
	private onCloseFunc: () => void = () => { };

	/**
	 * Attaches to an existing terminal session with the given ID.
	 *
	 * @param machineExecClient client to communicate with the machine-exec server
	 * @param connection The WebSocket connection for this session
	 */
	constructor(private machineExecClient: MachineExecClient, connection: WS, public readonly wsUrl: string) {
		this.connection = connection;

		this.connection.on('message', (data: WS.Data) => {
			// Assuming the data is binary or a string to be written to stdout
			// The new API might wrap the output in a JSON-RPC message
			try {
				const message = JSON.parse(data.toString());
				if (message.method === 'stdout' && message.params) {
					process.stdout.write(message.params);
				}
			} catch (e) {
				// Not a JSON message, write directly
				process.stdout.write((data as any));
			}
		});

		// The 'open' event is handled in createTerminalSession,
		// but we call the user-provided onOpenFunc immediately since the connection is already open.
		// Use a timeout to allow the caller to set the onOpen handler.
		setTimeout(() => this.onOpenFunc(), 0);


		this.connection.on('close', () => {
			this.onCloseFunc();
		});
	}

	onOpen(onOpenFunc: () => void) {
		this.onOpenFunc = onOpenFunc;
	}

	onClose(onCloseFunc: () => void) {
		this.onCloseFunc = onCloseFunc;
	}

	send(data: string): void {
		const jsonCommand = {
			jsonrpc: '2.0',
			method: 'stdin',
			params: data,
			id: 3 // Use a different ID for stdin
		};
		this.connection.send(JSON.stringify(jsonCommand));
	}

	resize(columns: number, rows: number): void {
		this.machineExecClient.resize(this.connection, columns, rows);
	}
}