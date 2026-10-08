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
const configurationSection = 'profileExtensionMatrix';
const columnWidthsSetting = 'columnWidths';

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
        const configurationListener = vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(`${configurationSection}.${columnWidthsSetting}`)) {
                this.postColumnWidths();
            }
        });
        webviewView.onDidDispose(() => configurationListener.dispose());
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
            if (message.type === 'ready') {
                this.postColumnWidths();
                if (this.lastMatrix) {
                    webviewView.webview.postMessage({ type: 'data', data: this.toWebviewMatrix(this.lastMatrix) });
                }
            }
            if (message.type === 'saveColumnWidths') {
                await saveColumnWidths(message.widths);
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

    private postColumnWidths(): void {
        this.view?.webview.postMessage({ type: 'columnWidths', widths: readColumnWidths() });
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

    private async switchProfile(): Promise<void> {
        try {
            await vscode.commands.executeCommand('workbench.profiles.actions.switchProfile');
            await this.refresh();
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(vscode.l10n.t('Could not switch profile: {0}', detail));
        }
    }

    private async toggleExtension(message: ToggleMessage): Promise<void> {
        const action = message.enabled ? vscode.l10n.t('Add') : vscode.l10n.t('Remove');
        const confirmation = await vscode.window.showWarningMessage(
            message.enabled
                ? vscode.l10n.t('Add "{0}" to profile "{1}"?', message.extensionId, message.profileName)
                : vscode.l10n.t('Remove "{0}" from profile "{1}"?', message.extensionId, message.profileName),
            { modal: true },
            action
        );
        if (confirmation !== action) {
            return;
        }

        try {
            await runCodeCli(message.profileName, message.extensionId, message.enabled);
            vscode.window.showInformationMessage(message.enabled
                ? vscode.l10n.t('Added "{0}".', message.extensionId)
                : vscode.l10n.t('Removed "{0}".', message.extensionId));
            await this.refresh();
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(message.enabled
                ? vscode.l10n.t('Could not add extension: {0}', detail)
                : vscode.l10n.t('Could not remove extension: {0}', detail));
        }
    }
}

type ColumnWidths = Record<string, number>;

function readColumnWidths(): ColumnWidths {
    const stored = vscode.workspace.getConfiguration(configurationSection).get<unknown>(columnWidthsSetting);
    return isColumnWidths(stored) ? stored : {};
}

// The setting is application-scoped, so it is written to the user settings shared by all profiles.
async function saveColumnWidths(widths: ColumnWidths): Promise<void> {
    try {
        await vscode.workspace.getConfiguration(configurationSection).update(
            columnWidthsSetting,
            Object.keys(widths).length ? widths : undefined,
            vscode.ConfigurationTarget.Global
        );
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(vscode.l10n.t('Could not save column widths: {0}', detail));
    }
}

function isColumnWidths(value: unknown): value is ColumnWidths {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
        Object.values(value as Record<string, unknown>).every((width) => typeof width === 'number' && Number.isFinite(width) && width > 0);
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
            name: vscode.l10n.t('Default'),
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
            extensions: extensionList.sort((left, right) => left.displayName.localeCompare(right.displayName, vscode.env.language))
        };
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { profiles: [], extensions: [], error: vscode.l10n.t('Could not read profile information: {0}', detail) };
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
            throw new Error(vscode.l10n.t('The APPDATA environment variable is not set.'));
        }
        return path.join(process.env.APPDATA, 'Code', 'User', 'profiles');
    }
    if (process.platform === 'darwin') {
        return path.join(process.env.HOME ?? '', 'Library', 'Application Support', 'Code', 'User', 'profiles');
    }
    return path.join(process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? '', '.config'), 'Code', 'User', 'profiles');
}

