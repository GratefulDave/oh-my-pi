/**
 * File/resource reservations for local swarm coordination.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ReservationRecord {
	resource: string;
	holder: string;
	reason?: string;
	claimedAt: string;
}

export interface ClaimReservationResult {
	ok: boolean;
	reservation: ReservationRecord;
	conflict?: ReservationRecord;
}

export async function readReservations(swarmDir: string): Promise<Record<string, ReservationRecord>> {
	try {
		return JSON.parse(await Bun.file(reservationPath(swarmDir)).text()) as Record<string, ReservationRecord>;
	} catch {
		return {};
	}
}

export async function claimReservation(
	swarmDir: string,
	resource: string,
	holder: string,
	reason?: string,
): Promise<ClaimReservationResult> {
	const reservations = await readReservations(swarmDir);
	const existing = reservations[resource];
	const next: ReservationRecord = {
		resource,
		holder,
		reason,
		claimedAt: existing?.holder === holder ? existing.claimedAt : new Date().toISOString(),
	};
	if (existing && existing.holder !== holder) {
		return { ok: false, reservation: existing, conflict: existing };
	}
	reservations[resource] = next;
	await writeReservations(swarmDir, reservations);
	return { ok: true, reservation: next };
}

export async function releaseReservation(swarmDir: string, resource: string): Promise<ReservationRecord | undefined> {
	const reservations = await readReservations(swarmDir);
	const existing = reservations[resource];
	if (!existing) return undefined;
	delete reservations[resource];
	await writeReservations(swarmDir, reservations);
	return existing;
}

export function renderReservations(reservations: Record<string, ReservationRecord>): string[] {
	const records = Object.values(reservations);
	if (records.length === 0) return ["No reservations."];
	return records.map(record => {
		const reason = record.reason ? ` — ${record.reason}` : "";
		return `${record.resource}: ${record.holder} since ${record.claimedAt}${reason}`;
	});
}

async function writeReservations(swarmDir: string, reservations: Record<string, ReservationRecord>): Promise<void> {
	await fs.mkdir(swarmDir, { recursive: true });
	const target = reservationPath(swarmDir);
	const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
	await Bun.write(tmp, JSON.stringify(reservations, null, 2));
	await fs.rename(tmp, target);
}

function reservationPath(swarmDir: string): string {
	return path.join(swarmDir, "reservations.json");
}
