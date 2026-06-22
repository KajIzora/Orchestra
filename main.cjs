const { app, BrowserWindow, dialog, Tray, Menu, nativeImage, MenuItem } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const {
  getProjectTrayItems,
  getMenuBarProjects,
} = require(path.join(__dirname, '..', 'lib', 'tray_state.js'));
const { readRuntimeEnv } = require(path.join(__dirname, '..', 'lib', 'runtime_env.js'));
const PACKAGED_RUNTIME_ENV_FILE = path.join('build', 'runtime-env.json');

/** Apply baked stable profile before resolving data paths (module load runs before spawn env). */
function applyPackagedRuntimeEnvEarly() {
  if (!app.isPackaged) return;
  const runtimeEnv = readRuntimeEnv(path.join(app.getAppPath(), PACKAGED_RUNTIME_ENV_FILE));
  for (const [key, value] of Object.entries(runtimeEnv)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

applyPackagedRuntimeEnvEarly();

const {
  resolveDataDir,
  configFilePath,
  electronDesktopLogPath,
} = require(path.join(__dirname, '..', 'lib', 'data_dir.js'));

const CONFIG_DIR = resolveDataDir();
const CONFIG_FILE = configFilePath();
const DESKTOP_LOG = electronDesktopLogPath();

function logDesktop(line) {
  const msg = `[${new Date().toISOString()}] ${line}\n`;
  try {
    fs.appendFileSync(DESKTOP_LOG, msg, 'utf8');
  } catch {
    /* ignore */
  }
}
const READY_TIMEOUT_MS = 20_000;
const POLL_MS = 300;

/** Project root: repo root in dev; app.asar root when packaged. */
function getProjectRoot() {
  if (app.isPackaged) {
    return app.getAppPath();
  }
  return path.join(__dirname, '..');
}

/** Child processes need a real directory, not the app.asar archive. */
function getServerCwd(projectRoot) {
  if (app.isPackaged) {
    return path.dirname(projectRoot);
  }
  return projectRoot;
}

function readPackagedRuntimeEnv(projectRoot) {
  if (!app.isPackaged) return {};
  const runtimeEnv = readRuntimeEnv(path.join(projectRoot, PACKAGED_RUNTIME_ENV_FILE));
  const keys = Object.keys(runtimeEnv);
  if (keys.length) logDesktop(`loaded packaged runtime env keys=${keys.join(',')}`);
  return runtimeEnv;
}

function readConfigPort() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const cfg = JSON.parse(raw);
    const port = parseInt(cfg.port, 10);
    if (Number.isFinite(port) && port > 0) return port;
  } catch {
    /* missing or invalid */
  }
  return null;
}

/** Packaged stable app bakes PORT (e.g. 47824); do not attach to another instance on 47823. */
function readExpectedPort(projectRoot) {
  const packaged = readPackagedRuntimeEnv(projectRoot);
  const fromPackaged = parseInt(packaged.PORT, 10);
  if (Number.isFinite(fromPackaged) && fromPackaged > 0) return fromPackaged;
  const fromEnv = parseInt(process.env.PORT, 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return null;
}

function probeApiState(port) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/state',
        timeout: 2000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServerReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeApiState(port)) return true;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return false;
}

/**
 * @param {number} port
 * @param {string} pathname
 * @param {{ method?: string, bodyObj?: object|null, timeoutMs?: number }} [opts]
 * @returns {Promise<any>}
 */