async function readProfileNames(): Promise<Map<string, string>> {
    const syncDirectory = path.join(path.dirname(getProfilesDirectory()), 'sync', 'profiles');
    try {
        const entries = await fs.readdir(syncDirectory, { withFileTypes: true });
        const syncFiles = entries
            .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
            .map((entry) => entry.name)
            .sort()
            .reverse();
        for (const syncFile of syncFiles) {
            const parsed = JSON.parse(await fs.readFile(path.join(syncDirectory, syncFile), 'utf8')) as { content?: string; syncData?: { content?: string } };
            const content = parsed.content ?? parsed.syncData?.content;
            if (typeof content !== 'string') {
                continue;
            }
            const records = findProfileRecords(JSON.parse(content) as unknown);
            const names = new Map(records.filter(hasIdAndName).map((profile) => [profile.id, profile.name]));
            if (names.size > 0) {
                return names;
            }
        }
    } catch {
        // Fall back to directory IDs when profile sync data is unavailable.
    }
    return new Map();
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
    const invocation = getCodeCliInvocation();
    return new Promise((resolve, reject) => {
        execFile(invocation.command, [...invocation.commandArgs, ...args], { env: invocation.environment }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr.trim() || error.message));
                return;
            }
            resolve(stdout);
        });
    });
}

