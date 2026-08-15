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
                vscode.Uri.file(path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.vscode', 'extensions')),
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
            if (message.type === 'update') {
                await this.updateExtension(message.extensionId);
            }
            if (message.type === 'ready' && this.lastMatrix) {
                webviewView.webview.postMessage({ type: 'data', data: this.toWebviewMatrix(this.lastMatrix) });
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
    async updateExtension(extensionId) {
        try {
            await runCodeCliCommand(['--install-extension', extensionId, '--force']);
            vscode.window.showInformationMessage(`「${extensionId}」を更新しました。`);
            await this.refresh();
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`拡張機能を更新できませんでした: ${detail}`);
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
    try {
        const galleryInfo = await fetchGalleryInfo(extensions.map((extension) => extension.id));
        for (const extension of extensions) {
            const info = galleryInfo.get(extension.id.toLowerCase());
            if (!info) {
                continue;
            }
            extension.deprecated = info.deprecated;
            if (extension.version && info.version) {
                extension.latestVersion = info.version;
                extension.hasUpdate = isNewerVersion(info.version, extension.version);
            }
        }
    }
    catch {
        // Marketplace lookup is best-effort; ignore failures (e.g. offline).
    }
}
function isNewerVersion(latest, installed) {
    const toParts = (value) => value.split('.').map((part) => Number.parseInt(part, 10) || 0);
    const latestParts = toParts(latest);
    const installedParts = toParts(installed);
    for (let index = 0; index < Math.max(latestParts.length, installedParts.length); index++) {
        const latestPart = latestParts[index] ?? 0;
        const installedPart = installedParts[index] ?? 0;
        if (latestPart !== installedPart) {
            return latestPart > installedPart;
        }
    }
    return false;
}
async function fetchGalleryInfo(ids) {
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
            // IncludeLatestVersionOnly (0x200) | IncludeVersionProperties (0x10)
            flags: 528
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
        const latestVersion = extension.versions?.[0];
        if (publisherName && extensionName) {
            const deprecated = latestVersion?.properties?.some((property) => property.key === 'Microsoft.VisualStudio.Code.Deprecated' && property.value === 'true') ?? false;
            result.set(`${publisherName}.${extensionName}`.toLowerCase(), { version: latestVersion?.version, deprecated });
        }
    }
    return result;
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
    const syncFile = path.join(path.dirname(getProfilesDirectory()), 'sync', 'profiles', 'lastSyncprofiles.json');
    try {
        const parsed = JSON.parse(await node_fs_1.promises.readFile(syncFile, 'utf8'));
        const content = parsed.syncData?.content;
        if (typeof content !== 'string') {
            return new Map();
        }
        const profileData = JSON.parse(content);
        const records = findProfileRecords(profileData);
        return new Map(records.filter(hasIdAndName).map((profile) => [profile.id, profile.name]));
    }
    catch {
        return new Map();
    }
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
    const location = extension.location?.fsPath ?? extension.location?.path;
    if (!location) {
        return { id, displayName: id };
    }
    try {
        return { id, ...await readManifestInfo(toFilePath(location), id) };
    }
    catch {
        return { id, displayName: id };
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
    const command = process.platform === 'win32' ? getWindowsCodeExecutablePath() : 'code';
    const commandArgs = process.platform === 'win32' ? [getWindowsCodeCliScriptPath(), ...args] : args;
    const environment = process.platform === 'win32'
        ? { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' }
        : process.env;
    return new Promise((resolve, reject) => {
        (0, node_child_process_1.execFile)(command, commandArgs, { env: environment }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr.trim() || error.message));
                return;
            }
            resolve(stdout);
        });
    });
}
function getWindowsCodeExecutablePath() {
    return path.resolve(vscode.env.appRoot, '..', '..', '..', 'Code.exe');
}
function getWindowsCodeCliScriptPath() {
    return path.join(vscode.env.appRoot, 'out', 'cli.js');
}
async function findInstalledManifest(id) {
    const extensionsDirectory = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.vscode', 'extensions');
    try {
        const entries = await node_fs_1.promises.readdir(extensionsDirectory, { withFileTypes: true });
        const matchingDirectory = entries.find((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith(`${id.toLowerCase()}-`));
        return matchingDirectory ? await readManifestInfo(path.join(extensionsDirectory, matchingDirectory.name), id) : { displayName: id };
    }
    catch {
        return { displayName: id };
    }
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
    return message.type === 'refresh' || message.type === 'ready' || (message.type === 'openExtension' && typeof message.extensionId === 'string') || (message.type === 'update' && typeof message.extensionId === 'string') || (message.type === 'toggle' &&
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
    :root { color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
    body { margin: 0; padding: 12px; background: var(--vscode-sideBar-background); }
    .toolbar { display: flex; gap: 8px; margin-bottom: 10px; }
    input { flex: 1; min-width: 0; padding: 6px 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 6px 9px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .matrix { overflow: auto; border: 1px solid var(--vscode-panel-border); }
    table { border-collapse: collapse; table-layout: fixed; width: max-content; font-size: 12px; }
    th, td { border-bottom: 1px solid var(--vscode-panel-border); padding: 6px 8px; text-align: left; }
    th { position: sticky; top: 0; background: var(--vscode-sideBar-background); z-index: 1; white-space: nowrap; }
    th:first-child, td:first-child { position: sticky; left: 0; background: var(--vscode-sideBar-background); width: 280px; z-index: 2; }
    th:first-child { z-index: 3; }
    th:not(:first-child) { text-align: center; }
    td:not(:first-child) { text-align: center; }
    .cell { background: transparent; color: var(--vscode-foreground); display: inline-flex; align-items: center; justify-content: center; min-width: 30px; padding: 3px 7px; }
    .cell.enabled { color: var(--vscode-testing-iconPassed); }
    .extension-row { align-items: flex-start; display: flex; gap: 8px; }
    .extension-icon { border-radius: 4px; flex: none; height: 32px; width: 32px; }
    .extension-icon.placeholder { background: var(--vscode-badge-background); }
    .extension-details { min-width: 0; }
    .extension-link { background: transparent; color: var(--vscode-textLink-foreground); display: block; overflow: hidden; padding: 0; text-align: left; text-overflow: ellipsis; white-space: nowrap; width: 100%; }
    .extension-link:hover { background: transparent; color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
    .extension-link.deprecated { text-decoration: line-through; }
    .deprecated-badge { background: var(--vscode-editorWarning-foreground); border-radius: 3px; color: var(--vscode-editor-background); font-size: 10px; margin-left: 4px; padding: 0 4px; }
    .extension-description { color: var(--vscode-descriptionForeground); display: block; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .extension-meta { color: var(--vscode-descriptionForeground); display: block; font-size: 11px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .extension-publisher { font-weight: 600; }
    .version-old { text-decoration: line-through; }
    .update-button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 3px; cursor: pointer; font-size: 10px; margin-left: 4px; padding: 1px 5px; }
    .update-button:hover { background: var(--vscode-button-hoverBackground); }
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
    const header = matrix.profiles.map((profile) => '<th title="' + escapeHtml(profile.name) + '">' + escapeHtml(profile.name) + '</th>').join('');
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
        const updateButton = extension.hasUpdate
          ? '<button class="update-button" title="最新バージョンに更新" data-update-extension="' + escapeHtml(extension.id) + '">更新あり</button>'
          : '';
        const deprecatedBadge = extension.deprecated ? '<span class="deprecated-badge" title="この拡張機能は非推奨です">非推奨</span>' : '';
        const meta = [publisher, versionText].filter(Boolean).join(' \u00b7 ');
        const nameClass = extension.deprecated ? 'extension-link deprecated' : 'extension-link';
        return '<tr><td title="' + escapeHtml(extension.id) + '"><div class="extension-row">' + icon + '<div class="extension-details"><button class="' + nameClass + '" data-open-extension="' + escapeHtml(extension.id) + '">' + escapeHtml(extension.displayName) + '</button>' + deprecatedBadge + description + '<span class="extension-meta">' + meta + updateButton + '</span></div></div></td>' + cells + '</tr>';
      }).join('');
            content.innerHTML = '<div class="matrix"><table><colgroup>' + columns + '</colgroup><thead><tr><th>Extension</th>' + header + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
      content.querySelectorAll('.cell').forEach((button) => button.addEventListener('click', () => {
        const profile = matrix.profiles.find((item) => item.id === button.dataset.profileId);
        if (profile) vscode.postMessage({ type: 'toggle', profileId: profile.id, profileName: profile.cliName, extensionId: button.dataset.extensionId, enabled: button.dataset.enabled === 'true' });
      }));
    content.querySelectorAll('[data-open-extension]').forEach((button) => button.addEventListener('click', () => vscode.postMessage({ type: 'openExtension', extensionId: button.dataset.openExtension })));
    content.querySelectorAll('[data-update-extension]').forEach((button) => button.addEventListener('click', (event) => {
      event.stopPropagation();
      vscode.postMessage({ type: 'update', extensionId: button.dataset.updateExtension });
    }));
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