import * as stream from "node:stream";
import { AgentSideConnection, ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import type { AgentSession } from "../../session/agent-session";
import { AcpAgent } from "./acp-agent";

export type AcpSessionFactory = (cwd: string) => Promise<AgentSession>;

export function createAcpConnection(
	transport: Stream,
	createSession: AcpSessionFactory,
	initialSession?: AgentSession,
): AgentSideConnection {
	return new AgentSideConnection(conn => new AcpAgent(conn, createSession, initialSession), transport);
}

export async function runAcpMode(createSession: AcpSessionFactory, initialSession?: AgentSession): Promise<never> {
	const input = stream.Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>;
	const output = stream.Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
	const transport = ndJsonStream(input, output);
	const connection = createAcpConnection(transport, createSession, initialSession);
	await connection.closed;
	process.exit(0);
}
