// SPDX-License-Identifier: GPL-3.0-or-later
// Twingate Panel — GNOME Shell extension
// Copyright (C) 2026 the Twingate Panel contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

// ---- Configuration ---------------------------------------------------------
// Runtime values (poll interval, pkexec vs sudo, binary path) live in
// GSettings — see schemas/org.gnome.shell.extensions.twingate-panel.gschema.xml
// and prefs.js. There are no hardcoded defaults here anymore.

// ---- Status → UI mapping --------------------------------------------------
// The panel icon is static; only the status dot in the popup header changes
// color, via one of three style classes (see stylesheet.css).

const STATUS_INFO = {
    'not-running': {label: 'Not running', connected: false, dotClass: 'twingate-dot-offline'},
    offline: {label: 'Offline', connected: false, dotClass: 'twingate-dot-offline'},
    online: {label: 'Online', connected: true, dotClass: 'twingate-dot-online'},
    connecting: {label: 'Connecting…', connected: false, dotClass: 'twingate-dot-connecting'},
    authenticating: {label: 'Authenticating…', connected: false, dotClass: 'twingate-dot-connecting'},
    unknown: {label: 'Unknown', connected: false, dotClass: 'twingate-dot-offline'},
};

const DOT_CLASSES = ['twingate-dot-offline', 'twingate-dot-connecting', 'twingate-dot-online'];
const PING_CLASSES = ['twingate-dot-pending', 'twingate-dot-reachable', 'twingate-dot-unreachable'];
const DOT_SIZE = 10;

/**
 * A plain St.Widget with no content has a natural size of 0x0, so CSS
 * width/height alone can be unreliable inside a BoxLayout (it may stretch
 * to fill leftover space instead of staying a fixed-size circle). Forcing
 * the actor size in JS, and disabling expand, guarantees a true circle
 * regardless of theme/layout quirks.
 */
function createDot(extraClass) {
    const dot = new St.Widget({
        style_class: `twingate-status-dot ${extraClass}`,
        x_expand: false,
        y_expand: false,
        y_align: Clutter.ActorAlign.CENTER,
    });
    dot.set_size(DOT_SIZE, DOT_SIZE);
    return dot;
}

function statusInfoFor(token) {
    return STATUS_INFO[token] ?? STATUS_INFO.unknown;
}

/**
 * Run an external command asynchronously (never blocks the shell).
 * Returns {success, stdout, stderr}. Rethrows on cancellation so callers
 * can stop scheduling further work.
 */
