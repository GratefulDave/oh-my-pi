import { Database } from "bun:sqlite";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as zlib from "node:zlib";
import { dataDir as configuredDataDir, dbPath as configuredDbPath, type Env } from "../config";
import { closeQuietly, openDatabase } from "../db";

type SerializableDatabase = Database & { serialize(): Uint8Array };
const SQLITE_HEADER = new Uint8Array([83, 81, 76, 105, 116, 101, 32, 102, 111, 114, 109, 97, 116, 32, 51, 0]);
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
let uniqueCounter = 0;

export interface RecoveryPaths {
	readonly dataDir: string;
	readonly backupDir: string;
	readonly dbPath: string;
}

export interface BackupMetadata {
	readonly timestamp: string;
	readonly original_size: number;
	readonly backup_size: number;
	readonly db_checksum: string;
	readonly backup_checksum: string;
	readonly compressed: true;
}

export interface BackupResult extends BackupMetadata {
	readonly backup_path: string;
	readonly metadata_path: string;
}

export interface RestoreResult {
	readonly restored: true;
	readonly backup_used: string;
	readonly database_path: string;
	readonly integrity_check: boolean;
}

export interface EmergencyRestoreResult {
	readonly restored: true;
	readonly backup_used: string;
	readonly attempts: number;
}

export interface BackupInfo {
	readonly file: string;
	readonly name: string;
	readonly size: number;
	readonly modified: string;
	readonly metadata?: BackupMetadata;
}

export interface RotateBackupsResult {
	readonly total_backups: number;
	readonly kept: number;
	readonly deleted: number;
	readonly deleted_files: string[];
}

export interface HealthCheckResult {
	readonly database: {
		readonly exists: boolean;
		readonly valid: boolean;
		readonly path: string;
		readonly message: string;
	};
	readonly backups: {
		readonly total: number;
		readonly latest: string | null;
		readonly directory: string;
	};
	readonly status: "healthy" | "unhealthy";
}

