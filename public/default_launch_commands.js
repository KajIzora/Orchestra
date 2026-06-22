(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DefaultLaunchCommands = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
  }

  function escapeAppleScriptString(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function buildFocusChromeWebPageCommand(url) {
    const targetUrl = String(url || '').trim();
    if (!targetUrl) throw new Error('URL is required');
    const safeUrl = escapeAppleScriptString(targetUrl);
    return [
      `osascript -e 'set targetURL to "${safeUrl}"'`,
      "-e 'tell application \"Google Chrome\"'",
      "-e 'activate'",
      "-e 'set didFind to false'",
      "-e 'repeat with w in windows'",
      "-e 'repeat with i from 1 to (count of tabs of w)'",
      "-e 'set u to URL of tab i of w'",
      "-e 'if u starts with targetURL then set active tab index of w to i'",
      "-e 'if u starts with targetURL then set index of w to 1'",
      "-e 'if u starts with targetURL then set didFind to true'",
      "-e 'if didFind then exit repeat'",
      "-e 'end repeat'",
      "-e 'if didFind then exit repeat'",
      "-e 'end repeat'",
      "-e 'end tell'",
    ].join(' ');
  }

  function buildChromeOpenOrFocusCommand(url) {
    const targetUrl = String(url || '').trim();
    if (!targetUrl) throw new Error('URL is required');
    const safeUrl = escapeAppleScriptString(targetUrl);
    return [
      `osascript -e 'set targetURL to "${safeUrl}"'`,
      "-e 'tell application \"Google Chrome\"'",
      "-e 'activate'",
      "-e 'set didFind to false'",
      "-e 'repeat with w in windows'",
      "-e 'repeat with i from 1 to (count of tabs of w)'",
      "-e 'set u to URL of tab i of w'",
      "-e 'if u starts with targetURL then set active tab index of w to i'",
      "-e 'if u starts with targetURL then set index of w to 1'",
      "-e 'if u starts with targetURL then set didFind to true'",
      "-e 'if didFind then exit repeat'",
      "-e 'end repeat'",
      "-e 'if didFind then exit repeat'",
      "-e 'end repeat'",
      "-e 'if not didFind then'",
      "-e 'if (count of windows) = 0 then'",
      "-e 'set newWindow to make new window'",
      "-e 'set URL of active tab of newWindow to targetURL'",
      "-e 'set index of newWindow to 1'",
      "-e 'else'",
      "-e 'tell window 1 to make new tab with properties {URL:targetURL}'",
      "-e 'set active tab index of window 1 to (count of tabs of window 1)'",
      "-e 'set index of window 1 to 1'",
      "-e 'end if'",
      "-e 'end if'",
      "-e 'end tell'",
    ].join(' ');
  }

  function buildCursorProjectCommand(source, workspacePath, remoteHost) {
    const path = String(workspacePath || '').trim();
    if (!path) throw new Error('Workspace path is required');
    if (source === 'ssh') {
      const host = String(remoteHost || '').trim();
      if (!host) throw new Error('Remote host is required');
      return `cursor --remote ssh-remote+${host} ${shellQuote(path)}`;
    }
    return `cursor ${shellQuote(path)}`;
  }

  function cursorWindowTitleMatch(workspacePath) {
    const trimmed = String(workspacePath || '').trim().replace(/[\\/]+$/, '');
    const segments = trimmed.split(/[\\/]/);
    return segments[segments.length - 1] || '';
  }

  // Focus a Cursor project by raising only its window (AXRaise) instead of
  // activating the whole Cursor app — which would drag every other Cursor
  // window forward. Falls back to opening the folder when no matching window
  // is already open. Needs Accessibility permission for the app running it.
  //
  // Cursor titles windows "<active file> — <folder>", so we match the folder
  // name at the *end* of the title (its root-name segment), not anywhere in it.
  // A loose "contains" match would also hit unrelated windows whose open file
  // name happens to include the folder name (e.g. focusing "flow-matching"
  // would wrongly match a window editing "flow-matching-ot.gif").
  function buildCursorFocusCommand(source, workspacePath, remoteHost) {
    const targetPath = String(workspacePath || '').trim();
    if (!targetPath) throw new Error('Workspace path is required');
    const folderName = cursorWindowTitleMatch(targetPath);
    if (!folderName) throw new Error('Workspace path is required');
    const titleMatch = escapeAppleScriptString(folderName);
    const openCommand = buildCursorProjectCommand(source, targetPath, remoteHost);
    const raiseScript = [
      'osascript',
      "-e 'tell application \"System Events\"'",
      "-e 'if exists process \"Cursor\" then'",
      "-e 'tell process \"Cursor\"'",
      `-e 'set theWindows to (every window whose title ends with "${titleMatch}")'`,
      "-e 'if (count of theWindows) > 0 then'",
      "-e 'perform action \"AXRaise\" of (item 1 of theWindows)'",
      "-e 'return \"raised\"'",
      "-e 'end if'",
      "-e 'end tell'",
      "-e 'end if'",
      "-e 'end tell'",
      "-e 'return \"missing\"'",
    ].join(' ');
    return `[ "$(${raiseScript})" = raised ] || ${openCommand}`;
  }

  function buildFocusRemoteCursorCommand(remote, projectFolder) {
    const host = String(remote || '').trim();
    const folder = String(projectFolder || '').trim();
    if (!host) throw new Error('Remote is required');
    if (!folder) throw new Error('Project folder is required');
    return `cursor --remote ssh-remote+${host} ${shellQuote(folder)}`;
  }

  function buildOpenAppCommand(app, targetPath) {
    const appName = String(app || '').trim();
    if (!appName) throw new Error('App is required');
    const target = String(targetPath || '').trim();
    if (/^cursor$/i.test(appName) && target) return buildCursorProjectCommand('local', target);
    const base = `open -a ${shellQuote(appName)}`;
    return target ? `${base} ${shellQuote(target)}` : base;
  }

  function buildOpenWindowCommand(desktop) {
    const desktopNumber = Number(String(desktop || '').trim());
    const keyCodesByDesktop = {
      1: 18,
      2: 19,
      3: 20,
      4: 21,
      5: 23,
      6: 22,
      7: 26,
      8: 28,
      9: 25,
      10: 31,
    };
    const keyCode = keyCodesByDesktop[desktopNumber];
    if (!keyCode) throw new Error('Desktop must be between 1 and 10');
    return `osascript -e 'tell application "System Events" to key code ${keyCode} using control down'`;
  }

  function buildObsidianCommand(vault, notePath) {
    const vaultName = String(vault || '').trim();
    const note = String(notePath || '').trim();
    if (!vaultName) throw new Error('Vault is required');
    if (!note) throw new Error('Note path is required');
    const url = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(note)}`;
    return `open ${shellQuote(url)}`;
  }

  function buildWorkspaceItemCommand(item) {
    const type = item && item.type;
    if (type === 'cursor_project') {
      return buildCursorFocusCommand(item.source, item.workspace_path, item.remote_host);
    }
    if (type === 'chrome_page') return buildChromeOpenOrFocusCommand(item.url);
    if (type === 'app_file') return buildOpenAppCommand(item.app, item.target_path);
    if (type === 'obsidian_note') return buildObsidianCommand(item.vault, item.note_path);
    if (type === 'desktop') return buildOpenWindowCommand(item.desktop);
    if (type === 'shell') {
      const command = String(item.command || '').trim();
      if (!command) throw new Error('Command is required');
      return command;
    }
    throw new Error('Unknown workspace item type');
  }

  function buildWorkspaceItemCommands(item) {
    return [buildWorkspaceItemCommand(item)];
  }

  function buildDefaultLaunchCommand(preset, values) {
    if (preset === 'focus_chrome') return buildFocusChromeWebPageCommand(values.url);
    if (preset === 'focus_cursor') return buildCursorFocusCommand('local', values.project_folder);
    if (preset === 'focus_remote_cursor') {
      return buildCursorFocusCommand('ssh', values.project_folder, values.remote);
    }
    if (preset === 'open_app') return buildOpenAppCommand(values.app, values.target_path);
    if (preset === 'open_window') return buildOpenWindowCommand(values.desktop);
    throw new Error('Unknown launch preset');
  }

  return {
    shellQuote,
    escapeAppleScriptString,
    buildFocusChromeWebPageCommand,
    buildChromeOpenOrFocusCommand,
    buildCursorProjectCommand,
    buildCursorFocusCommand,
    buildFocusRemoteCursorCommand,
    buildOpenAppCommand,
    buildOpenWindowCommand,
    buildObsidianCommand,
    buildWorkspaceItemCommand,
    buildWorkspaceItemCommands,
    buildDefaultLaunchCommand,
  };
});