function getCodeCliInvocation(): {
    command: string;
    commandArgs: string[];
    environment: NodeJS.ProcessEnv;
} {
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

function isMessage(value: unknown): value is ToggleMessage | { type: 'refresh' } | { type: 'ready' } | { type: 'openExtension'; extensionId: string } | { type: 'update'; extensionId: string } | { type: 'switchProfile'; profileName: string } | { type: 'saveColumnWidths'; widths: ColumnWidths } {
    if (!value || typeof value !== 'object' || !('type' in value)) {
        return false;
    }
    const message = value as Record<string, unknown>;
    return message.type === 'refresh' || message.type === 'ready' || (
        message.type === 'openExtension' && typeof message.extensionId === 'string'
    ) || (
            message.type === 'switchProfile' && typeof message.profileName === 'string'
        ) || (
            message.type === 'saveColumnWidths' && isColumnWidths(message.widths)
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
    const strings = {
        noProfiles: vscode.l10n.t('No custom profiles found.'),
        removeFromProfile: vscode.l10n.t('Remove from this profile'),
        addToProfile: vscode.l10n.t('Add to this profile'),
        updateAvailableTitle: vscode.l10n.t('An update is available'),
        updateAvailable: vscode.l10n.t('Update available'),
        deprecatedTitle: vscode.l10n.t('This extension is deprecated'),
        deprecated: vscode.l10n.t('Deprecated'),
        extensionColumn: vscode.l10n.t('Extension'),
        resizeColumn: vscode.l10n.t('Drag to resize the column. Double-click to reset all column widths.')
    };
    // Escape "<" so the embedded JSON can never close the surrounding <script> element.
    const stringsJson = JSON.stringify(strings).replace(/</g, '\\u003c');
    const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="${escapeAttribute(vscode.env.language)}">
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
    table { border-collapse: collapse; table-layout: fixed; width: 100%; min-width: 155px; font-size: 12px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); }
    th, td { border-bottom: 1px solid var(--vscode-panel-border); padding: 7px 8px; text-align: left; color: var(--vscode-foreground); background: var(--vscode-editor-background); overflow: hidden; }
    th { position: sticky; top: 0; background: var(--vscode-editorWidget-background); color: var(--vscode-editorWidget-foreground); z-index: 1; white-space: nowrap; text-overflow: ellipsis; font-weight: 600; }
    th:first-child, td:first-child { position: sticky; left: 0; background: var(--vscode-editor-background); width: min(42vw, 300px); min-width: 55px; z-index: 2; }
    th:first-child { z-index: 3; }
    .resizer { position: absolute; top: 0; right: 0; width: 6px; height: 100%; cursor: col-resize; touch-action: none; user-select: none; z-index: 4; }
    .resizer:hover, .resizer.active { background: var(--vscode-sash-hoverBorder, var(--vscode-focusBorder)); }
    body.resizing { cursor: col-resize; user-select: none; }
    th:not(:first-child) { text-align: center; }
    td:not(:first-child) { text-align: center; }
    .cell { background: rgba(255, 255, 255, 0.04); color: var(--vscode-foreground); display: inline-flex; align-items: center; justify-content: center; min-width: 30px; min-height: 24px; padding: 3px 7px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; font-weight: 700; }
    .cell.enabled { background: rgba(46, 204, 113, 0.14); color: var(--vscode-testing-iconPassed); border-color: rgba(46, 204, 113, 0.5); }
    .extension-row { align-items: flex-start; display: flex; gap: 8px; min-width: 0; overflow: hidden; }
    .extension-icon { border-radius: 4px; flex: none; height: 32px; width: 32px; }
    .extension-icon.placeholder { background: var(--vscode-badge-background); }
    .extension-details { min-width: 0; overflow: hidden; }
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
  <div class="toolbar"><input id="search" type="search" placeholder="${escapeAttribute(vscode.l10n.t('Search extensions'))}"><button id="refresh" title="${escapeAttribute(vscode.l10n.t('Refresh'))}">${escapeAttribute(vscode.l10n.t('Refresh'))}</button></div>
  <div id="content" class="message">${escapeAttribute(vscode.l10n.t('Loading...'))}</div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const strings = ${stringsJson};
    let matrix = { profiles: [], extensions: [] };
    let columnWidths = {};
    let resizing = false;
    const extensionColumnKey = '__extension__';
    const defaultExtensionColumnWidth = 300;
    const defaultProfileColumnWidth = 66;
    const minimumExtensionColumnWidth = 55;
    const minimumProfileColumnWidth = 40;
    const content = document.getElementById('content');
    const search = document.getElementById('search');
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    search.addEventListener('input', render);
    window.addEventListener('message', (event) => {
      if (event.data.type === 'data') { matrix = event.data.data; render(); }
      if (event.data.type === 'columnWidths' && !resizing) { columnWidths = event.data.widths || {}; applyColumnWidths(); }
    });
    vscode.postMessage({ type: 'ready' });
    function escapeHtml(value) {
      return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
    }
    function render() {
      if (matrix.error) { content.innerHTML = '<p class="message error">' + escapeHtml(matrix.error) + '</p>'; return; }
      if (!matrix.profiles.length) { content.innerHTML = '<p class="message">' + escapeHtml(strings.noProfiles) + '</p>'; return; }
      const query = search.value.trim().toLowerCase();
    const extensions = matrix.extensions.filter((extension) => (extension.id + ' ' + extension.displayName).toLowerCase().includes(query));
    const resizer = (key) => '<div class="resizer" title="' + escapeHtml(strings.resizeColumn) + '" data-column-key="' + escapeHtml(key) + '"></div>';
    const columns = '<col style="width: 70px; min-width: 55px">' + matrix.profiles.map(() => '<col style="width: 66px; min-width: 66px">').join('');
    const header = matrix.profiles.map((profile) => '<th title="' + escapeHtml(profile.name) + '" data-column-key="' + escapeHtml(profile.id) + '"><button class="profile-header" data-switch-profile="' + escapeHtml(profile.name) + '">' + escapeHtml(profile.name) + '</button>' + resizer(profile.id) + '</th>').join('');
      const rows = extensions.map((extension) => {
        const cells = matrix.profiles.map((profile) => {
          const enabled = extension.profileIds.includes(profile.id);
          const label = enabled ? '✓' : '+';
          const title = escapeHtml(enabled ? strings.removeFromProfile : strings.addToProfile);
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
                    ? '<span class="update-badge" title="' + escapeHtml(strings.updateAvailableTitle) + '">' + escapeHtml(strings.updateAvailable) + '</span>'
          : '';
        const deprecatedBadge = extension.deprecated ? '<span class="deprecated-badge" title="' + escapeHtml(strings.deprecatedTitle) + '">' + escapeHtml(strings.deprecated) + '</span>' : '';
        const meta = [publisher, versionText].filter(Boolean).join(' \u00b7 ');
        const nameClass = extension.deprecated ? 'extension-link deprecated' : 'extension-link';
        return '<tr><td title="' + escapeHtml(extension.id) + '"><div class="extension-row">' + icon + '<div class="extension-details"><button class="' + nameClass + '" data-open-extension="' + escapeHtml(extension.id) + '">' + escapeHtml(extension.displayName) + '</button>' + deprecatedBadge + description + '<span class="extension-meta">' + meta + updateBadge + '</span></div></div></td>' + cells + '</tr>';
      }).join('');
                        content.innerHTML = '<div class="matrix"><table><colgroup>' + columns + '</colgroup><thead><tr><th data-column-key="' + extensionColumnKey + '">' + escapeHtml(strings.extensionColumn) + resizer(extensionColumnKey) + '</th>' + header + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
            content.querySelectorAll('[data-switch-profile]').forEach((button) => button.addEventListener('click', () => {
                vscode.postMessage({ type: 'switchProfile', profileName: button.dataset.switchProfile });
            }));
      content.querySelectorAll('.cell').forEach((button) => button.addEventListener('click', () => {
        const profile = matrix.profiles.find((item) => item.id === button.dataset.profileId);
        if (profile) vscode.postMessage({ type: 'toggle', profileId: profile.id, profileName: profile.cliName, extensionId: button.dataset.extensionId, enabled: button.dataset.enabled === 'true' });
      }));
    content.querySelectorAll('[data-open-extension]').forEach((button) => button.addEventListener('click', () => vscode.postMessage({ type: 'openExtension', extensionId: button.dataset.openExtension })));
      content.querySelectorAll('.resizer').forEach(attachResizer);
      applyColumnWidths();
    }
    function defaultColumnWidth(key) {
      return key === extensionColumnKey ? defaultExtensionColumnWidth : defaultProfileColumnWidth;
    }
    function minimumColumnWidth(key) {
      return key === extensionColumnKey ? minimumExtensionColumnWidth : minimumProfileColumnWidth;
    }
    // Without saved widths the table keeps its responsive layout; once any width is saved every column gets an explicit width.
    function applyColumnWidths() {
      const table = content.querySelector('table');
      if (!table) return;
      const headers = [...table.querySelectorAll('thead th')];
      const cols = [...table.querySelectorAll('col')];
      const customized = Object.keys(columnWidths).length > 0;
      let total = 0;
      headers.forEach((header, index) => {
        const width = customized ? (columnWidths[header.dataset.columnKey] ?? defaultColumnWidth(header.dataset.columnKey)) : undefined;
        header.style.width = width ? width + 'px' : '';
        header.style.minWidth = width ? width + 'px' : '';
        if (cols[index]) {
          cols[index].style.width = width ? width + 'px' : (index === 0 ? '70px' : '66px');
          cols[index].style.minWidth = width ? width + 'px' : (index === 0 ? '55px' : '66px');
        }
        total += width ?? 0;
      });
      table.style.width = customized ? total + 'px' : '';
      table.style.minWidth = customized ? '0' : '';
    }
    function attachResizer(handle) {
      handle.addEventListener('click', (event) => event.stopPropagation());
      handle.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        columnWidths = {};
        applyColumnWidths();
        vscode.postMessage({ type: 'saveColumnWidths', widths: {} });
      });
      handle.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const key = handle.dataset.columnKey;
        // Freeze the current layout so resizing one column does not make the others jump.
        content.querySelectorAll('thead th').forEach((header) => {
          const headerKey = header.dataset.columnKey;
          if (columnWidths[headerKey] === undefined) columnWidths[headerKey] = Math.round(header.getBoundingClientRect().width);
        });
        const startX = event.clientX;
        const startWidth = columnWidths[key];
        resizing = true;
        handle.classList.add('active');
        document.body.classList.add('resizing');
        handle.setPointerCapture(event.pointerId);
        const onMove = (moveEvent) => {
          columnWidths[key] = Math.max(minimumColumnWidth(key), Math.round(startWidth + moveEvent.clientX - startX));
          applyColumnWidths();
        };
        const onUp = () => {
          handle.removeEventListener('pointermove', onMove);
          handle.removeEventListener('pointerup', onUp);
          handle.removeEventListener('pointercancel', onUp);
          resizing = false;
          handle.classList.remove('active');
          document.body.classList.remove('resizing');
          vscode.postMessage({ type: 'saveColumnWidths', widths: columnWidths });
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
      });
    }
  </script>
</body>
</html>`;
}

function escapeAttribute(value: string): string {
    return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character);
}

function createNonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

