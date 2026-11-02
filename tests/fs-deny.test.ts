/**
 * Tests for the learner-fs deny guard (fs-deny wave, 2026-11-02):
 * src/agent/tools/fs-deny.ts — the single policy module — and its wiring
 * through fs-shared.ts (walk pruning, capOutput masking). Synthetic homes
 * only; nothing outside os.tmpdir() is touched.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	assertPathAllowed,
	checkPathAccess,
	defaultDenyScope,
	deniedReason,
	FileAccessDeniedError,
	redactSecrets,
	type DenyScope,
} from "../src/agent/tools/fs-deny.ts";
import { capOutput, resolveSourcePath, walkFiles } from "../src/agent/tools/fs-shared.ts";

/** A synthetic home: other agents' transcripts, an ssh key, a dotenv file,
 *  a symlink into .ssh, an app-private data dir, and ordinary notes. */
async function makeHome(): Promise<{ root: string; home: string; scope: DenyScope }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "lh-fs-deny-"));
	const home = path.join(root, "home");
	const dataDir = path.join(root, "app-data");
	const authDir = path.join(root, "authdir");
	await fs.mkdir(path.join(home, ".claude/projects/p"), { recursive: true });
	await fs.mkdir(path.join(home, ".ssh"), { recursive: true });
	await fs.mkdir(path.join(home, ".claudette"), { recursive: true });
	await fs.mkdir(path.join(home, "notes"), { recursive: true });
	await fs.mkdir(path.join(home, "code"), { recursive: true });
	await fs.mkdir(dataDir, { recursive: true });
	await fs.mkdir(authDir, { recursive: true });
	await fs.writeFile(path.join(home, ".claude/projects/p/agent-1.jsonl"), '{"text":"transcript"}\n');
	await fs.writeFile(path.join(home, ".ssh/id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE\n");
	await fs.writeFile(path.join(home, "code/.env.local"), "APP_TOKEN=sk-secret-token-123456\n");
	await fs.writeFile(path.join(home, ".claudette/ok.md"), "lookalike dir stays readable\n");
	await fs.writeFile(path.join(home, "notes/calculus.md"), "# Calculus\n");
	await fs.writeFile(path.join(authDir, "auth.json"), "{}\n");
	await fs.symlink(path.join(home, ".ssh"), path.join(home, "notes/keys"));
	const scope: DenyScope = {
		home,
		dataDir,
		authFile: path.join(authDir, "auth.json"),
		extraDirs: [path.join(root, "userData")],
	};
	return { root, home, scope };
}