function timestampForBackup(now = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function sha256Hex16(bytes: NodeJS.ArrayBufferView): string {
	return crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

function nextUniqueToken(): string {
	uniqueCounter = (uniqueCounter + 1) % 0x1fffffff;
	return `${Date.now().toString(36)}_${process.pid.toString(36)}_${uniqueCounter.toString(36)}`;
}

function hasErrorCode(error: unknown, code: string): boolean {
	return (
		error !== null &&
		typeof error === "object" &&
		"code" in error &&
		(error as { readonly code?: unknown }).code === code
	);
}

function writeBackupFile(destinationDir: string, timestamp: string, bytes: Uint8Array): string {
	for (let attempt = 0; attempt < 64; attempt += 1) {
		const suffix = attempt === 0 ? "" : `_${nextUniqueToken()}`;
		const backupPath = nodePath.join(destinationDir, `mnemosyne_backup_${timestamp}${suffix}.db.gz`);
		try {
			fs.writeFileSync(backupPath, bytes, { flag: "wx" });
			return backupPath;
		} catch (error) {
			if (hasErrorCode(error, "EEXIST")) continue;
			throw error;
		}
	}
	throw new Error(`Unable to allocate unique backup path in ${destinationDir}`);
}

function restoreTempPath(targetPath: string): string {
	return nodePath.join(
		nodePath.dirname(targetPath),
		`.${nodePath.basename(targetPath)}.${process.pid}.${nextUniqueToken()}.restore.tmp`,
	);
}

function defaultBackupDir(env: Env = process.env): string {
	const explicit = env.MNEMOSYNE_BACKUP_DIR;
	if (explicit !== undefined && explicit.length > 0) return explicit;
	const dir = configuredDataDir(env);
	return nodePath.join(nodePath.dirname(dir), "backups");
}

export function getDefaultPaths(env: Env = process.env): RecoveryPaths {
	return {
		dataDir: configuredDataDir(env),
		backupDir: defaultBackupDir(env),
		dbPath: configuredDbPath(env),
	};
}
export function createBackup(dbPath?: string | null, backupDir?: string | null): BackupResult {
	const paths = getDefaultPaths();
	const sourcePath = dbPath ?? paths.dbPath;
	const destinationDir = backupDir ?? paths.backupDir;

	if (!fs.existsSync(sourcePath)) throw new FileNotFoundError(`Database not found: ${sourcePath}`);

	fs.mkdirSync(destinationDir, { recursive: true });
	const timestamp = timestampForBackup();

	let snapshot: Uint8Array | null = null;
	let sourceDb: Database | null = null;
	try {
		sourceDb = openDatabase(sourcePath, { create: false, readwrite: false, pragmas: false });
		snapshot = (sourceDb as SerializableDatabase).serialize();
	} finally {
		closeQuietly(sourceDb);
	}
	if (snapshot === null) throw new Error(`Unable to serialize database backup: ${sourcePath}`);
	const backupPath = writeBackupFile(destinationDir, timestamp, zlib.gzipSync(snapshot));

	const dbBytes = fs.readFileSync(sourcePath);
	const backupBytes = fs.readFileSync(backupPath);
	const metadata: BackupMetadata = {
		timestamp,
		original_size: fs.statSync(sourcePath).size,
		backup_size: fs.statSync(backupPath).size,
		db_checksum: sha256Hex16(dbBytes),
		backup_checksum: sha256Hex16(backupBytes),
		compressed: true,
	};
	const metadataPath = `${backupPath.slice(0, -3)}.gz.json`;
	fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

	return { backup_path: backupPath, metadata_path: metadataPath, ...metadata };
}
function isSqliteFile(bytes: Uint8Array): boolean {
	if (bytes.length < SQLITE_HEADER.length) return false;
	for (let i = 0; i < SQLITE_HEADER.length; i += 1) {
		if (bytes[i] !== SQLITE_HEADER[i]) return false;
	}
	return true;
}

function writeGzippedSqlDump(sql: string, tempPath: string): void {
	let db: Database | null = null;
	try {
		db = new Database(tempPath, { create: true, readwrite: true, strict: true });
		db.exec(sql);
	} finally {
		closeQuietly(db);
	}
}

function sqliteSidecarPath(dbPath: string, suffix: (typeof SQLITE_SIDECAR_SUFFIXES)[number]): string {
	return `${dbPath}${suffix}`;
}

function removeSqliteSidecars(dbPath: string): void {
	for (const suffix of SQLITE_SIDECAR_SUFFIXES) fs.rmSync(sqliteSidecarPath(dbPath, suffix), { force: true });
}

function emergencyBackupPath(targetPath: string): string {
	const ext = nodePath.extname(targetPath);
	if (ext.length === 0) return `${targetPath}.emergency_backup.db`;
	return `${targetPath.slice(0, -ext.length)}.emergency_backup.db`;
}

function emergencyBackupSidecarPath(targetPath: string, suffix: (typeof SQLITE_SIDECAR_SUFFIXES)[number]): string {
	return `${emergencyBackupPath(targetPath)}${suffix}`;
}

function snapshotCurrentDatabase(targetPath: string): void {
	const mainBackup = emergencyBackupPath(targetPath);
	fs.rmSync(mainBackup, { force: true });
	for (const suffix of SQLITE_SIDECAR_SUFFIXES)
		fs.rmSync(emergencyBackupSidecarPath(targetPath, suffix), { force: true });
	if (fs.existsSync(targetPath)) fs.copyFileSync(targetPath, mainBackup);
	for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
		const sidecar = sqliteSidecarPath(targetPath, suffix);
		if (fs.existsSync(sidecar)) fs.copyFileSync(sidecar, emergencyBackupSidecarPath(targetPath, suffix));
	}
}

function restoreCurrentDatabaseSnapshot(targetPath: string): void {
	const mainBackup = emergencyBackupPath(targetPath);
	if (!fs.existsSync(mainBackup)) return;
	fs.copyFileSync(mainBackup, targetPath);
	for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
		const sidecar = sqliteSidecarPath(targetPath, suffix);
		fs.rmSync(sidecar, { force: true });
		const backupSidecar = emergencyBackupSidecarPath(targetPath, suffix);
		if (fs.existsSync(backupSidecar)) fs.copyFileSync(backupSidecar, sidecar);
	}
}

function writeRestoreCandidate(uncompressed: Buffer, tempPath: string): void {
	if (isSqliteFile(uncompressed)) {
		fs.writeFileSync(tempPath, uncompressed, { flag: "wx" });
		return;
	}
	writeGzippedSqlDump(uncompressed.toString("utf8"), tempPath);
}

