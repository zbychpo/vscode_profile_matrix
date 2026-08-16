"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const path = __importStar(require("node:path"));
const vscode = __importStar(require("vscode"));
const defaultProfileId = '__default__';
const defaultProfileName = '既定';
function activate(context) {
    const provider = new MatrixViewProvider();
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(MatrixViewProvider.viewType, provider), vscode.commands.registerCommand('profileExtensionMatrix.open', () => vscode.commands.executeCommand('workbench.view.extension.profileExtensionMatrix')), vscode.commands.registerCommand('profileExtensionMatrix.refresh', () => provider.refresh()));
}
class MatrixViewProvider {
    static viewType = 'profileExtensionMatrix.matrixView';
    view;
    lastMatrix;
    resolveWebviewView(webviewView) {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.file(getGlobalExtensionsDirectory()),
                vscode.Uri.file(getProfilesDirectory())
            ]
        };
        webviewView.webview.html = getWebviewHtml(webviewView.webview);
        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (!isMessage(message)) {
                return;
            }
            if (message.type === 'refresh') {
                await this.refresh();
            }
            if (message.type === 'toggle') {
                await this.toggleExtension(message);
            }
            if (message.type === 'openExtension') {
                await vscode.commands.executeCommand('extension.open', message.extensionId);
            }
            if (message.type === 'ready' && this.lastMatrix) {
                webviewView.webview.postMessage({ type: 'data', data: this.toWebviewMatrix(this.lastMatrix) });
            }
            if (message.type === 'switchProfile') {
                await this.switchProfile();
            }
        });
        void this.refresh();
    }
    async refresh() {
        const data = await loadMatrix();
        this.lastMatrix = data;
        if (!this.view) {
            return;
        }
        this.view.webview.postMessage({ type: 'data', data: this.toWebviewMatrix(data) });
    }
    toWebviewMatrix(data) {
        if (!this.view) {
            return data;
        }
        const webview = this.view.webview;
        return {
            ...data,
            extensions: data.extensions.map((extension) => ({
                ...extension,
                iconUri: extension.iconUri && !extension.iconUri.startsWith('http')
                    ? webview.asWebviewUri(vscode.Uri.file(extension.iconUri)).toString()
                    : extension.iconUri
            }))
        };
    }
    async switchProfile() {
        try {
            await vscode.commands.executeCommand('workbench.profiles.actions.switchProfile');
            await this.refresh();
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`プロファイルを切り替えられませんでした: ${detail}`);
        }
    }
    async toggleExtension(message) {
        const verb = message.enabled ? '追加' : '削除';
        const confirmation = await vscode.window.showWarningMessage(`「${message.extensionId}」をプロファイル「${message.profileName}」に${verb}しますか？`, { modal: true }, verb);
        if (confirmation !== verb) {
            return;
        }
        try {
            await runCodeCli(message.profileName, message.extensionId, message.enabled);
            vscode.window.showInformationMessage(`「${message.extensionId}」を${verb}しました。`);
            await this.refresh();
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`拡張機能を${verb}できませんでした: ${detail}`);
        }
    }
}
async function loadMatrix() {
    try {
        const profilesDirectory = getProfilesDirectory();
        const names = await readProfileNames();
        const entries = await node_fs_1.promises.readdir(profilesDirectory, { withFileTypes: true });
        const customProfiles = await Promise.all(entries
            .filter((entry) => entry.isDirectory() && entry.name !== 'builtin')
            .map(async (entry) => ({
            id: entry.name,
            name: names.get(entry.name) ?? entry.name,
            cliName: names.get(entry.name) ?? entry.name,
            extensions: await readExtensionIds(path.join(profilesDirectory, entry.name, 'extensions.json'))
        })));
        const defaultProfile = {
            id: defaultProfileId,
            name: defaultProfileName,
            cliName: 'Default',
            extensions: await readDefaultExtensions()
        };
        const profiles = [defaultProfile, ...customProfiles];
        const extensions = new Map();
        for (const profile of profiles) {
            for (const extension of profile.extensions) {
                const existing = extensions.get(extension.id) ?? {
                    displayName: extension.displayName,
                    description: extension.description,
                    publisher: extension.publisher,
                    version: extension.version,
                    iconUri: extension.iconPath,
                    profileIds: []
                };
                existing.profileIds.push(profile.id);
                extensions.set(extension.id, existing);
            }
        }
        const extensionList = [...extensions].map(([id, extension]) => ({ id, ...extension }));
        await applyUpdateInfo(extensionList);
        return {
            profiles: profiles.map(({ id, name, cliName }) => ({ id, name, cliName })).sort((left, right) => left.name.localeCompare(right.name)),
            extensions: extensionList.sort((left, right) => left.displayName.localeCompare(right.displayName, 'ja'))
        };
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { profiles: [], extensions: [], error: `プロファイル情報を読み取れませんでした: ${detail}` };
    }
}
async function applyUpdateInfo(extensions) {
    if (!extensions.length) {
        return;
    }
    const [latestVersions, deprecatedIds] = await Promise.all([
        fetchLatestVersions(extensions.map((extension) => extension.id)).catch(() => new Map()),
        fetchDeprecatedIds().catch(() => new Set())
    ]);
    for (const extension of extensions) {
        extension.deprecated = deprecatedIds.has(extension.id.toLowerCase());
        const latest = latestVersions.get(extension.id.toLowerCase());
        if (extension.version && latest) {
            extension.latestVersion = latest;
            extension.hasUpdate = isNewerVersion(latest, extension.version);
        }
    }
}
function isNewerVersion(latest, installed) {
    return compareVersions(latest, installed) > 0;
}
async function fetchLatestVersions(ids) {
    const uniqueIds = [...new Set(ids.map((id) => id.toLowerCase()))];
    const response = await fetch('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json;api-version=3.0-preview.1'
        },
        body: JSON.stringify({
            filters: [{
                    criteria: uniqueIds.map((id) => ({ filterType: 7, value: id })),
                    pageNumber: 1,
                    pageSize: uniqueIds.length,
                    sortBy: 0,
                    sortOrder: 0
                }],
            // IncludeLatestVersionOnly (0x200)
            flags: 512
        })
    });
    if (!response.ok) {
        return new Map();
    }
    const payload = await response.json();
    const result = new Map();
    for (const extension of payload.results?.[0]?.extensions ?? []) {
        const publisherName = extension.publisher?.publisherName;
        const extensionName = extension.extensionName;
        const version = extension.versions
            ?.map((item) => item.version)
            .filter((item) => Boolean(item))
            .sort((left, right) => compareVersions(right, left))[0];
        if (publisherName && extensionName && version) {
            result.set(`${publisherName}.${extensionName}`.toLowerCase(), version);
        }
    }
    return result;
}
let deprecatedIdsCache;
// VS Code itself sources its "deprecated extension" warnings from this curated CDN file (not the gallery API).
async function fetchDeprecatedIds() {
    if (deprecatedIdsCache) {
        return deprecatedIdsCache;
    }
    const response = await fetch('https://main.vscode-cdn.net/extensions/marketplace.json');
    if (!response.ok) {
        return new Set();
    }
    const payload = await response.json();
    deprecatedIdsCache = new Set(Object.keys(payload.deprecated ?? {}).map((id) => id.toLowerCase()));
    return deprecatedIdsCache;
}
function getProfilesDirectory() {
    if (process.platform === 'win32') {
        if (!process.env.APPDATA) {
            throw new Error('APPDATA 環境変数がありません。');
        }
        return path.join(process.env.APPDATA, 'Code', 'User', 'profiles');
    }
    if (process.platform === 'darwin') {
        return path.join(process.env.HOME ?? '', 'Library', 'Application Support', 'Code', 'User', 'profiles');
    }
    return path.join(process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? '', '.config'), 'Code', 'User', 'profiles');
}
async function readProfileNames() {
    const syncDirectory = path.join(path.dirname(getProfilesDirectory()), 'sync', 'profiles');
    try {
        const entries = await node_fs_1.promises.readdir(syncDirectory, { withFileTypes: true });
        const syncFiles = entries
            .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
            .map((entry) => entry.name)
            .sort()
            .reverse();
        for (const syncFile of syncFiles) {
            const parsed = JSON.parse(await node_fs_1.promises.readFile(path.join(syncDirectory, syncFile), 'utf8'));
            const content = parsed.content ?? parsed.syncData?.content;
            if (typeof content !== 'string') {
                continue;
            }
            const records = findProfileRecords(JSON.parse(content));
            const names = new Map(records.filter(hasIdAndName).map((profile) => [profile.id, profile.name]));
            if (names.size > 0) {
                return names;
            }
        }
    }
    catch {
        // Fall back to directory IDs when profile sync data is unavailable.
    }
    return new Map();
}
function findProfileRecords(value) {
    if (Array.isArray(value)) {
        return value.flatMap(findProfileRecords);
    }
    if (!value || typeof value !== 'object') {
        return [];
    }
    const record = value;
    const own = typeof record.id === 'string' && typeof record.name === 'string'
        ? [{ id: record.id, name: record.name }]
        : [];
    return [...own, ...Object.values(record).flatMap(findProfileRecords)];
}
function hasIdAndName(profile) {
    return typeof profile.id === 'string' && typeof profile.name === 'string';
}
async function readExtensionIds(filePath) {
    try {
        const extensions = JSON.parse(await node_fs_1.promises.readFile(filePath, 'utf8'));
        return Promise.all(extensions.map(readExtensionInfo)).then((items) => items.filter((item) => item !== undefined));
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}
async function readExtensionInfo(extension) {
    const id = extension.identifier?.id;
    if (!id) {
        return undefined;
    }
    const scanned = await findInstalledManifest(id);
    if (scanned.version) {
        return { id, ...scanned };
    }
    const location = extension.location?.fsPath ?? extension.location?.path;
    if (!location) {
        return { id, ...scanned };
    }
    try {
        return { id, ...await readManifestInfo(toFilePath(location), id) };
    }
    catch {
        return { id, ...scanned };
    }
}
async function readDefaultExtensions() {
    const ids = await listExtensionsForProfile('Default');
    return Promise.all(ids.map(async (id) => ({ id, ...await findInstalledManifest(id) })));
}
function listExtensionsForProfile(profileName) {
    return runCodeCliCommand(['--profile', profileName, '--list-extensions'])
        .then((stdout) => stdout.split(/\r?\n/).map((id) => id.trim()).filter(Boolean));
}
function runCodeCli(profileName, extensionId, install) {
    const action = install ? '--install-extension' : '--uninstall-extension';
    return runCodeCliCommand(['--profile', profileName, action, extensionId]).then(() => undefined);
}
function runCodeCliCommand(args) {
    const invocation = getCodeCliInvocation();
    return new Promise((resolve, reject) => {
        (0, node_child_process_1.execFile)(invocation.command, [...invocation.commandArgs, ...args], { env: invocation.environment }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr.trim() || error.message));
                return;
            }
            resolve(stdout);
        });
    });
}
function getCodeCliInvocation() {
    if (process.platform === 'win32') {
        return {
            command: getWindowsCodeExecutablePath(),
            commandArgs: [getWindowsCodeCliScriptPath()],
            environment: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' }
        };
    }
    return {
        command: process.platform === 'darwin'
            ? path.resolve(vscode.env.appRoot, '..', '..', 'MacOS', 'Code')
            : path.resolve(vscode.env.appRoot, '..', '..', '..', 'code'),
        commandArgs: [path.join(vscode.env.appRoot, 'out', 'cli.js')],
        environment: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' }
    };
}
function getWindowsCodeExecutablePath() {
    return path.resolve(vscode.env.appRoot, '..', '..', '..', 'Code.exe');
}
function getWindowsCodeCliScriptPath() {
    return path.join(vscode.env.appRoot, 'out', 'cli.js');
}
function getGlobalExtensionsDirectory() {
    return path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.vscode', 'extensions');
}
async function findInstalledManifest(id) {
    const extensionsDirectory = getGlobalExtensionsDirectory();
    try {
        // Match "<id>-<version>" exactly so extensions with an overlapping id prefix (e.g. a "-british-english" variant) aren't picked up.
        const versionPattern = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+\\.\\d+\\.\\d+)`, 'i');
        const entries = await node_fs_1.promises.readdir(extensionsDirectory, { withFileTypes: true });
        const matchingDirectory = entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => ({ name: entry.name, version: versionPattern.exec(entry.name)?.[1] }))
            .filter((entry) => Boolean(entry.version))
            .sort((left, right) => compareVersions(right.version, left.version))[0];
        return matchingDirectory ? await readManifestInfo(path.join(extensionsDirectory, matchingDirectory.name), id) : { displayName: id };
    }
    catch {
        return { displayName: id };
    }
}
function compareVersions(left, right) {
    const toParts = (value) => value.split('.').map((part) => Number.parseInt(part, 10) || 0);
    const leftParts = toParts(left);
    const rightParts = toParts(right);
    for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
        const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
        if (diff !== 0) {
            return diff;
        }
    }
    return 0;
}
async function readManifestInfo(extensionDirectory, fallback) {
    const manifest = JSON.parse(await node_fs_1.promises.readFile(path.join(extensionDirectory, 'package.json'), 'utf8'));
    const translations = await readTranslations(extensionDirectory);
    const resolve = (value) => {
        if (!value) {
            return value;
        }
        const localizationKey = /^%(.+)%$/.exec(value)?.[1];
        return localizationKey ? translations[localizationKey] ?? undefined : value;
    };
    const iconPath = manifest.icon ? path.join(extensionDirectory, manifest.icon) : undefined;
    return {
        displayName: resolve(manifest.displayName ?? manifest.name) ?? fallback,
        description: resolve(manifest.description),
        publisher: manifest.publisher,
        version: manifest.version,
        iconPath: iconPath && await fileExists(iconPath) ? iconPath : undefined
    };
}
async function readTranslations(extensionDirectory) {
    try {
        return JSON.parse(await node_fs_1.promises.readFile(path.join(extensionDirectory, 'package.nls.json'), 'utf8'));
    }
    catch {
        return {};
    }
}
async function fileExists(filePath) {
    try {
        await node_fs_1.promises.access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
function toFilePath(location) {
    return process.platform === 'win32' ? location.replace(/^\/([A-Za-z]:)/, '$1') : location;
}
function isMessage(value) {
    if (!value || typeof value !== 'object' || !('type' in value)) {
        return false;
    }
    const message = value;
    return message.type === 'refresh' || message.type === 'ready' || (message.type === 'openExtension' && typeof message.extensionId === 'string') || (message.type === 'switchProfile' && typeof message.profileName === 'string') || (message.type === 'toggle' &&
        typeof message.profileId === 'string' &&
        typeof message.profileName === 'string' &&
        typeof message.extensionId === 'string' &&
        typeof message.enabled === 'boolean');
}
function getWebviewHtml(webview) {
    const nonce = createNonce();
    const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Profile Extension Matrix</title>
  <style>
    :root { color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 13px; background: var(--vscode-editor-background); }
    body { margin: 0; padding: 12px; background: var(--vscode-editor-background); color: var(--vscode-foreground); }
    .toolbar { display: flex; gap: 8px; margin-bottom: 10px; align-items: center; }
    .profile-header { background: transparent; color: var(--vscode-foreground); display: block; padding: 0; text-align: center; width: 100%; font-weight: 600; }
    .profile-header:hover { background: transparent; color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
    input { flex: 1; min-width: 0; min-height: 30px; padding: 6px 10px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 4px; font-size: 13px; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 4px; padding: 6px 10px; cursor: pointer; font-size: 12px; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .matrix { overflow: auto; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-editor-background); max-width: 100%; }
    table { border-collapse: collapse; table-layout: auto; width: 100%; min-width: 620px; font-size: 12px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); }
    th, td { border-bottom: 1px solid var(--vscode-panel-border); padding: 7px 8px; text-align: left; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    th { position: sticky; top: 0; background: var(--vscode-editorWidget-background); color: var(--vscode-editorWidget-foreground); z-index: 1; white-space: nowrap; font-weight: 600; }
    th:first-child, td:first-child { position: sticky; left: 0; background: var(--vscode-editor-background); width: min(42vw, 300px); min-width: 220px; z-index: 2; }
    th:first-child { z-index: 3; }
    th:not(:first-child) { text-align: center; }
    td:not(:first-child) { text-align: center; }
    .cell { background: rgba(255, 255, 255, 0.04); color: var(--vscode-foreground); display: inline-flex; align-items: center; justify-content: center; min-width: 30px; min-height: 24px; padding: 3px 7px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; font-weight: 700; }
    .cell.enabled { background: rgba(46, 204, 113, 0.14); color: var(--vscode-testing-iconPassed); border-color: rgba(46, 204, 113, 0.5); }
    .extension-row { align-items: flex-start; display: flex; gap: 8px; }
    .extension-icon { border-radius: 4px; flex: none; height: 32px; width: 32px; }
    .extension-icon.placeholder { background: var(--vscode-badge-background); }
    .extension-details { min-width: 0; }
    .extension-link { background: transparent; color: var(--vscode-textLink-foreground); display: block; overflow: hidden; padding: 0; text-align: left; text-overflow: ellipsis; white-space: nowrap; width: 100%; font-weight: 600; }
    .extension-link:hover { background: transparent; color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
    .extension-link.deprecated { text-decoration: line-through; }
    .deprecated-badge { background: var(--vscode-editorWarning-foreground); border-radius: 3px; color: var(--vscode-editor-background); font-size: 10px; margin-left: 4px; padding: 0 4px; font-weight: 700; }
    .extension-description { color: var(--vscode-descriptionForeground); display: block; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.95; }
    .extension-meta { color: var(--vscode-descriptionForeground); display: block; font-size: 11px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.95; }
    .extension-publisher { font-weight: 600; }
    .version-old { text-decoration: line-through; }
    .update-badge { background: var(--vscode-badge-background); border-radius: 3px; color: var(--vscode-badge-foreground); font-size: 10px; margin-left: 4px; padding: 1px 5px; font-weight: 600; }
    .message { color: var(--vscode-descriptionForeground); margin: 18px 0; }
    .error { color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <div class="toolbar"><input id="search" type="search" placeholder="拡張機能を検索"><button id="refresh" title="更新">更新</button></div>
  <div id="content" class="message">読み込み中...</div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let matrix = { profiles: [], extensions: [] };
    const content = document.getElementById('content');
    const search = document.getElementById('search');
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    search.addEventListener('input', render);
    window.addEventListener('message', (event) => {
      if (event.data.type === 'data') { matrix = event.data.data; render(); }
    });
    vscode.postMessage({ type: 'ready' });
    function escapeHtml(value) {
      return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
    }
    function render() {
      if (matrix.error) { content.innerHTML = '<p class="message error">' + escapeHtml(matrix.error) + '</p>'; return; }
      if (!matrix.profiles.length) { content.innerHTML = '<p class="message">カスタムプロファイルが見つかりません。</p>'; return; }
      const query = search.value.trim().toLowerCase();
    const extensions = matrix.extensions.filter((extension) => (extension.id + ' ' + extension.displayName).toLowerCase().includes(query));
    const columns = '<col style="width: 280px">' + matrix.profiles.map(() => '<col style="width: 132px">').join('');
    const header = matrix.profiles.map((profile) => '<th title="' + escapeHtml(profile.name) + '"><button class="profile-header" data-switch-profile="' + escapeHtml(profile.name) + '">' + escapeHtml(profile.name) + '</button></th>').join('');
      const rows = extensions.map((extension) => {
        const cells = matrix.profiles.map((profile) => {
          const enabled = extension.profileIds.includes(profile.id);
          const label = enabled ? '✓' : '+';
          const title = enabled ? 'このプロファイルから削除' : 'このプロファイルへ追加';
          return '<td><button class="cell ' + (enabled ? 'enabled' : '') + '" title="' + title + '" data-profile-id="' + escapeHtml(profile.id) + '" data-extension-id="' + escapeHtml(extension.id) + '" data-enabled="' + (!enabled) + '">' + label + '</button></td>';
        }).join('');
        const icon = extension.iconUri
          ? '<img class="extension-icon" src="' + escapeHtml(extension.iconUri) + '" alt="">'
          : '<div class="extension-icon placeholder"></div>';
        const description = extension.description
          ? '<span class="extension-description" title="' + escapeHtml(extension.description) + '">' + escapeHtml(extension.description) + '</span>'
          : '';
        const publisher = extension.publisher ? '<span class="extension-publisher">' + escapeHtml(extension.publisher) + '</span>' : '';
        const versionText = extension.version
          ? (extension.hasUpdate
              ? '<span class="version-old">v' + escapeHtml(extension.version) + '</span> \u2192 v' + escapeHtml(extension.latestVersion)
              : 'v' + escapeHtml(extension.version))
          : '';
                const updateBadge = extension.hasUpdate
                    ? '<span class="update-badge" title="更新があります">更新あり</span>'
          : '';
        const deprecatedBadge = extension.deprecated ? '<span class="deprecated-badge" title="この拡張機能は非推奨です">非推奨</span>' : '';
        const meta = [publisher, versionText].filter(Boolean).join(' \u00b7 ');
        const nameClass = extension.deprecated ? 'extension-link deprecated' : 'extension-link';
        return '<tr><td title="' + escapeHtml(extension.id) + '"><div class="extension-row">' + icon + '<div class="extension-details"><button class="' + nameClass + '" data-open-extension="' + escapeHtml(extension.id) + '">' + escapeHtml(extension.displayName) + '</button>' + deprecatedBadge + description + '<span class="extension-meta">' + meta + updateBadge + '</span></div></div></td>' + cells + '</tr>';
      }).join('');
                        content.innerHTML = '<div class="matrix"><table><colgroup>' + columns + '</colgroup><thead><tr><th>Extension</th>' + header + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
            content.querySelectorAll('[data-switch-profile]').forEach((button) => button.addEventListener('click', () => {
                vscode.postMessage({ type: 'switchProfile', profileName: button.dataset.switchProfile });
            }));
      content.querySelectorAll('.cell').forEach((button) => button.addEventListener('click', () => {
        const profile = matrix.profiles.find((item) => item.id === button.dataset.profileId);
        if (profile) vscode.postMessage({ type: 'toggle', profileId: profile.id, profileName: profile.cliName, extensionId: button.dataset.extensionId, enabled: button.dataset.enabled === 'true' });
      }));
    content.querySelectorAll('[data-open-extension]').forEach((button) => button.addEventListener('click', () => vscode.postMessage({ type: 'openExtension', extensionId: button.dataset.openExtension })));
    }
  </script>
</body>
</html>`;
}
function createNonce() {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}
//# sourceMappingURL=extension.js.map