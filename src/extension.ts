import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface Profile {
    id: string;
    name: string;
    cliName: string;
    extensions: ExtensionInfo[];
}

interface ExtensionInfo {
    id: string;
    displayName: string;
    description?: string;
    publisher?: string;
    version?: string;
    iconPath?: string;
}

interface MatrixExtension {
    id: string;
    displayName: string;
    description?: string;
    publisher?: string;
    version?: string;
    iconUri?: string;
    latestVersion?: string;
    hasUpdate?: boolean;
    deprecated?: boolean;
    profileIds: string[];
}

interface MatrixData {
    profiles: Array<{ id: string; name: string; cliName: string }>;
    extensions: MatrixExtension[];
    error?: string;
}

interface SyncProfile {
    id?: string;
    name?: string;
}

interface StoredExtension {
    identifier?: { id?: string };
    location?: { fsPath?: string; path?: string };
}

const defaultProfileId = '__default__';
const defaultProfileName = '既定';

export function activate(context: vscode.ExtensionContext): void {
    const provider = new MatrixViewProvider();

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(MatrixViewProvider.viewType, provider),
        vscode.commands.registerCommand('profileExtensionMatrix.open', () =>
            vscode.commands.executeCommand('workbench.view.extension.profileExtensionMatrix')
        ),
        vscode.commands.registerCommand('profileExtensionMatrix.refresh', () => provider.refresh())
    );
}

class MatrixViewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'profileExtensionMatrix.matrixView';
    private view: vscode.WebviewView | undefined;
    private lastMatrix: MatrixData | undefined;

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.file(getGlobalExtensionsDirectory()),
                vscode.Uri.file(getProfilesDirectory())
            ]
        };
        webviewView.webview.html = getWebviewHtml(webviewView.webview);
        webviewView.webview.onDidReceiveMessage(async (message: unknown) => {
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
            if (message.type === 'switchProfile') {
                await this.switchProfile();
            }
        });
        void this.refresh();
    }

    async refresh(): Promise<void> {
        const data = await loadMatrix();
        this.lastMatrix = data;
        if (!this.view) {
            return;
        }
        this.view.webview.postMessage({ type: 'data', data: this.toWebviewMatrix(data) });
    }

    private toWebviewMatrix(data: MatrixData): MatrixData {
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

    private async updateExtension(extensionId: string): Promise<void> {
        const before = this.lastMatrix?.extensions.find((extension) => extension.id === extensionId)?.version;
        const expected = this.lastMatrix?.extensions.find((extension) => extension.id === extensionId)?.latestVersion;
        try {
            await runCodeCliCommand(['--install-extension', extensionId, '--force', '--verbose']);
            await this.refresh();
            const after = this.lastMatrix?.extensions.find((extension) => extension.id === extensionId)?.version;
            if (after && after !== before) {
                vscode.window.showInformationMessage(`「${extensionId}」を v${after} に更新しました。`);
            } else if (expected && before && !isNewerVersion(expected, before)) {
                vscode.window.showInformationMessage(`「${extensionId}」は既に最新バージョン v${before} です。`);
            } else {
                vscode.window.showWarningMessage(
                    `「${extensionId}」の更新コマンドは完了しましたが、v${before ?? '?'} からバージョンが変わりませんでした。`
                );
            }
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`拡張機能を更新できませんでした: ${detail}`);
        }
    }

    private async switchProfile(): Promise<void> {
        try {
            await vscode.commands.executeCommand('workbench.profiles.actions.switchProfile');
            await this.refresh();
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`プロファイルを切り替えられませんでした: ${detail}`);
        }
    }

    private async toggleExtension(message: ToggleMessage): Promise<void> {
        const verb = message.enabled ? '追加' : '削除';
        const confirmation = await vscode.window.showWarningMessage(
            `「${message.extensionId}」をプロファイル「${message.profileName}」に${verb}しますか？`,
            { modal: true },
            verb
        );
        if (confirmation !== verb) {
            return;
        }

        try {
            await runCodeCli(message.profileName, message.extensionId, message.enabled);
            vscode.window.showInformationMessage(`「${message.extensionId}」を${verb}しました。`);
            await this.refresh();
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`拡張機能を${verb}できませんでした: ${detail}`);
        }
    }
}

async function loadMatrix(): Promise<MatrixData> {
    try {
        const profilesDirectory = getProfilesDirectory();
        const names = await readProfileNames();
        const entries = await fs.readdir(profilesDirectory, { withFileTypes: true });
        const customProfiles = await Promise.all(
            entries
                .filter((entry) => entry.isDirectory() && entry.name !== 'builtin')
                .map(async (entry): Promise<Profile> => ({
                    id: entry.name,
                    name: names.get(entry.name) ?? entry.name,
                    cliName: names.get(entry.name) ?? entry.name,
                    extensions: await readExtensionIds(path.join(profilesDirectory, entry.name, 'extensions.json'))
                }))
        );
        const defaultProfile: Profile = {
            id: defaultProfileId,
            name: defaultProfileName,
            cliName: 'Default',
            extensions: await readDefaultExtensions()
        };
        const profiles = [defaultProfile, ...customProfiles];
        const extensions = new Map<string, Omit<MatrixExtension, 'id'>>();
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
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { profiles: [], extensions: [], error: `プロファイル情報を読み取れませんでした: ${detail}` };
    }
}

