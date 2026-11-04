#!/usr/bin/env bash
# LearnHarness — the menu-app launcher (desktop-menu wave, 2026-11-03).
#
# Starts the repo's standalone production server (once) on 127.0.0.1 and
# opens the Electron shell at it. Data/keys are the repo's own data/ +
# auth.json — the same sessions the dev server uses. A second launch
# focuses the running window (Electron single-instance lock) and reuses
# the live server. The server stops when the shell that STARTED it exits;
# a launcher that only reattached leaves it alone.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${LH_MENU_PORT:-3311}"
PID_FILE="/tmp/learnharness-menu-server.pid"
LOG_FILE="/tmp/learnharness-menu-server.log"
LAUNCH_LOG="/tmp/learnharness-launcher.log"
# Menu launches get a minimal environment (no login profile): keep a log
# so a failed start is diagnosable instead of "nothing happens".
exec >>"$LAUNCH_LOG" 2>&1
echo "— launch $(date -Is) —"

# Menu PATH has no nvm: pin a Node 26 bin dir when one exists (the server
# and the electron CLI both need node; Next 16 standalone wants Node 26).
for candidate in "$HOME"/.nvm/versions/node/v26.*/bin; do
	if [ -x "$candidate/node" ]; then
		export PATH="$candidate:$PATH"
		break
	fi
done

# THE MOBILE SEAM (mobile wave, 2026-11-04): when a Tailscale interface
# exists, the server binds THE TAILNET ADDRESS — reachable only by tailnet
# members, never the raw LAN — and server mode turns on with a
# launcher-generated password (stored 0600). The desktop shell signs the
# owner in itself (LH_OWNER_PASSWORD); the phone pairs with a one-time
# device token. Without Tailscale: loopback only, no server mode — exactly
# the P0-3 posture.
TS_IP="$(ip -4 -o addr show dev tailscale0 2>/dev/null | awk '{split($4,a,"/"); print a[1]; exit}')"
SECRET_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/learnharness-menu"
mkdir -p "$SECRET_DIR"
PASSWORD_FILE="$SECRET_DIR/server-password"
if [ -n "$TS_IP" ]; then
	if [ ! -s "$PASSWORD_FILE" ]; then
		(umask 077 && head -c 32 /dev/urandom | base64 | tr -d '=+/' >"$PASSWORD_FILE")
	fi
	LH_SERVER_PASSWORD="$(cat "$PASSWORD_FILE")"
	export LH_SERVER_PASSWORD
	export LH_OWNER_PASSWORD="$LH_SERVER_PASSWORD"
	HOST_BIND="$TS_IP"
	URL="http://${TS_IP}:${PORT}"
else
	HOST_BIND="127.0.0.1"
	URL="http://127.0.0.1:${PORT}"
fi

# Health check by ANSWER, not by status: in server mode every route
# answers 401 without a session — a 401 still proves the server is up.
up() {
	local code
	code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "${URL}/api/v1/bootstrap" 2>/dev/null || true)"
	[ -n "$code" ] && [ "$code" != "000" ]
}

STARTED=0
if ! up; then
	if [ ! -f "${REPO}/.next/standalone/server.js" ]; then
		(cd "${REPO}" && npm run build)
	fi
	# The standalone tree needs the browser assets beside it: next build
	# traces the server's deps but leaves .next/static where it was.
	[ -d "${REPO}/.next/standalone/.next/static" ] || cp -r "${REPO}/.next/static" "${REPO}/.next/standalone/.next/static"
	[ -d "${REPO}/.next/standalone/public" ] || cp -r "${REPO}/public" "${REPO}/.next/standalone/public"
	(
		cd "${REPO}/.next/standalone" &&
			# THE DATA SEAM (desktop-menu fix, 2026-11-04): pinned explicitly —
			# without it the standalone server resolves its own build-tree data/
			# and the app shows an empty (or traced-junk) state instead of the
			# learner's real sessions, graph and keys.
			HOSTNAME="${HOST_BIND}" PORT="${PORT}" NODE_ENV=production \
				LH_DATA_DIR="${REPO}/data" LH_AUTH_FILE="${REPO}/auth.json" \
				nohup node server.js >"${LOG_FILE}" 2>&1 &
		echo $! >"${PID_FILE}"
	)
	STARTED=1
	for _ in $(seq 1 120); do
		up && break
		sleep 0.5
	done
	up || {
		echo "LearnHarness server did not come up — see ${LOG_FILE}" >&2
		exit 1
	}
fi

cleanup() {
	if [ "${STARTED}" = 1 ] && [ -f "${PID_FILE}" ]; then
		kill "$(cat "${PID_FILE}")" 2>/dev/null || true
		rm -f "${PID_FILE}"
	fi
}
trap cleanup EXIT

export LH_DEV_URL="${URL}"
# Foreground (no exec): the EXIT trap must fire when the window closes, so
# a server this launch started goes down with it. --class keeps the fork's
# window distinct from the official AppImage's in the dock (both can run).
"${REPO}/node_modules/.bin/electron" "${REPO}" --no-sandbox --class=learnharness-fork
