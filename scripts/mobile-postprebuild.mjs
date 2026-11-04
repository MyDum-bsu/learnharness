/**
 * The post-prebuild manifest patch (mobile v1.0.3): allows cleartext HTTP
 * for the LearnHarness server. The config-plugin route kept silently
 * no-op'ing under `expo prebuild`, so this runs as an explicit step after
 * `expo prebuild` in the CI workflow (and locally, before gradle).
 *
 * Idempotent: an attribute already present is left alone. A manifest
 * without an <application> element fails loudly — that manifest would be
 * corrupted beyond a patch anyway.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const manifestPath = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../mobile/android/app/src/main/AndroidManifest.xml",
);
let manifest = fs.readFileSync(manifestPath, "utf8");
if (!manifest.includes("usesCleartextTraffic")) {
	manifest = manifest.replace("<application ", '<application android:usesCleartextTraffic="true" ');
}
if (!/<application /.test(manifest)) {
	throw new Error(`postprebuild: no <application> element found in ${manifestPath}`);
}
fs.writeFileSync(manifestPath, manifest);
console.log("[postprebuild] cleartext allowed:", manifest.includes("usesCleartextTraffic"));