async function runCommand(argv, cancellable) {
    let proc;
    try {
        proc = new Gio.Subprocess({
            argv,
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        proc.init(cancellable);
    } catch (e) {
        return {success: false, stdout: '', stderr: e.message ?? String(e)};
    }

    try {
        const [stdout, stderr] = await proc.communicate_utf8_async(null, cancellable);
        return {
            success: proc.get_successful(),
            stdout: stdout ?? '',
            stderr: stderr ?? '',
        };
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            throw e;
        return {success: false, stdout: '', stderr: e.message ?? String(e)};
    }
}

function parseStatusToken(stdout) {
    const firstLine = (stdout ?? '').split('\n').map(l => l.trim()).find(l => l.length > 0) ?? '';
    // Be defensive: lowercase, take the first "word-ish" token in case the
    // CLI prepends extra text in some version.
    const token = firstLine.toLowerCase().split(/\s+/)[0] ?? '';
    return token in STATUS_INFO ? token : 'unknown';
}

/** Returns true if a single ICMP echo request got a reply within 1s. */
async function pingAddress(address, cancellable) {
    try {
        const result = await runCommand(['ping', '-c', '1', '-W', '1', address], cancellable);
        return result.success;
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            throw e;
        return false;
    }
}

/**
 * `twingate resources` prints a tab-separated table:
 *   RESOURCE NAME <TAB> ADDRESS <TAB> ALIAS <TAB> AUTH STATUS
 *   Home Assistant<TAB>192.168.0.211<TAB>-<TAB>
 * We only want name + address; the header row and other columns are dropped.
 * When disconnected, the CLI prints an explanatory sentence instead of a
 * table — that yields no rows here, which is the desired behavior.
 */
/**
 * `twingate account list` prints a tab-separated table:
 *   EMAIL <TAB> NETWORK <TAB> NETWORK URL
 * Works even while disconnected. We only want the network name of the
 * first (typically only) account.
 */
function parseNetworkName(stdout) {
    const lines = (stdout ?? '').split('\n').map(l => l.trim()).filter(l => l.length > 0);
    for (const line of lines) {
        const fields = line.split('\t').map(f => f.trim());
        if (fields.length < 2 || /^email$/i.test(fields[0]))
            continue;
        return fields[1];
    }
    return null;
}

function parseResources(stdout) {
    const lines = (stdout ?? '').split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const rows = [];
    for (const line of lines) {
        const fields = line.split('\t').map(f => f.trim());
        if (fields.length < 2 || /^resource name$/i.test(fields[0]))
            continue;
        rows.push({name: fields[0], address: fields[1]});
    }
    return rows;
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extensionPath, settings, onOpenPreferences) {
        super._init(0.0, 'Twingate Panel', false);

        this._extensionPath = extensionPath;
        this._settings = settings;
        this._onOpenPreferences = onOpenPreferences;
        this._cancellable = new Gio.Cancellable();
        this._timeoutId = null;
        this._pendingRefreshIds = new Set();
        this._suppressToggle = false;
        this._busy = false;
        this._resourceGeneration = 0;

        const iconPath = GLib.build_filenamev([extensionPath, 'icons', 'twingate-panel.png']);
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(iconPath),
            icon_size: 16,
        });
        this.add_child(this._icon);

        this._buildMenu();
        this._setState('unknown');

        this._refresh();
        this._startPolling();
        this._loadNetworkName();
        this._settingsChangedId = this._settings.connect('changed::poll-interval-seconds', () => {
            this._startPolling();
        });
    }

    async _loadNetworkName() {
        const binary = this._settings.get_string('twingate-binary');
        let result;
        try {
            result = await runCommand([binary, '-d', 'account', 'list'], this._cancellable);
        } catch (e) {
            return;
        }

        const name = parseNetworkName(result.stdout);
        if (name) {
            this._networkLabel.text = name;
            this._networkLabel.visible = true;
        }
    }

    _startPolling() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = null;
        }
        const seconds = this._settings.get_int('poll-interval-seconds');
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _buildMenu() {
        const headerItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const headerBox = new St.BoxLayout({style_class: 'twingate-header-box', x_expand: true});

        const infoBox = new St.BoxLayout({style_class: 'twingate-info-box', vertical: true});

        const logoContainer = new St.BoxLayout();
        const wordmarkPath = GLib.build_filenamev([this._extensionPath, 'icons', 'twingate-wordmark.png']);
        const logo = new St.Widget({
            style_class: 'twingate-header-logo',
            style: `background-image: url("file://${wordmarkPath}");`,
        });
        logoContainer.add_child(logo);
        infoBox.add_child(logoContainer);

        const subtitleRow = new St.BoxLayout({style_class: 'twingate-subtitle-row'});

        this._networkLabel = new St.Label({
            style_class: 'twingate-network-label',
            text: '',
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        subtitleRow.add_child(this._networkLabel);

        this._statusDot = createDot('twingate-dot-offline');
        subtitleRow.add_child(this._statusDot);

        infoBox.add_child(subtitleRow);

        headerBox.add_child(infoBox);

        const spacer = new St.Widget({x_expand: true});
        headerBox.add_child(spacer);

        const settingsButton = new St.Button({
            style_class: 'twingate-settings-button',
            child: new St.Icon({
                icon_name: 'preferences-system-symbolic',
                style_class: 'popup-menu-icon',
            }),
        });
        settingsButton.connect('clicked', () => {
            this.menu.close();
            this._onOpenPreferences?.();
        });
        headerBox.add_child(settingsButton);

        headerItem.add_child(headerBox);
        this.menu.addMenuItem(headerItem);

        this._switchItem = new PopupMenu.PopupSwitchMenuItem('Connected', false);
        this._switchItem.connect('toggled', (_item, state) => {
            if (this._suppressToggle)
                return;
            this._onToggle(state);
        });
        this.menu.addMenuItem(this._switchItem);

        this._resourcesSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._resourcesSeparator);

        this._resourcesHeader = new PopupMenu.PopupMenuItem('Resources', {
            reactive: false,
            can_focus: false,
        });
        this._resourcesHeader.label.add_style_class_name('twingate-resources-header');
        this._resourcesHeader.visible = false;
        this.menu.addMenuItem(this._resourcesHeader);

        this._resourcesSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._resourcesSection);
    }

    _setState(token) {
        const info = statusInfoFor(token);

        for (const cls of DOT_CLASSES)
            this._statusDot.remove_style_class_name(cls);
        this._statusDot.add_style_class_name(info.dotClass);

        this._suppressToggle = true;
        this._switchItem.setToggleState(info.connected);
        this._suppressToggle = false;
    }

    _setResources(resources) {
        this._resourcesSection.removeAll();
        this._resourcesHeader.visible = resources.length > 0;

        this._resourceGeneration++;
        const generation = this._resourceGeneration;

        for (const {name, address} of resources) {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            const box = new St.BoxLayout({style_class: 'twingate-resource-box', x_expand: true});

            const label = new St.Label({
                style_class: 'twingate-resource-label',
                text: `${name} · ${address}`,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            box.add_child(label);

            const pingDot = createDot('twingate-dot-pending');
            box.add_child(pingDot);

            item.add_child(box);
            this._resourcesSection.addMenuItem(item);

            pingAddress(address, this._cancellable).then(reachable => {
                if (this._resourceGeneration !== generation)
                    return;
                for (const cls of PING_CLASSES)
                    pingDot.remove_style_class_name(cls);
                pingDot.add_style_class_name(reachable ? 'twingate-dot-reachable' : 'twingate-dot-unreachable');
            }).catch(() => {});
        }
    }

    _onToggle(wantConnected) {
        this._runPrivileged(wantConnected ? 'start' : 'stop');
    }

    async _runPrivileged(action) {
        if (this._busy)
            return;
        this._busy = true;

        const binary = this._settings.get_string('twingate-binary');
        const argv = this._settings.get_boolean('use-pkexec')
            ? ['pkexec', binary, action]
            : ['sudo', '-n', binary, action];

        try {
            await runCommand(argv, this._cancellable);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
        } finally {
            this._busy = false;
        }

        // The daemon may take a moment to reflect the new state; poll a
        // couple more times shortly after the action.
        this._scheduleQuickRefreshes();
    }

    _scheduleQuickRefreshes() {
        for (const delay of [2, 5]) {
            const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
                this._pendingRefreshIds.delete(id);
                this._refresh();
                return GLib.SOURCE_REMOVE;
            });
            this._pendingRefreshIds.add(id);
        }
    }

    async _refresh() {
        const binary = this._settings.get_string('twingate-binary');
        let result;
        try {
            result = await runCommand([binary, '-d', 'status'], this._cancellable);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this._setState('unknown');
            return;
        }

        if (!result.success && result.stdout.length === 0) {
            this._setState('unknown');
            return;
        }

        const token = parseStatusToken(result.stdout);
        this._setState(token);

        if (statusInfoFor(token).connected)
            this._refreshResources();
        else
            this._setResources([]);
    }

    async _refreshResources() {
        const binary = this._settings.get_string('twingate-binary');
        let result;
        try {
            result = await runCommand([binary, '-d', 'resources'], this._cancellable);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this._setResources([]);
            return;
        }

        this._setResources(parseResources(result.stdout));
    }

    destroy() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = null;
        }
        for (const id of this._pendingRefreshIds)
            GLib.Source.remove(id);
        this._pendingRefreshIds.clear();

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        this._cancellable.cancel();

        super.destroy();
    }
});

export default class TwingatePanelExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this.path, this.getSettings(), () => this.openPreferences());
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
