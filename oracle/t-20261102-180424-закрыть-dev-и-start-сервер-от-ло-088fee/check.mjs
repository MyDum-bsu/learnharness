#!/usr/bin/env node
// Oracle for t-20261102-180424: dev/start must bind loopback, standalone documented with HOSTNAME.
// Fails on the unfixed repository, passes only after package.json + docs/development.md are changed.
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Walk up to the repository root (package.json + docs/development.md): the
// oracle runs from a repo-root checkout, the integration tree or a task
// worktree — a fixed climb only fits one of those depths.
let repoRoot = dirname(fileURLToPath(import.meta.url));
for (;;) {
	if (existsSync(resolve(repoRoot, "package.json")) && existsSync(resolve(repoRoot, "docs", "development.md"))) break;
	const parent = dirname(repoRoot);
	if (parent === repoRoot) throw new Error(`oracle: repository root (package.json + docs/development.md) not found above ${import.meta.url}`);
	repoRoot = parent;
}

const failures = [];
const fail = (msg) => failures.push(msg);

function read(rel) {
	try {
		return readFileSync(resolve(repoRoot, rel), "utf8");
	} catch (error) {
		fail(`${rel}: ${error.message}`);
		return null;
	}
}

const rawPkg = read("package.json");
let pkg = null;
if (rawPkg !== null) {
	try {
		pkg = JSON.parse(rawPkg);
	} catch (error) {
		fail(`package.json is not valid JSON: ${error.message}`);
	}
}

const EXPECTED = [
	["dev", "next dev"],
	["start", "next start"],
];

for (const [name, prefix] of EXPECTED) {
	const command = pkg?.scripts?.[name];
	if (typeof command !== "string") {
		fail(`scripts.${name} is missing or not a string`);
		continue;
	}
	const tokens = command.trim().split(/\s+/);
	if (!command.trim().startsWith(prefix)) {
		fail(`scripts.${name} must still start with "${prefix}", got "${command}"`);
	}

	const hosts = [];
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === "-H" || token === "--hostname") {
			hosts.push(tokens[i + 1]);
		} else if (token.startsWith("--hostname=")) {
			hosts.push(token.slice("--hostname=".length));
		} else if (/^-H=/.test(token)) {
			hosts.push(token.slice(3));
		}
	}

	if (hosts.length === 0) {
		fail(`scripts.${name} ("${command}") has no -H/--hostname; Next would listen on 0.0.0.0`);
	}
	for (const host of hosts) {
		if (host !== "127.0.0.1") {
			fail(`scripts.${name} ("${command}") sets a host other than 127.0.0.1: ${host ?? "<missing value>"}`);
		}
	}
	if (/0\.0\.0\.0/.test(command)) {
		fail(`scripts.${name} ("${command}") still references 0.0.0.0`);
	}
}

const docs = read("docs/development.md");
if (docs !== null && !/HOSTNAME=127\.0\.0\.1/.test(docs)) {
	fail("docs/development.md does not state HOSTNAME=127.0.0.1 for the standalone server");
}

if (failures.length > 0) {
	for (const message of failures) console.error(`FAIL ${message}`);
	process.exit(1);
}

console.log("OK dev/start bind 127.0.0.1; standalone documented with HOSTNAME=127.0.0.1");
