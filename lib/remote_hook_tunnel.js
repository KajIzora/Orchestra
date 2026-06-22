const path = require('path');
const { spawn } = require('child_process');

const DEV_REMOTE_TUNNEL_PORT = 48725;
const STABLE_REMOTE_TUNNEL_PORT = 48726;
const DEFAULT_MAX_PORT_ATTEMPTS = 20;
const DEFAULT_READY_TIMEOUT_MS = 500;
const DEFAULT_RESTART_DELAY_MS = 1000;

function isStableInstance({ dataDir = process.env.ORCHESTRA_DATA_DIR, localPort } = {}) {
  const normalized = typeof dataDir === 'string' ? dataDir.trim() : '';
  if (normalized) {
    const parts = path.normalize(normalized).split(path.sep).filter(Boolean);
    if (parts.length >= 2 && parts[parts.length - 2] === '.orchestra' && parts[parts.length - 1] === 'stable') {
      return true;
    }
  }
  return Number(localPort) === 47824;
}

function preferredRemoteTunnelPort(opts = {}) {
  return isStableInstance(opts) ? STABLE_REMOTE_TUNNEL_PORT : DEV_REMOTE_TUNNEL_PORT;
}

function normalizePort(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) return null;
  return n;
}

function buildReverseTunnelArgs({ host, remotePort, localHost = '127.0.0.1', localPort }) {
  const rp = normalizePort(remotePort);
  const lp = normalizePort(localPort);
  if (!host || typeof host !== 'string') throw new Error('Remote host is required');
  if (!rp) throw new Error('Remote tunnel port is invalid');
  if (!lp) throw new Error('Local port is invalid');
  return [
    '-N',
    '-T',
    '-S',
    'none',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=2',
    '-R',
    `127.0.0.1:${rp}:${localHost}:${lp}`,
    host,
  ];
}

function waitForTunnelReady(child, readyTimeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = '';
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      if (child.stderr) child.stderr.removeListener('data', onStderr);
      if (err) reject(err);
      else resolve();
    };
    const onStderr = (chunk) => {
      stderr += String(chunk || '');
    };
    const onError = (err) => finish(err);
    const onExit = (code, signal) => {
      const suffix = stderr.trim() ? `: ${stderr.trim()}` : '';
      finish(new Error(`ssh tunnel exited before ready (code=${code ?? 'null'}, signal=${signal || 'none'})${suffix}`));
    };
    if (child.stderr) child.stderr.on('data', onStderr);
    child.once('error', onError);
    child.once('exit', onExit);
    const timer = setTimeout(() => finish(null), readyTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

class RemoteHookTunnelManager {
  constructor(options = {}) {
    this.spawnImpl = options.spawnImpl || spawn;
    this.localHost = options.localHost || '127.0.0.1';
    this.localPort = normalizePort(options.localPort);
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.restartDelayMs = options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
    this.maxPortAttempts = options.maxPortAttempts ?? DEFAULT_MAX_PORT_ATTEMPTS;
    this.logger = options.logger || console;
    this.tunnels = new Map();
  }

  key(host, remotePort) {
    return `${host}\0${remotePort}`;
  }

  get(host, remotePort) {
    const tunnel = this.tunnels.get(this.key(host, remotePort));
    if (!tunnel || tunnel.stopped || !tunnel.child || tunnel.child.killed) return null;
    return tunnel;
  }

  status(host, remotePort) {
    const tunnel = this.get(host, remotePort);
    if (!tunnel) return null;
    return this.publicStatus(tunnel);
  }

  publicStatus(tunnel) {
    return {
      host: tunnel.host,
      local_port: tunnel.localPort,
      remote_port: tunnel.remotePort,
      api_base: tunnel.apiBase,
      running: !tunnel.stopped && !!tunnel.child && !tunnel.child.killed,
      error: tunnel.error || null,
    };
  }

  candidatePorts({ preferredRemotePort, storedRemotePort }) {
    const preferred = normalizePort(preferredRemotePort) || preferredRemoteTunnelPort({ localPort: this.localPort });
    const stored = normalizePort(storedRemotePort);
    const ports = [];
    if (stored) ports.push(stored);
    for (let i = 0; i < this.maxPortAttempts; i += 1) ports.push(preferred + i);
    return [...new Set(ports.filter((p) => p <= 65535))];
  }

  async ensureTunnel({ host, preferredRemotePort, storedRemotePort }) {
    if (!this.localPort) throw new Error('Local port is required for remote hook tunnel');
    const ports = this.candidatePorts({ preferredRemotePort, storedRemotePort });
    let lastError = null;
    for (const remotePort of ports) {
      const existing = this.get(host, remotePort);
      if (existing) return this.publicStatus(existing);
      try {
        const tunnel = await this.startTunnel(host, remotePort);
        return this.publicStatus(tunnel);
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(
      `Could not open reverse SSH tunnel to ${host} on ports ${ports[0]}-${ports[ports.length - 1]}: ${
        lastError?.message || 'unknown error'
      }`
    );
  }

  async startTunnel(host, remotePort) {
    const args = buildReverseTunnelArgs({
      host,
      remotePort,
      localHost: this.localHost,
      localPort: this.localPort,
    });
    const child = this.spawnImpl('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const tunnel = {
      host,
      remotePort,
      localPort: this.localPort,
      apiBase: `http://127.0.0.1:${remotePort}`,
      child,
      args,
      ready: false,
      stopped: false,
      error: null,
    };
    const key = this.key(host, remotePort);
    this.tunnels.set(key, tunnel);

    child.on('exit', (code, signal) => {
      if (tunnel.stopped) return;
      tunnel.error = `ssh tunnel exited (code=${code ?? 'null'}, signal=${signal || 'none'})`;
      this.tunnels.delete(key);
      if (!tunnel.ready) return;
      this.logger.warn?.(`[remote-hooks] ${tunnel.error}; restarting`);
      const timer = setTimeout(() => {
        this.startTunnel(host, remotePort).catch((err) => {
          this.logger.warn?.(`[remote-hooks] tunnel restart failed for ${host}:${remotePort}: ${err.message}`);
        });
      }, this.restartDelayMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    child.on('error', (err) => {
      tunnel.error = err.message || String(err);
      this.tunnels.delete(key);
    });

    try {
      await waitForTunnelReady(child, this.readyTimeoutMs);
      tunnel.ready = true;
      return tunnel;
    } catch (err) {
      tunnel.stopped = true;
      tunnel.error = err.message || String(err);
      this.tunnels.delete(key);
      if (typeof child.kill === 'function' && !child.killed) child.kill();
      throw err;
    }
  }

  stopAll() {
    for (const tunnel of this.tunnels.values()) {
      tunnel.stopped = true;
      if (tunnel.child && typeof tunnel.child.kill === 'function' && !tunnel.child.killed) {
        tunnel.child.kill();
      }
    }
    this.tunnels.clear();
  }
}

function createRemoteHookTunnelManager(options = {}) {
  return new RemoteHookTunnelManager(options);
}

module.exports = {
  DEV_REMOTE_TUNNEL_PORT,
  STABLE_REMOTE_TUNNEL_PORT,
  DEFAULT_MAX_PORT_ATTEMPTS,
  RemoteHookTunnelManager,
  buildReverseTunnelArgs,
  createRemoteHookTunnelManager,
  isStableInstance,
  preferredRemoteTunnelPort,
};
