/**
 * Shared "fan-out forwarder" block for Orchestra hook scripts (claude, codex,
 * gemini, cursor — local and remote).
 *
 * Instead of baking a single config.json path into each hook script (which made
 * the last Orchestra instance to start "win" and silently steal every event),
 * the forwarder discovers every running instance at hook time and POSTs the
 * event to all of them:
 *
 *   - Local: every `~/.orchestra/<name>/config.json` (dev, stable, …).
 *   - Remote (SSH): falls back to `~/.agent-task-tracker/config.json`, which may
 *     hold a `targets[]` list (one entry per Mac instance that installed hooks)
 *     so a remote agent reports back to both the dev and stable apps.
 *
 * The `<PROVIDER>_HOOK_API_BASE` env var still short-circuits to a single
 * explicit target, preserving the previous override behavior.
 *
 * Each instance now generates an identical, path-agnostic script, so dev and
 * stable no longer overwrite each other's hook file with conflicting content.
 */

/**
 * Build the bash + inline-python block that discovers targets and POSTs the
 * event payload (held in the bash variable `payload`) to each one.
 *
 * @param {object} opts
 * @param {string} opts.envApiBase    env var for an explicit API base override (e.g. CLAUDE_HOOK_API_BASE)
 * @param {string} opts.envToken      env var for an explicit token override
 * @param {string} opts.envRemoteHost env var for an explicit remote_host override
 * @param {string} opts.tokenField    per-provider token key under `tokens` (e.g. "claude")
 * @param {string} opts.endpoint      event POST path (e.g. /api/claude-hooks/event)
 * @param {string} opts.header        token header name (e.g. X-Claude-Hook-Token)
 * @param {string} opts.configEndpoint config path used to fetch a missing token (e.g. /api/claude-hooks/config)
 * @param {boolean} [opts.appToken]   forward ORCHESTRA_APP_TOKEN as X-Orchestra-App-Token (gemini)
 */
function buildHookForwarderBlock({
  envApiBase,
  envToken,
  envRemoteHost,
  tokenField,
  endpoint,
  header,
  configEndpoint,
  appToken = false,
}) {
  const appExport = appToken ? 'ORCH_APP_TOKEN="\${ORCHESTRA_APP_TOKEN:-}" ' : 'ORCH_APP_TOKEN="" ';
  return `ORCHESTRA_HOOK_PAYLOAD="$payload" ORCH_ENV_API_BASE="$${envApiBase}" ORCH_ENV_TOKEN="$${envToken}" ORCH_ENV_REMOTE="$${envRemoteHost}" ${appExport}python3 - <<'PY' 2>/dev/null
import glob, json, os, urllib.request

TOKEN_FIELD = ${JSON.stringify(tokenField)}
ENDPOINT = ${JSON.stringify(endpoint)}
HEADER = ${JSON.stringify(header)}
CONFIG_ENDPOINT = ${JSON.stringify(configEndpoint)}

payload = os.environ.get("ORCHESTRA_HOOK_PAYLOAD", "")
env_api = os.environ.get("ORCH_ENV_API_BASE", "").strip()
env_token = os.environ.get("ORCH_ENV_TOKEN", "").strip()
env_remote = os.environ.get("ORCH_ENV_REMOTE", "").strip()
env_app = os.environ.get("ORCH_APP_TOKEN", "").strip()


def norm_host(h):
    h = (h or "").strip()
    if h in ("", "0.0.0.0", "::", "[::]"):
        return "127.0.0.1"
    return h


def targets_from_cfg(cfg):
    out = []
    # Consider both targets[] (one entry per app on a remote) and the legacy
    # top-level host/port (single-target writers / mixed old+new instances).
    # Duplicates are collapsed later by api base.
    items = []
    raw = cfg.get("targets")
    if isinstance(raw, list):
        items.extend([e for e in raw if isinstance(e, dict)])
    items.append(cfg)
    for it in items:
        if not isinstance(it, dict):
            continue
        port = it.get("port")
        if not port:
            continue
        host = norm_host(it.get("host"))
        toks = it.get("tokens") if isinstance(it.get("tokens"), dict) else {}
        tok = toks.get(TOKEN_FIELD) or it.get("token") or ""
        rh = it.get("remote_host") or cfg.get("remote_host") or env_remote or ""
        app = it.get("app_token") or it.get("appToken") or cfg.get("app_token") or cfg.get("appToken") or env_app or ""
        out.append({"api": "http://%s:%s" % (host, port), "token": tok, "remote": rh, "app": app})
    return out


targets = []
if env_api:
    targets.append({"api": env_api.rstrip("/"), "token": env_token, "remote": env_remote, "app": env_app})
else:
    paths = sorted(glob.glob(os.path.expanduser("~/.orchestra/*/config.json")))
    legacy = os.path.expanduser("~/.agent-task-tracker/config.json")
    if os.path.isfile(legacy):
        paths.append(legacy)
    for p in paths:
        try:
            cfg = json.load(open(p, encoding="utf-8"))
        except Exception:
            continue
        if isinstance(cfg, dict):
            targets.extend(targets_from_cfg(cfg))

seen = set()
final = []
for t in targets:
    api = t.get("api")
    if not api or api in seen:
        continue
    seen.add(api)
    final.append(t)


def fetch_token(api, app):
    try:
        req = urllib.request.Request(api + CONFIG_ENDPOINT)
        if app:
            req.add_header("X-Orchestra-App-Token", app)
        with urllib.request.urlopen(req, timeout=3) as r:
            return json.load(r).get("token", "")
    except Exception:
        return ""


for t in final:
    api = t["api"]
    tok = t["token"]
    app = t["app"]
    if not tok:
        tok = fetch_token(api, app)
    if not tok:
        continue
    body = payload
    if t["remote"]:
        try:
            d = json.loads(payload or "{}")
            if isinstance(d, dict):
                d["remote_host"] = t["remote"]
                body = json.dumps(d)
        except Exception:
            pass
    try:
        req = urllib.request.Request(api + ENDPOINT, data=(body or "").encode("utf-8"), method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header(HEADER, tok)
        if app:
            req.add_header("X-Orchestra-App-Token", app)
        urllib.request.urlopen(req, timeout=2).read()
    except Exception:
        pass
PY`;
}

module.exports = {
  buildHookForwarderBlock,
};
