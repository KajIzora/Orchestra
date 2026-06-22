const path = require('path');
const { ulid } = require('./ids');
const { assertValidSshHost } = require('./remote_cursor_tracker');

const VALID_WORKSPACE_ITEM_TYPES = new Set([
  'cursor_project',
  'chrome_page',
  'app_file',
  'obsidian_note',
  'desktop',
  'shell',
]);
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function escapeAppleScriptString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function workspaceItemId() {
  return `workspace_${ulid()}`;
}

function nonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} is required`);
  }
  return value.trim();
}

function optionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalLabel(raw) {
  const label = optionalString(raw?.label);
  return label ? { label } : {};
}

function normalizeLocalPath(value, fieldName = 'workspace_path') {
  const raw = nonEmptyString(value, fieldName);
  return path.resolve(raw);
}

function normalizeRemotePath(value, fieldName = 'workspace_path') {
  const raw = nonEmptyString(value, fieldName);
  if (!raw.startsWith('/')) throw new Error(`${fieldName} must be absolute`);
  return path.posix.normalize(raw);
}

function normalizeDesktop(value) {
  const desktop = Number(String(value || '').trim());
  if (!Number.isInteger(desktop) || desktop < 1 || desktop > 10) {
    throw new Error('desktop must be between 1 and 10');
  }
  return desktop;
}

function withWorkspaceMetadata(raw, normalized) {
  return {
    ...normalized,
    ...optionalLabel(raw),
    is_primary: !!raw.is_primary,
  };
}

function buildChromeOpenOrFocusCommand(url) {
  const targetUrl = nonEmptyString(url, 'url');
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
  const targetPath = nonEmptyString(workspacePath, 'workspace_path');
  if (source === 'ssh') {
    const host = assertValidSshHost(remoteHost);
    return `cursor --remote ssh-remote+${host} ${shellQuote(targetPath)}`;
  }
  return `cursor ${shellQuote(targetPath)}`;
}

function cursorWindowTitleMatch(workspacePath) {
  const trimmed = String(workspacePath || '').trim().replace(/[\\/]+$/, '');
  const segments = trimmed.split(/[\\/]/);
  return segments[segments.length - 1] || '';
}

function buildCursorFocusCommand(source, workspacePath, remoteHost) {
  const targetPath = nonEmptyString(workspacePath, 'workspace_path');
  const folderName = cursorWindowTitleMatch(targetPath);
  if (!folderName) throw new Error('workspace_path is required');
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

function buildOpenAppCommand(app, targetPath) {
  const appName = nonEmptyString(app, 'app');
  const target = optionalString(targetPath);
  const base = `open -a ${shellQuote(appName)}`;
  return target ? `${base} ${shellQuote(target)}` : base;
}

function buildOpenWindowCommand(desktop) {
  const desktopNumber = normalizeDesktop(desktop);
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
  return `osascript -e 'tell application "System Events" to key code ${keyCodesByDesktop[desktopNumber]} using control down'`;
}

function buildObsidianCommand(vault, notePath) {
  const safeVault = nonEmptyString(vault, 'vault');
  const safeNotePath = nonEmptyString(notePath, 'note_path');
  const url = `obsidian://open?vault=${encodeURIComponent(safeVault)}&file=${encodeURIComponent(safeNotePath)}`;
  return `open ${shellQuote(url)}`;
}

function normalizeWorkspaceItem(raw) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const type = typeof item.type === 'string' ? item.type.trim() : '';
  if (!VALID_WORKSPACE_ITEM_TYPES.has(type)) {
    throw new Error('workspace item type is invalid');
  }
  const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : workspaceItemId();

  if (type === 'cursor_project') {
    const source = item.source === 'ssh' ? 'ssh' : 'local';
    if (source === 'ssh') {
      return withWorkspaceMetadata(item, {
        id,
        type,
        source,
        remote_host: assertValidSshHost(item.remote_host),
        workspace_path: normalizeRemotePath(item.workspace_path),
      });
    }
    return withWorkspaceMetadata(item, {
      id,
      type,
      source,
      workspace_path: normalizeLocalPath(item.workspace_path),
    });
  }

  if (type === 'chrome_page') {
    return withWorkspaceMetadata(item, { id, type, url: nonEmptyString(item.url, 'url') });
  }

  if (type === 'app_file') {
    return withWorkspaceMetadata(item, {
      id,
      type,
      app: nonEmptyString(item.app, 'app'),
      target_path: optionalString(item.target_path),
    });
  }

  if (type === 'obsidian_note') {
    return withWorkspaceMetadata(item, {
      id,
      type,
      vault: nonEmptyString(item.vault, 'vault'),
      note_path: nonEmptyString(item.note_path, 'note_path'),
    });
  }

  if (type === 'desktop') {
    return withWorkspaceMetadata(item, { id, type, desktop: normalizeDesktop(item.desktop) });
  }

  return withWorkspaceMetadata(item, { id, type, command: nonEmptyString(item.command, 'command') });
}