const created: string[] = [];
after(async () => {
	for (const dir of created.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("the fs-deny guard", () => {
	it("matches listed dirs, dotenv files, and nothing that merely looks alike", async () => {
		const { home, scope } = await makeHome();
		created.push(path.dirname(scope.authFile), scope.dataDir);
		const denied: [string, string][] = [
			[path.join(home, ".ssh/id_rsa"), "credentials"],
			[path.join(home, ".SSH/id_rsa"), "credentials"], // case-insensitive
			[path.join(home, ".config/gcloud/credentials.db"), "credentials"],
			[path.join(home, ".docker/config.json"), "credentials"],
			[path.join(home, ".claude/projects/x.jsonl"), "agent-transcripts"],
			[path.join(home, "work/.env"), "credentials"],
			[path.join(os.tmpdir(), "elsewhere/.env.production"), "credentials"], // basename rule, any root
			[path.join(home, "auth.json"), "app-private"],
			[path.join(home, "chatgpt-credentials.json"), "app-private"],
			[path.join(scope.dataDir, "chats/1.json"), "app-private"],
			[path.join(scope.extraDirs[0]!, "settings.json"), "app-private"],
		];
		for (const [target, reason] of denied) {
			assert.equal(deniedReason(target, scope), reason, `expected ${reason} deny: ${target}`);
		}
		const allowed = [
			home,
			path.join(home, ".claudette/ok.md"),
			path.join(home, "notes/claude.md"),
			path.join(home, ".config/nvim/init.lua"),
			path.join(home, ".ssh2/not-the-ssh-dir"),
			path.join(home, "notes/environment.md"),
			path.join(os.tmpdir(), "other-home/.ssh/id_rsa"),
		];
		for (const target of allowed) {
			assert.equal(deniedReason(target, scope), undefined, `expected allow: ${target}`);
		}
	});

	it("verdicts fail closed for nonexistent files in denied areas", async () => {
		const { home, scope } = await makeHome();
		assert.equal((await checkPathAccess(path.join(home, ".ssh/does-not-exist"), scope)).allowed, false);
		assert.equal((await checkPathAccess(path.join(scope.dataDir, "graph/nodes.jsonl"), scope)).allowed, false);
	});

	it("symlinks cannot launder a denied path", async () => {
		const { home, scope } = await makeHome();
		const link = path.join(home, "notes/keys/id_ed25519");
		assert.equal((await checkPathAccess(link, scope)).allowed, false, "symlinked dir into .ssh denied");
		await assert.rejects(() => assertPathAllowed(link, scope), FileAccessDeniedError);
	});

	it("denials carry the reason in the message; ordinary files pass", async () => {
		const { home, scope } = await makeHome();
		await assert.rejects(
			() => assertPathAllowed(path.join(home, ".ssh/id_ed25519"), scope),
			(err: Error) => err instanceof FileAccessDeniedError && /file access denied \(credentials\)/.test(err.message),
		);
		await assertPathAllowed(path.join(home, "notes/calculus.md"), scope);
	});

	it("default scope follows LH_DATA_DIR and LH_AUTH_FILE live", () => {
		const prevData = process.env.LH_DATA_DIR;
		const prevAuth = process.env.LH_AUTH_FILE;
		try {
			process.env.LH_DATA_DIR = "/tmp/lh-probe-data";
			process.env.LH_AUTH_FILE = "/tmp/lh-probe-auth.json";
			const scope = defaultDenyScope();
			assert.equal(scope.dataDir, path.resolve("/tmp/lh-probe-data"));
			assert.equal(scope.authFile, path.resolve("/tmp/lh-probe-auth.json"));
		} finally {
			if (prevData === undefined) delete process.env.LH_DATA_DIR;
			else process.env.LH_DATA_DIR = prevData;
			if (prevAuth === undefined) delete process.env.LH_AUTH_FILE;
			else process.env.LH_AUTH_FILE = prevAuth;
		}
	});

	it("redactSecrets masks key-like values, keeps prose and paths, and is idempotent", () => {
		const openai = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
		const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
		const cases = [
			`OPENAI_API_KEY=${openai}`,
			`{"apiKey": "${openai}"}`,
			`token: ghp_${"A".repeat(36)}`,
			`GITHUB_TOKEN=github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`,
			`aws_access_key_id = AKIA${"B".repeat(16)}`,
			`key=AIza${"C".repeat(35)}`,
			`slack=xoxb-${"1".repeat(12)}-${"d".repeat(24)}`,
			`password: "hunter2hunter2hunter2"`,
			`secret = ${"Q".repeat(24)}`,
			pem,
		];
		for (const raw of cases) {
			const once = redactSecrets(raw);
			assert.ok(!once.includes(raw) || once.includes("[redacted]"), `no marker for: ${raw.slice(0, 24)}`);
			assert.ok(once.includes("[redacted]"), `masked: ${raw.slice(0, 24)}`);
			assert.equal(redactSecrets(once), once, "idempotent");
		}
		assert.ok(!redactSecrets(pem).includes("MIIEowIBAAKCAQEA"));
		const prose = "Photosynthesis converts light energy into chemical energy.";
		assert.equal(redactSecrets(prose), prose);
		const paths = "/home/u/notes/a.md\n/home/u/project/src/index.ts";
		assert.equal(redactSecrets(paths), paths);
	});

	it("capOutput masks before the byte ceiling is measured", () => {
		const token = "ghp_" + "D".repeat(36);
		const { content } = capOutput([`/home/u/notes/token.txt:AUTH=${token}`, "/home/u/notes/a.md"]);
		assert.ok(!content.includes(token));
		assert.ok(content.includes("[redacted]"));
		assert.ok(content.includes("/home/u/notes/a.md"));
	});

	it("walkFiles never enters sensitive directories (home-anchored)", async () => {
		const { root, home } = await makeHome();
		const originalHome = process.env.HOME;
		const originalUserProfile = process.env.USERPROFILE;
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		try {
			const seen: string[] = [];
			await walkFiles(home, (file) => {
				seen.push(path.relative(home, file).split(path.sep).join("/"));
				return false;
			});
			assert.ok(seen.includes("notes/calculus.md"));
			assert.ok(seen.includes(".claudette/ok.md"), "a lookalike name is still walked");
			assert.ok(
				!seen.some((f) => f.startsWith(".claude/") || f.startsWith(".ssh/")),
				`denied dirs walked: ${seen.join(", ")}`,
			);
			assert.ok(!seen.some((f) => f.startsWith("code/.env")), "dotenv files are skipped by walks");
			assert.ok(!seen.some((f) => f.startsWith("notes/keys/")), "symlinks are not followed");
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			if (originalUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = originalUserProfile;
			created.push(root);
		}
	});

	it("resolveSourcePath stays pure: no verdicts, no I/O", () => {
		// It maps arguments; judging is the guard's job.
		assert.equal(resolveSourcePath("~/.ssh/id_rsa"), path.join(os.homedir(), ".ssh/id_rsa"));
		assert.equal(resolveSourcePath("notes/a.md"), path.join(os.homedir(), "notes/a.md"));
	});
});
