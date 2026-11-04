const { withAndroidManifest } = require("expo/config-plugins");

/**
 * THE CLEARTEXT ALLOWANCE (mobile v1.0.2): the LearnHarness server speaks
 * plain HTTP on its tailnet/LAN address — a release build blocks such
 * traffic by default (Android 9+), which showed up as "Сервер
 * недоступен" in the emulator. One manifest attribute fixes it for every
 * prebuild; TLS, when the operator front-ends the server with it, is
 * unaffected (https keeps working for both).
 */
module.exports = function cleartextPlugin(config) {
	return withAndroidManifest(config, (cfg) => {
		const application = cfg.modResults.manifest.application?.[0];
		if (application) {
			application.$["android:usesCleartextTraffic"] = "true";
		}
		return cfg;
	});
};