export function restoreBackup(backupPath: string, dbPath?: string | null): RestoreResult {
	const targetPath = dbPath ?? getDefaultPaths().dbPath;
	if (!fs.existsSync(backupPath)) throw new FileNotFoundError(`Backup not found: ${backupPath}`);

	fs.mkdirSync(nodePath.dirname(targetPath), { recursive: true });

	const uncompressed = zlib.gunzipSync(fs.readFileSync(backupPath));
	const tempPath = restoreTempPath(targetPath);
	let replacedTarget = false;
	try {
		writeRestoreCandidate(uncompressed, tempPath);
		if (!verifyIntegrity(tempPath)) throw new Error(`Backup failed integrity check: ${backupPath}`);
		snapshotCurrentDatabase(targetPath);
		fs.renameSync(tempPath, targetPath);
		replacedTarget = true;
		removeSqliteSidecars(targetPath);
		const integrity = verifyIntegrity(targetPath);
		if (!integrity) throw new Error(`Restored database failed integrity check: ${backupPath}`);
		return {
			restored: true,
			backup_used: backupPath,
			database_path: targetPath,
			integrity_check: integrity,
		};
	} catch (error) {
		try {
			fs.rmSync(tempPath, { force: true });
		} catch {
			// Preserve the restore failure.
		}
		if (replacedTarget) {
			try {
				restoreCurrentDatabaseSnapshot(targetPath);
			} catch {
				// Preserve the restore failure.
			}
		}
		throw error;
	}
}
export function emergencyRestore(backupDir?: string | null, dbPath?: string | null): EmergencyRestoreResult {
	const paths = getDefaultPaths();
	const dir = backupDir ?? paths.backupDir;
	const targetPath = dbPath ?? paths.dbPath;
	const backups = fs.existsSync(dir)
		? fs
				.readdirSync(dir)
				.filter(name => /^mnemosyne_backup_.*\.db\.gz$/.test(name))
				.sort()
				.reverse()
				.map(name => nodePath.join(dir, name))
		: [];

	if (backups.length === 0) throw new FileNotFoundError(`No backups found in ${dir}`);

	let attempts = 0;
	for (const backup of backups) {
		attempts += 1;
		try {
			const result = restoreBackup(backup, targetPath);
			if (result.integrity_check) return { restored: true, backup_used: backup, attempts };
		} catch {
			// Try the next backup, matching the Python recovery behavior.
		}
	}
	throw new Error("All backups failed integrity check");
}
export function verifyIntegrity(dbPath?: string | null): boolean {
	const targetPath = dbPath ?? getDefaultPaths().dbPath;
	if (!fs.existsSync(targetPath)) return false;

	let db: Database | null = null;
	try {
		db = openDatabase(targetPath, { create: false, readwrite: false, pragmas: false });
		const row = db.query("PRAGMA integrity_check").get() as { integrity_check: string } | null;
		return row?.integrity_check === "ok";
	} catch {
		return false;
	} finally {
		closeQuietly(db);
	}
}
export function listBackups(backupDir?: string | null): BackupInfo[] {
	const dir = backupDir ?? getDefaultPaths().backupDir;
	if (!fs.existsSync(dir)) return [];

	return fs
		.readdirSync(dir)
		.filter(name => /^mnemosyne_backup_.*\.db\.gz$/.test(name))
		.sort()
		.reverse()
		.map(name => {
			const file = nodePath.join(dir, name);
			const stat = fs.statSync(file);
			const metaFile = `${file.slice(0, -3)}.gz.json`;
			const info: BackupInfo = {
				file,
				name,
				size: stat.size,
				modified: stat.mtime.toISOString(),
			};
			if (!fs.existsSync(metaFile)) return info;
			return { ...info, metadata: JSON.parse(fs.readFileSync(metaFile, "utf8")) as BackupMetadata };
		});
}
export function rotateBackups(backupDir?: string | null, keep = 10): RotateBackupsResult {
	const dir = backupDir ?? getDefaultPaths().backupDir;
	const backups = fs.existsSync(dir)
		? fs
				.readdirSync(dir)
				.filter(name => /^mnemosyne_backup_.*\.db\.gz$/.test(name))
				.sort()
				.map(name => nodePath.join(dir, name))
		: [];
	const toDelete = backups.length > keep ? backups.slice(0, backups.length - keep) : [];
	const deletedFiles: string[] = [];
	for (const backup of toDelete) {
		fs.unlinkSync(backup);
		const meta = `${backup.slice(0, -3)}.gz.json`;
		if (fs.existsSync(meta)) fs.unlinkSync(meta);
		deletedFiles.push(nodePath.basename(backup));
	}
	return {
		total_backups: backups.length,
		kept: keep,
		deleted: deletedFiles.length,
		deleted_files: deletedFiles,
	};
}
export function healthCheck(): HealthCheckResult {
	const paths = getDefaultPaths();
	const dbExists = fs.existsSync(paths.dbPath);
	const dbValid = dbExists ? verifyIntegrity(paths.dbPath) : false;
	const backups = listBackups(paths.backupDir)
		.map(backup => backup.file)
		.sort();
	return {
		database: {
			exists: dbExists,
			valid: dbValid,
			path: paths.dbPath,
			message: dbValid ? "Database integrity verified" : "Database missing or corrupt",
		},
		backups: {
			total: backups.length,
			latest: backups.at(-1) ?? null,
			directory: paths.backupDir,
		},
		status: dbValid ? "healthy" : "unhealthy",
	};
}
export class FileNotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FileNotFoundError";
	}
}

export function resetRecoveryForTests(): void {
	// Recovery has no module state; exported for test harness symmetry.
}