function workspaceCommandToShellItem(command) {
  return {
    id: workspaceItemId(),
    type: 'shell',
    command,
    label: '',
    is_primary: false,
  };
}

function workspaceCommandExists(items, command) {
  const target = String(command || '').trim();
  if (!target) return true;
  return items.some((item) => {
    try {
      return buildWorkspaceItemCommand(item) === target;
    } catch {
      return item?.type === 'shell' && String(item.command || '').trim() === target;
    }
  });
}

function mergeWorkspaceCommands(rawItems, commands) {
  const items = Array.isArray(rawItems) ? [...rawItems] : [];
  for (const command of normalizeCommandList(commands)) {
    if (!workspaceCommandExists(items, command)) items.push(workspaceCommandToShellItem(command));
  }
  return items;
}

function normalizeCommandList(commands) {
  if (!Array.isArray(commands)) return [];
  return commands.filter((command) => typeof command === 'string').map((command) => command.trim()).filter(Boolean);
}

function normalizeWorkspaceItems(items) {
  if (!Array.isArray(items)) throw new Error('workspace_items must be an array');
  const normalized = items.map((item) => normalizeWorkspaceItem(item));
  let primaryIndex = -1;
  normalized.forEach((item, index) => {
    if (item.is_primary) primaryIndex = index;
  });
  return normalized.map((item, index) => ({ ...item, is_primary: index === primaryIndex }));
}

function workspaceCommandsToItems(commands) {
  if (!Array.isArray(commands)) return [];
  return commands
    .filter((command) => typeof command === 'string')
    .map((command) => command.trim())
    .filter(Boolean)
    .map((command) => workspaceCommandToShellItem(command));
}

function buildWorkspaceItemCommand(item) {
  const normalized = normalizeWorkspaceItem(item);
  if (normalized.type === 'cursor_project') {
    return buildCursorFocusCommand(normalized.source, normalized.workspace_path, normalized.remote_host);
  }
  if (normalized.type === 'chrome_page') return buildChromeOpenOrFocusCommand(normalized.url);
  if (normalized.type === 'app_file') return buildOpenAppCommand(normalized.app, normalized.target_path);
  if (normalized.type === 'obsidian_note') return buildObsidianCommand(normalized.vault, normalized.note_path);
  if (normalized.type === 'desktop') return buildOpenWindowCommand(normalized.desktop);
  return normalized.command;
}

function buildWorkspaceItemCommands(item) {
  const normalized = normalizeWorkspaceItem(item);
  return [buildWorkspaceItemCommand(normalized)];
}

function buildWorkspaceCommands(items) {
  const normalized = normalizeWorkspaceItems(items);
  const commands = normalized.flatMap((item) => buildWorkspaceItemCommands(item));
  const primary = normalized.find((item) => item.is_primary);
  if (primary) commands.push(buildWorkspaceItemCommand(primary));
  return commands;
}

function normalizeWorkspaceState(rawItems, rawCommands) {
  if (Array.isArray(rawItems)) {
    const workspace_items = normalizeWorkspaceItems(rawItems);
    return { workspace_items, workspace_commands: buildWorkspaceCommands(workspace_items) };
  }
  const workspace_items = workspaceCommandsToItems(rawCommands);
  return { workspace_items, workspace_commands: buildWorkspaceCommands(workspace_items) };
}

module.exports = {
  VALID_WORKSPACE_ITEM_TYPES,
  shellQuote,
  escapeAppleScriptString,
  buildChromeOpenOrFocusCommand,
  buildCursorProjectCommand,
  buildCursorFocusCommand,
  buildOpenAppCommand,
  buildOpenWindowCommand,
  buildObsidianCommand,
  buildWorkspaceItemCommand,
  buildWorkspaceItemCommands,
  buildWorkspaceCommands,
  normalizeWorkspaceItem,
  normalizeWorkspaceItems,
  normalizeWorkspaceState,
  mergeWorkspaceCommands,
  workspaceCommandsToItems,
  workspaceItemId,
};