async function applyUpdateInfo(extensions: MatrixExtension[]): Promise<void> {
    if (!extensions.length) {
        return;
    }
    const [latestVersions, deprecatedIds] = await Promise.all([
        fetchLatestVersions(extensions.map((extension) => extension.id)).catch(() => new Map<string, string>()),
        fetchDeprecatedIds().catch(() => new Set<string>())
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

function isNewerVersion(latest: string, installed: string): boolean {
    return compareVersions(latest, installed) > 0;
}

async function fetchLatestVersions(ids: string[]): Promise<Map<string, string>> {
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
    const payload = await response.json() as {
        results?: Array<{
            extensions?: Array<{
                publisher?: { publisherName?: string };
                extensionName?: string;
                versions?: Array<{ version?: string }>;
            }>;
        }>;
    };
    const result = new Map<string, string>();
    for (const extension of payload.results?.[0]?.extensions ?? []) {
        const publisherName = extension.publisher?.publisherName;
        const extensionName = extension.extensionName;
        const version = extension.versions
            ?.map((item) => item.version)
            .filter((item): item is string => Boolean(item))
            .sort((left, right) => compareVersions(right, left))[0];
        if (publisherName && extensionName && version) {
            result.set(`${publisherName}.${extensionName}`.toLowerCase(), version);
        }
    }
    return result;
}

let deprecatedIdsCache: Set<string> | undefined;

// VS Code itself sources its "deprecated extension" warnings from this curated CDN file (not the gallery API).
async function fetchDeprecatedIds(): Promise<Set<string>> {
    if (deprecatedIdsCache) {
        return deprecatedIdsCache;
    }
    const response = await fetch('https://main.vscode-cdn.net/extensions/marketplace.json');
    if (!response.ok) {
        return new Set();
    }
    const payload = await response.json() as { deprecated?: Record<string, unknown> };
    deprecatedIdsCache = new Set(Object.keys(payload.deprecated ?? {}).map((id) => id.toLowerCase()));
    return deprecatedIdsCache;
}

function getProfilesDirectory(): string {
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

async function readProfileNames(): Promise<Map<string, string>> {
    const syncFile = path.join(path.dirname(getProfilesDirectory()), 'sync', 'profiles', 'lastSyncprofiles.json');
    try {
        const parsed = JSON.parse(await fs.readFile(syncFile, 'utf8')) as { syncData?: { content?: string } };
        const content = parsed.syncData?.content;
        if (typeof content !== 'string') {
            return new Map();
        }
        const profileData = JSON.parse(content) as unknown;
        const records = findProfileRecords(profileData);
        return new Map(records.filter(hasIdAndName).map((profile) => [profile.id, profile.name]));
    } catch {
        return new Map();
    }
}

function findProfileRecords(value: unknown): SyncProfile[] {
    if (Array.isArray(value)) {
        return value.flatMap(findProfileRecords);
    }
    if (!value || typeof value !== 'object') {
        return [];
    }
    const record = value as Record<string, unknown>;
    const own = typeof record.id === 'string' && typeof record.name === 'string'
        ? [{ id: record.id, name: record.name }]
        : [];
    return [...own, ...Object.values(record).flatMap(findProfileRecords)];
}

function hasIdAndName(profile: SyncProfile): profile is Required<SyncProfile> {
    return typeof profile.id === 'string' && typeof profile.name === 'string';
}

async function readExtensionIds(filePath: string): Promise<ExtensionInfo[]> {
    try {
        const extensions = JSON.parse(await fs.readFile(filePath, 'utf8')) as StoredExtension[];
        return Promise.all(extensions.map(readExtensionInfo)).then((items) => items.filter((item): item is ExtensionInfo => item !== undefined));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

async function readExtensionInfo(extension: StoredExtension): Promise<ExtensionInfo | undefined> {
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
    } catch {
        return { id, ...scanned };
    }
}

async function readDefaultExtensions(): Promise<ExtensionInfo[]> {
    const ids = await listExtensionsForProfile('Default');
    return Promise.all(ids.map(async (id) => ({ id, ...await findInstalledManifest(id) })));
}

function listExtensionsForProfile(profileName: string): Promise<string[]> {
    return runCodeCliCommand(['--profile', profileName, '--list-extensions'])
        .then((stdout) => stdout.split(/\r?\n/).map((id) => id.trim()).filter(Boolean));
}

function runCodeCli(profileName: string, extensionId: string, install: boolean): Promise<void> {
    const action = install ? '--install-extension' : '--uninstall-extension';
    return runCodeCliCommand(['--profile', profileName, action, extensionId]).then(() => undefined);
}

function runCodeCliCommand(args: string[]): Promise<string> {
    const command = process.platform === 'win32' ? getWindowsCodeExecutablePath() : 'code';
    const commandArgs = process.platform === 'win32' ? [getWindowsCodeCliScriptPath(), ...args] : args;
    const environment = process.platform === 'win32'
        ? { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' }
        : process.env;
    return new Promise((resolve, reject) => {
        execFile(command, commandArgs, { env: environment }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr.trim() || error.message));
                return;
            }
            resolve(stdout);
        });
    });
}

function getWindowsCodeExecutablePath(): string {
    return path.resolve(vscode.env.appRoot, '..', '..', '..', 'Code.exe');
}

function getWindowsCodeCliScriptPath(): string {
    return path.join(vscode.env.appRoot, 'out', 'cli.js');
}

type ManifestInfo = Omit<ExtensionInfo, 'id'>;

function getGlobalExtensionsDirectory(): string {
    return path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.vscode', 'extensions');
}

async function findInstalledManifest(id: string): Promise<ManifestInfo> {
    const extensionsDirectory = getGlobalExtensionsDirectory();
    try {
        // Match "<id>-<version>" exactly so extensions with an overlapping id prefix (e.g. a "-british-english" variant) aren't picked up.
        const versionPattern = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+\\.\\d+\\.\\d+)`, 'i');
        const entries = await fs.readdir(extensionsDirectory, { withFileTypes: true });
        const matchingDirectory = entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => ({ name: entry.name, version: versionPattern.exec(entry.name)?.[1] }))
            .filter((entry): entry is { name: string; version: string } => Boolean(entry.version))
            .sort((left, right) => compareVersions(right.version, left.version))[0];
        return matchingDirectory ? await readManifestInfo(path.join(extensionsDirectory, matchingDirectory.name), id) : { displayName: id };
    } catch {
        return { displayName: id };
    }
}

function compareVersions(left: string, right: string): number {
    const toParts = (value: string) => value.split('.').map((part) => Number.parseInt(part, 10) || 0);
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

async function readManifestInfo(extensionDirectory: string, fallback: string): Promise<ManifestInfo> {
    const manifest = JSON.parse(await fs.readFile(path.join(extensionDirectory, 'package.json'), 'utf8')) as {
        displayName?: string; name?: string; description?: string; publisher?: string; version?: string; icon?: string;
    };
    const translations = await readTranslations(extensionDirectory);
    const resolve = (value: string | undefined): string | undefined => {
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

async function readTranslations(extensionDirectory: string): Promise<Record<string, string>> {
    try {
        return JSON.parse(await fs.readFile(path.join(extensionDirectory, 'package.nls.json'), 'utf8')) as Record<string, string>;
    } catch {
        return {};
    }
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

function toFilePath(location: string): string {
    return process.platform === 'win32' ? location.replace(/^\/([A-Za-z]:)/, '$1') : location;
}

type ToggleMessage = {
    type: 'toggle';
    profileId: string;
    profileName: string;
    extensionId: string;
    enabled: boolean;
};

function isMessage(value: unknown): value is ToggleMessage | { type: 'refresh' } | { type: 'ready' } | { type: 'openExtension'; extensionId: string } | { type: 'update'; extensionId: string } | { type: 'switchProfile'; profileName: string } {
    if (!value || typeof value !== 'object' || !('type' in value)) {
        return false;
    }
    const message = value as Record<string, unknown>;
    return message.type === 'refresh' || message.type === 'ready' || (
        message.type === 'openExtension' && typeof message.extensionId === 'string'
    ) || (
            message.type === 'update' && typeof message.extensionId === 'string'
        ) || (
            message.type === 'switchProfile' && typeof message.profileName === 'string'
        ) || (
            message.type === 'toggle' &&
            typeof message.profileId === 'string' &&
            typeof message.profileName === 'string' &&
            typeof message.extensionId === 'string' &&
            typeof message.enabled === 'boolean'
        );
}

function getWebviewHtml(webview: vscode.Webview): string {
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
    .profile-header { background: transparent; color: var(--vscode-foreground); display: block; padding: 0; text-align: center; width: 100%; }
    .profile-header:hover { background: transparent; color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
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
        const updateButton = extension.hasUpdate
          ? '<button class="update-button" title="最新バージョンに更新" data-update-extension="' + escapeHtml(extension.id) + '">更新あり</button>'
          : '';
        const deprecatedBadge = extension.deprecated ? '<span class="deprecated-badge" title="この拡張機能は非推奨です">非推奨</span>' : '';
        const meta = [publisher, versionText].filter(Boolean).join(' \u00b7 ');
        const nameClass = extension.deprecated ? 'extension-link deprecated' : 'extension-link';
        return '<tr><td title="' + escapeHtml(extension.id) + '"><div class="extension-row">' + icon + '<div class="extension-details"><button class="' + nameClass + '" data-open-extension="' + escapeHtml(extension.id) + '">' + escapeHtml(extension.displayName) + '</button>' + deprecatedBadge + description + '<span class="extension-meta">' + meta + updateButton + '</span></div></div></td>' + cells + '</tr>';
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
    content.querySelectorAll('[data-update-extension]').forEach((button) => button.addEventListener('click', (event) => {
      event.stopPropagation();
      vscode.postMessage({ type: 'update', extensionId: button.dataset.updateExtension });
    }));
    }
  </script>
</body>
</html>`;
}

function createNonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

