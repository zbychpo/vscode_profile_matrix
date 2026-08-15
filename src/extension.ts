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
}

interface MatrixData {
    profiles: Array<{ id: string; name: string; cliName: string }>;
    extensions: Array<{ id: string; displayName: string; profileIds: string[] }>;
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

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
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
                await vscode.commands.executeCommand('workbench.extensions.search', `@id:${message.extensionId}`);
            }
        });
        void this.refresh();
    }

    async refresh(): Promise<void> {
        if (!this.view) {
            return;
        }
        this.view.webview.postMessage({ type: 'data', data: await loadMatrix() });
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

        const extensions = new Map<string, { displayName: string; profileIds: string[] }>();
        for (const profile of profiles) {
            for (const extension of profile.extensions) {
                const existing = extensions.get(extension.id) ?? { displayName: extension.displayName, profileIds: [] };
                existing.profileIds.push(profile.id);
                extensions.set(extension.id, existing);
            }
        }

        return {
            profiles: profiles.map(({ id, name, cliName }) => ({ id, name, cliName })).sort((left, right) => left.name.localeCompare(right.name)),
            extensions: [...extensions]
                .map(([id, extension]) => ({ id, ...extension }))
                .sort((left, right) => left.displayName.localeCompare(right.displayName, 'ja'))
        };
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { profiles: [], extensions: [], error: `プロファイル情報を読み取れませんでした: ${detail}` };
    }
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
    const location = extension.location?.fsPath ?? extension.location?.path;
    if (!location) {
        return { id, displayName: id };
    }
    try {
        return { id, displayName: await readDisplayName(toFilePath(location), id) };
    } catch {
        return { id, displayName: id };
    }
}

async function readDefaultExtensions(): Promise<ExtensionInfo[]> {
    const ids = await listExtensionsForProfile('Default');
    return Promise.all(ids.map(async (id) => ({ id, displayName: await findInstalledDisplayName(id) })));
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

async function findInstalledDisplayName(id: string): Promise<string> {
    const extensionsDirectory = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.vscode', 'extensions');
    try {
        const entries = await fs.readdir(extensionsDirectory, { withFileTypes: true });
        const matchingDirectory = entries.find((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith(`${id.toLowerCase()}-`));
        return matchingDirectory ? await readDisplayName(path.join(extensionsDirectory, matchingDirectory.name), id) : id;
    } catch {
        return id;
    }
}

async function readDisplayName(extensionDirectory: string, fallback: string): Promise<string> {
    const manifest = JSON.parse(await fs.readFile(path.join(extensionDirectory, 'package.json'), 'utf8')) as { displayName?: string; name?: string };
    const displayName = manifest.displayName ?? manifest.name ?? fallback;
    const localizationKey = /^%(.+)%$/.exec(displayName)?.[1];
    if (!localizationKey) {
        return displayName;
    }
    try {
        const translations = JSON.parse(await fs.readFile(path.join(extensionDirectory, 'package.nls.json'), 'utf8')) as Record<string, string>;
        return translations[localizationKey] ?? fallback;
    } catch {
        return fallback;
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

function isMessage(value: unknown): value is ToggleMessage | { type: 'refresh' } | { type: 'openExtension'; extensionId: string } {
    if (!value || typeof value !== 'object' || !('type' in value)) {
        return false;
    }
    const message = value as Record<string, unknown>;
    return message.type === 'refresh' || (
        message.type === 'openExtension' && typeof message.extensionId === 'string'
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
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
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
    table { border-collapse: collapse; table-layout: fixed; width: max-content; min-width: 100%; font-size: 12px; }
    th, td { border-bottom: 1px solid var(--vscode-panel-border); padding: 6px 8px; text-align: left; }
    th { position: sticky; top: 0; background: var(--vscode-sideBar-background); z-index: 1; white-space: nowrap; }
    th:first-child, td:first-child { position: sticky; left: 0; background: var(--vscode-sideBar-background); width: 280px; z-index: 2; }
    th:first-child { z-index: 3; }
    td:not(:first-child) { text-align: center; }
    .cell { background: transparent; color: var(--vscode-foreground); min-width: 30px; padding: 3px 7px; }
    .cell.enabled { color: var(--vscode-testing-iconPassed); }
    .extension-name { display: block; }
    .extension-id { color: var(--vscode-descriptionForeground); display: block; font-size: 11px; margin-top: 2px; }
    .extension-link { background: transparent; color: var(--vscode-textLink-foreground); display: block; overflow: hidden; padding: 0; text-align: left; text-overflow: ellipsis; white-space: nowrap; width: 100%; }
    .extension-link:hover { background: transparent; color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
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
                return '<tr><td title="' + escapeHtml(extension.id) + '"><button class="extension-link" data-open-extension="' + escapeHtml(extension.id) + '">' + escapeHtml(extension.displayName) + '</button><span class="extension-id">' + escapeHtml(extension.id) + '</span></td>' + cells + '</tr>';
      }).join('');
            content.innerHTML = '<div class="matrix"><table><colgroup>' + columns + '</colgroup><thead><tr><th>Extension</th>' + header + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
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

function createNonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}