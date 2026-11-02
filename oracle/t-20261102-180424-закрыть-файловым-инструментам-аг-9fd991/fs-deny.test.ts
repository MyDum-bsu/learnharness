/**
 * Oracle for t-20261102-180424 — файловые инструменты агента не отдают секреты,
 * транскрипты других агентов и приватные данные приложения; key-like значения
 * маскируются в выводе.
 *
 * Контракт (см. specs/<id>.md): src/agent/tools/fs-deny.ts экспортирует
 * DenyScope, defaultDenyScope, checkPathAccess, assertPathAllowed,
 * FileAccessDeniedError, redactSecrets; capOutput маскирует; каждый модуль
 * инструмента read/ls/find/grep вызывает guard и маскирование.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	checkPathAccess,
	assertPathAllowed,
	defaultDenyScope,
	FileAccessDeniedError,
	redactSecrets,
	type DenyScope,
	// Two ups from oracle/<id>/ reach the repository root in every layout the
	// oracle runs in (repo-root checkout, integration tree, task worktree) —
	// the original four ups only resolved in the first of them.
} from "../../src/agent/tools/fs-deny.ts";
import { capOutput } from "../../src/agent/tools/fs-shared.ts";

// Two ups from oracle/<id>/ reach the repository root in every layout the
// oracle runs in (repo-root checkout, integration tree, task worktree).
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TOOLS_DIR = path.join(REPO_ROOT, "src", "agent", "tools");

type Fixture = DenyScope & { root: string; linkFile: string; linkDir: string };

async function makeFixture(): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "lh-fs-deny-"));
	const home = path.join(root, "home");
	const dataDir = path.join(root, "data");
	const authDir = path.join(root, "authdir");
	const sshDir = path.join(home, ".ssh");
	const notesDir = path.join(home, "notes");
	await fs.mkdir(sshDir, { recursive: true });
	await fs.mkdir(notesDir, { recursive: true });
	await fs.mkdir(dataDir, { recursive: true });
	await fs.mkdir(authDir, { recursive: true });
	await fs.mkdir(path.join(home, ".aws"), { recursive: true });
	await fs.writeFile(path.join(sshDir, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE\n");
	await fs.writeFile(path.join(home, ".env"), "TOKEN=plain\n");
	await fs.writeFile(path.join(notesDir, "a.md"), "# My notes\n\nPhotosynthesis.\n");
	await fs.writeFile(path.join(authDir, "auth.json"), '{"keys":{}}\n');

	const linkFile = path.join(notesDir, "id-rsa-link");
	await fs.symlink(path.join(sshDir, "id_rsa"), linkFile);
	const linkDir = path.join(notesDir, "ssh-dir-link");
	await fs.symlink(sshDir, linkDir);

	return {
		root,
		home,
		dataDir,
		authFile: path.join(authDir, "auth.json"),
		extraDirs: [path.join(root, "userData")],
		linkFile,
		linkDir,
	};
}

const DENIED_PATHS: ((f: Fixture) => string)[] = [
	(f) => path.join(f.home, ".ssh/id_rsa"),
	(f) => path.join(f.home, ".aws/credentials"),
	(f) => path.join(f.home, ".env"),
	(f) => path.join(f.home, ".env.local"),
	(f) => path.join(f.home, ".claude/projects/abc/transcript.jsonl"),
	(f) => path.join(f.home, "auth.json"),
	(f) => path.join(f.home, "chatgpt-credentials.json"),
	(f) => path.join(f.home, "github-copilot-credentials.json"),
	(f) => path.join(f.home, "xai-credentials.json"),
	(f) => f.authFile,
	(f) => path.join(f.dataDir, "chats/1.json"),
	(f) => path.join(f.extraDirs[0]!, "settings.json"),
];

test("secrets, agent transcripts and app-private paths are denied", async () => {
	const f = await makeFixture();
	for (const build of DENIED_PATHS) {
		const target = build(f);
		const verdict = await checkPathAccess(target, f);
		assert.equal(verdict.allowed, false, `expected deny: ${target}`);
		assert.ok(
			typeof verdict.reason === "string" && verdict.reason.length > 0,
			`deny must carry a reason: ${target}`,
		);
		await assert.rejects(
			() => assertPathAllowed(target, f),
			(err: unknown) => {
				assert.ok(err instanceof FileAccessDeniedError, `wrong error type for ${target}: ${String(err)}`);
				assert.equal((err as Error).name, "FileAccessDeniedError");
				assert.match((err as Error).message, /file access denied/);
				return true;
			},
		);
	}
});

test("ordinary learner files stay readable", async () => {
	const f = await makeFixture();
	const allowed = [
		path.join(f.home, "notes/a.md"),
		path.join(f.home, "Documents/plan.md"),
		path.join(f.home, "project/src/index.ts"),
		path.join(f.home, ".ssh2/not-the-ssh-dir"),
	];
	for (const target of allowed) {
		const verdict = await checkPathAccess(target, f);
		assert.equal(verdict.allowed, true, `expected allow: ${target}`);
		await assertPathAllowed(target, f);
	}
});

test("symlinks cannot launder a denied path", async () => {
	const f = await makeFixture();
	assert.equal((await checkPathAccess(f.linkFile, f)).allowed, false, "file symlink into .ssh must be denied");
	assert.equal(
		(await checkPathAccess(path.join(f.linkDir, "id_rsa"), f)).allowed,
		false,
		"path through a symlinked directory into .ssh must be denied",
	);
	await assert.rejects(() => assertPathAllowed(f.linkFile, f), FileAccessDeniedError);

	const safeTarget = path.join(f.home, "notes/a.md");
	const safeLink = path.join(f.home, "notes/a-link.md");
	await fs.symlink(safeTarget, safeLink);
	assert.equal((await checkPathAccess(safeLink, f)).allowed, true, "symlink to an allowed file stays allowed");
});

test("does not depend on the file existing (fail closed)", async () => {
	const f = await makeFixture();
	const ghost = path.join(f.home, ".ssh/does-not-exist");
	assert.equal((await checkPathAccess(ghost, f)).allowed, false);
	const ghostData = path.join(f.dataDir, "graph/nodes.jsonl");
	assert.equal((await checkPathAccess(ghostData, f)).allowed, false);
});

test("default scope follows LH_DATA_DIR and LH_AUTH_FILE", () => {
	const prevData = process.env.LH_DATA_DIR;
	const prevAuth = process.env.LH_AUTH_FILE;
	process.env.LH_DATA_DIR = "/tmp/lh-probe-data";
	process.env.LH_AUTH_FILE = "/tmp/lh-probe-auth.json";
	try {
		const scope = defaultDenyScope();
		assert.equal(path.resolve(scope.dataDir), "/tmp/lh-probe-data");
		assert.equal(path.resolve(scope.authFile), "/tmp/lh-probe-auth.json");
		assert.equal(typeof scope.home, "string");
		assert.ok(scope.home.length > 0, "home must not be empty");
		assert.ok(Array.isArray(scope.extraDirs));
	} finally {
		if (prevData === undefined) delete process.env.LH_DATA_DIR;
		else process.env.LH_DATA_DIR = prevData;
		if (prevAuth === undefined) delete process.env.LH_AUTH_FILE;
		else process.env.LH_AUTH_FILE = prevAuth;
	}
});

test("key-like values are masked, ordinary prose and paths are not", () => {
	const openai = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
	const githubPat = "github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
	const githubClassic = "ghp_" + "A".repeat(36);
	const awsKey = "AKIA" + "B".repeat(16);
	const googleKey = "AIza" + "C".repeat(35);
	const xoxb = "xoxb-" + "1".repeat(12) + "-" + "d".repeat(24);
	const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";

	const cases: { raw: string; secret: string }[] = [
		{ raw: `OPENAI_API_KEY=${openai}`, secret: openai },
		{ raw: `{"apiKey": "${openai}"}`, secret: openai },
		{ raw: `GITHUB_TOKEN=${githubPat}`, secret: githubPat },
		{ raw: `token: ${githubClassic}`, secret: githubClassic },
		{ raw: `aws_access_key_id = ${awsKey}`, secret: awsKey },
		{ raw: `key=${googleKey}`, secret: googleKey },
		{ raw: `slack=${xoxb}`, secret: xoxb },
		{ raw: `password: "hunter2hunter2hunter2"`, secret: "hunter2hunter2hunter2" },
		{ raw: `secret = ${"Q".repeat(24)}`, secret: "Q".repeat(24) },
		{ raw: pem, secret: "MIIEowIBAAKCAQEA" },
	];

	for (const { raw, secret } of cases) {
		const out = redactSecrets(raw);
		assert.ok(!out.includes(secret), `secret leaked: ${secret.slice(0, 12)}…`);
		assert.ok(out.includes("[redacted]"), `missing [redacted] marker for: ${secret.slice(0, 12)}…`);
		assert.equal(redactSecrets(out), out, "redaction must be idempotent");
	}

	const prose = "Photosynthesis converts light energy into chemical energy.";
	assert.equal(redactSecrets(prose), prose);
	const paths = "/home/u/notes/a.md\n/home/u/project/src/index.ts";
	assert.equal(redactSecrets(paths), paths);
});

test("capOutput (ls/find/grep text path) masks key-like values", () => {
	const token = "ghp_" + "D".repeat(36);
	const { content } = capOutput([`/home/u/notes/token.txt:AUTH=${token}`, "/home/u/notes/a.md"]);
	assert.ok(!content.includes(token), "capOutput leaked a token");
	assert.ok(content.includes("[redacted]"));
	assert.ok(content.includes("/home/u/notes/a.md"));
});

test("every learner-fs tool module wires the guard and the masking", async () => {
	const declares = /name:\s*"(read|ls|find|grep)"/;
	const guard = /checkPathAccess|assertPathAllowed/;
	const mask = /redactSecrets|capOutput/;
	const entries = await fs.readdir(TOOLS_DIR);
	let checked = 0;
	for (const entry of entries) {
		if (!entry.endsWith(".ts")) continue;
		const source = await fs.readFile(path.join(TOOLS_DIR, entry), "utf8");
		if (!declares.test(source)) continue;
		checked += 1;
		assert.match(source, guard, `${entry} must consult the deny guard before reading`);
		assert.match(source, mask, `${entry} must mask key-like output`);
	}
	assert.ok(checked >= 1, "no tool module declaring read/ls/find/grep was found in src/agent/tools");
});