function httpRequestJson(port, pathname, opts = {}) {
  const method = opts.method || 'GET';
  const bodyObj = opts.bodyObj;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const payload = bodyObj != null ? JSON.stringify(bodyObj) : null;

  return new Promise((resolve, reject) => {
    const requestOpts = {
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      timeout: timeoutMs,
    };
    if (payload) {
      requestOpts.headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    }

    const req = http.request(requestOpts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = data ? JSON.parse(data) : null;
        } catch (err) {
          reject(new Error(`Invalid JSON from ${method} ${pathname}: ${err.message}`));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const msg = (parsed && parsed.error) || data || res.statusMessage;
          reject(new Error(`HTTP ${res.statusCode} ${pathname}: ${msg}`));
          return;
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`request timeout: ${method} ${pathname}`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function fetchTrackerState(port) {
  return httpRequestJson(port, '/api/state', { method: 'GET' });
}

function postProjectFocus(port, projectId) {
  const pathEnc = `/api/projects/${encodeURIComponent(projectId)}/focus`;
  return httpRequestJson(port, pathEnc, { method: 'POST', bodyObj: {} });
}

function postTaskFocus(port, projectId, taskId) {
  const pathEnc = `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/focus`;
  return httpRequestJson(port, pathEnc, { method: 'POST', bodyObj: {} });
}

function taskHasFocusCommands(task) {
  return !!task?.id && Array.isArray(task.focus_commands) && task.focus_commands.some((command) => typeof command === 'string' && command.trim());
}

function postTrayItemFocus(port, project, task) {
  if (taskHasFocusCommands(task)) {
    return postTaskFocus(port, project.id, task.id);
  }
  return postProjectFocus(port, project.id);
}

/**
 * If config lists a port and /api/state responds, use it (browser or prior desktop session).
 * Otherwise spawn server.js with ELECTRON_RUN_AS_NODE so packaged app does not need system `node`.
 */
function ensureServerReady() {
  return new Promise((resolve, reject) => {
    const projectRoot = getProjectRoot();
    const serverJs = path.join(projectRoot, 'server.js');

    if (!fs.existsSync(serverJs)) {
      reject(new Error(`server.js not found at ${serverJs}`));
      return;
    }

    const expectedPort = readExpectedPort(projectRoot);

    const tryExisting = async () => {
      const fromFile = readConfigPort();
      if (fromFile == null) return null;
      if (expectedPort != null && fromFile !== expectedPort) {
        logDesktop(
          `skip attach: config port ${fromFile} != expected ${expectedPort} (another Orchestra instance may be running)`
        );
        return null;
      }
      if (await probeApiState(fromFile)) {
        return { port: fromFile, spawned: false, child: null };
      }
      return null;
    };

    tryExisting().then(async (existing) => {
      if (existing) {
        resolve(existing);
        return;
      }

      const env = {
        ...readPackagedRuntimeEnv(projectRoot),
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      };
      if (expectedPort != null) env.PORT = String(expectedPort);
      // Avoid pipe backpressure: a blocked stdout/stderr can prevent the server from finishing startup.
      let child;
      try {
        child = spawn(process.execPath, [serverJs], {
          cwd: getServerCwd(projectRoot),
          env,
          stdio: 'ignore',
        });
      } catch (err) {
        reject(err);
        return;
      }

      child.on('error', (err) => {
        reject(err);
      });

      const deadline = Date.now() + READY_TIMEOUT_MS;
      const portsToProbe = () => {
        const seen = new Set();
        const add = (p) => {
          if (Number.isFinite(p) && p > 0 && !seen.has(p)) {
            seen.add(p);
            return p;
          }
          return null;
        };
        const list = [];
        const fromConfig = readConfigPort();
        if (fromConfig != null) list.push(fromConfig);
        if (expectedPort != null) {
          for (let p = expectedPort; p <= expectedPort + 8; p += 1) {
            if (add(p)) list.push(p);
          }
        }
        return list;
      };

      const poll = async () => {
        if (Date.now() >= deadline) {
          try {
            child.kill('SIGTERM');
          } catch {
            /* ignore */
          }
          const portHint =
            expectedPort != null
              ? `expected port ${expectedPort} (see ${CONFIG_FILE})`
              : `see ${CONFIG_FILE}`;
          reject(
            new Error(
              `Backend did not become ready within ${READY_TIMEOUT_MS / 1000}s. Quit other Orchestra instances or free the port — ${portHint}. Log: ${DESKTOP_LOG}`
            )
          );
          return;
        }

        for (const port of portsToProbe()) {
          if (await probeApiState(port)) {
            resolve({ port, spawned: true, child });
            return;
          }
        }

        if (child.exitCode != null || child.signalCode != null) {
          reject(
            new Error(
              `Server process exited (${child.exitCode ?? child.signalCode}). See ${DESKTOP_LOG}`
            )
          );
          return;
        }

        setTimeout(poll, POLL_MS);
      };

      poll();
    });
  });
}

let mainWindow = null;
let serverChild = null;
/** @type {Tray | null} */
let tray = null;
let backendPort = null;
let serverShutdownStarted = false;
const TRAY_STATUS_RANK = {
  needs_input: 0,
  done: 1,
  waiting: 2,
  watching: 3,
  todo: 4,
  none: 5,
};

/** PIDs listening on the given TCP port (macOS). Empty on any failure. */
function findServerPidsOnPort(port) {
  if (!port) return [];
  try {
    const out = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    return [
      ...new Set(
        out
          .split('\n')
          .map((line) => parseInt(line.trim(), 10))
          .filter((pid) => Number.isFinite(pid) && pid > 0)
      ),
    ];
  } catch {
    return [];
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tear down the backend server on quit so it never outlives the GUI.
 * Always kills a server we spawned; when packaged, also reclaims a server we
 * merely attached to (the stable orphan case, where serverChild is null).
 * SIGTERM first, then SIGKILL for a wedged server that ignores graceful exit.
 */
async function shutdownServer() {
  const pids = new Set();
  if (serverChild && serverChild.pid && !serverChild.killed) pids.add(serverChild.pid);
  if (app.isPackaged) {
    for (const pid of findServerPidsOnPort(backendPort)) pids.add(pid);
  }
  if (!pids.size) return;
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (![...pids].some((pid) => pidAlive(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const pid of pids) {
    if (!pidAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

function getTrayIcon() {
  const iconPath = path.join(getProjectRoot(), 'assets', 'orchestra_tray_template.png');
  if (fs.existsSync(iconPath)) {
    const image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) {
      if (process.platform === 'darwin') image.setTemplateImage(true);
      return image;
    }
  }
  if (process.platform === 'darwin') {
    try {
      const image = nativeImage.createFromNamedImage('NSTouchBarComposeTemplate', []);
      if (!image.isEmpty()) return image;
    } catch {
      /* ignore */
    }
  }
  return nativeImage.createFromPath(iconPath);
}

function showOrCreateMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  if (backendPort == null) return;
  createWindow(`http://127.0.0.1:${backendPort}`);
}

/**
 * @param {number} port
 */
function createTray(port) {
  backendPort = port;
  if (tray) {
    tray.setToolTip('Orchestra');
    return;
  }

  const icon = getTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('Orchestra');

  const showTrayMenu = async () => {
    let state;
    try {
      state = await fetchTrackerState(port);
    } catch (err) {
      logDesktop(`tray fetch state failed: ${err.message}`);
      const errMenu = Menu.buildFromTemplate([
        { label: 'Could not load projects', enabled: false },
        { type: 'separator' },
        { label: 'Open Tracker', click: () => showOrCreateMainWindow() },
        { label: 'Quit', click: () => app.quit() },
      ]);
      tray.popUpContextMenu(errMenu);
      return;
    }

    const projects = getMenuBarProjects(state.projects);
    const sorted = [...projects].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    /** @type {Electron.MenuItemConstructorOptions[]} */
    const projectItems = sorted.flatMap((p) =>
      getProjectTrayItems(p, { statusDots: true }).map(({ label, status, task }) => ({
        label,
        status,
        click: async () => {
          try {
            const result = await postTrayItemFocus(port, p, task);
            if (!result.ok) {
              logDesktop(`focus failed project=${p.id} task=${task?.id || ''}: ${result.error || 'unknown'}`);
            }
          } catch (e) {
            logDesktop(`focus request failed project=${p.id} task=${task?.id || ''}: ${e.message}`);
          }
        },
      }))
    );

    projectItems.sort((a, b) => {
      return (TRAY_STATUS_RANK[a.status] ?? 99) - (TRAY_STATUS_RANK[b.status] ?? 99);
    });

    if (projectItems.length === 0) {
      projectItems.push({ label: 'No active projects', enabled: false });
    }

    const menu = Menu.buildFromTemplate([
      ...projectItems,
      { type: 'separator' },
      { label: 'Open Tracker', click: () => showOrCreateMainWindow() },
      { label: 'Quit Orchestra', click: () => app.quit() },
    ]);
    tray.popUpContextMenu(menu);
  };

  tray.on('click', () => {
    showTrayMenu().catch((err) => logDesktop(`tray click: ${err.message}`));
  });
  tray.on('right-click', () => {
    showTrayMenu().catch((err) => logDesktop(`tray right-click: ${err.message}`));
  });
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: true,
    },
  });

  let shown = false;
  const showWhenReady = () => {
    if (shown || !mainWindow || mainWindow.isDestroyed()) return;
    shown = true;
    mainWindow.show();
    mainWindow.focus();
  };
  mainWindow.once('ready-to-show', showWhenReady);
  mainWindow.webContents.once('did-finish-load', showWhenReady);

  const sendSpellcheckContextMenuState = (open) => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    mainWindow.webContents.send('orchestra-spellcheck-menu-state', { open });
  };

  mainWindow.webContents.on('context-menu', (_event, params) => {
    const menu = new Menu();
    const suggestions = Array.isArray(params.dictionarySuggestions) ? params.dictionarySuggestions : [];

    for (const suggestion of suggestions) {
      menu.append(new MenuItem({
        label: suggestion,
        click: () => mainWindow.webContents.replaceMisspelling(suggestion)
      }));
    }

    // Allow users to add the misspelled word to the dictionary
    if (params.misspelledWord) {
      menu.append(
        new MenuItem({
          label: 'Add to dictionary',
          click: () => mainWindow.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
        })
      );
    }

    // Allow users to perform standard text editing options
    if (params.isEditable) {
      if (suggestions.length > 0 || params.misspelledWord) {
        menu.append(new MenuItem({ type: 'separator' }));
      }
      menu.append(new MenuItem({ role: 'undo' }));
      menu.append(new MenuItem({ role: 'redo' }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ role: 'cut' }));
      menu.append(new MenuItem({ role: 'copy' }));
      menu.append(new MenuItem({ role: 'paste' }));
      menu.append(new MenuItem({ role: 'selectAll' }));
    } else if (params.selectionText) {
      menu.append(new MenuItem({ role: 'copy' }));
    }

    if (menu.items.length > 0) {
      if (params.isEditable) sendSpellcheckContextMenuState(true);
      menu.popup({
        window: mainWindow,
        callback: () => {
          if (params.isEditable) sendSpellcheckContextMenuState(false);
        },
      });
    }
  });

  mainWindow.webContents.on(
    'did-fail-load',
    (_event, code, desc, urlFailed, isMainFrame) => {
      if (!isMainFrame) return;
      logDesktop(`did-fail-load code=${code} desc=${desc} url=${urlFailed}`);
      dialog.showErrorBox(
        'Orchestra',
        `Could not load the app page (${code}: ${desc}).\nURL: ${urlFailed}\n\nDetails: ${DESKTOP_LOG}`
      );
    }
  );

  mainWindow.loadURL(url);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function startup() {
  try {
    logDesktop(`startup packaged=${app.isPackaged} appPath=${app.getAppPath()}`);
    const { port, spawned, child } = await ensureServerReady();
    if (spawned) serverChild = child;
    logDesktop(`server ready port=${port} spawned=${spawned}`);
    const url = `http://127.0.0.1:${port}`;
    createTray(port);
    createWindow(url);
  } catch (err) {
    console.error('[electron] startup failed:', err);
    logDesktop(`startup failed: ${err.message || err}`);
    await dialog.showErrorBox(
      'Orchestra',
      err.message || String(err)
    );
    app.quit();
  }
}

app.whenReady().then(() => {
  startup();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null && app.isReady()) {
    startup().catch(console.error);
  }
});

app.on('before-quit', (event) => {
  if (serverShutdownStarted) return;
  serverShutdownStarted = true;
  // Defer the actual quit until the server is gone, so it never lingers
  // listening on the port and gets re-attached to on the next launch.
  event.preventDefault();
  logDesktop('before-quit: shutting down backend server');
  shutdownServer()
    .catch((err) => logDesktop(`server shutdown error: ${err.message || err}`))
    .finally(() => app.exit(0));
});
