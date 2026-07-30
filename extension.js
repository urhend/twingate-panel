// SPDX-License-Identifier: GPL-3.0-or-later
// Twingate Panel — GNOME Shell extension
// Copyright (C) 2026 the Twingate Panel contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

import GObject from "gi://GObject";
import St from "gi://St";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Clutter from "gi://Clutter";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

Gio._promisify(Gio.Subprocess.prototype, "communicate_utf8_async");

// ---- Configuration ---------------------------------------------------------
// Runtime values (poll interval, pkexec vs sudo, binary path) live in
// GSettings — see schemas/org.gnome.shell.extensions.twingate-panel.gschema.xml
// and prefs.js. There are no hardcoded defaults here anymore.

// ---- Status → UI mapping --------------------------------------------------
// The panel icon is static; the connection status is shown as a colored
// dot next to the network name in the dropdown header.

const STATUS_INFO = {
  "not-running": { label: "Not running", connected: false, dotColor: "#9a9996" },
  offline: { label: "Offline", connected: false, dotColor: "#9a9996" },
  online: { label: "Online", connected: true, dotColor: "#33d17a" },
  connecting: { label: "Connecting…", connected: false, dotColor: "#f5c211" },
  authenticating: {
    label: "Authenticating…",
    connected: false,
    dotColor: "#f5c211",
  },
  unknown: { label: "Unknown", connected: false, dotColor: "#9a9996" },
};

// Coarser grouping used only for deciding when to send a notification —
// "connecting"/"authenticating" are transitional and intentionally absent,
// so they neither trigger a notification nor reset the baseline.
const NOTIFY_CATEGORY = {
  online: "connected",
  "not-running": "disconnected",
  offline: "disconnected",
  unknown: "error",
};

const PING_CLASSES = [
  "twingate-dot-pending",
  "twingate-dot-reachable",
  "twingate-dot-unreachable",
];
const DOT_SIZE = 7;
// When the menu is closed, nobody is looking at the status dot, so poll
// less often — this many times slower than the configured interval.
const BACKGROUND_POLL_MULTIPLIER = 6;

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
    return { success: false, stdout: "", stderr: e.message ?? String(e) };
  }

  try {
    const [stdout, stderr] = await proc.communicate_utf8_async(
      null,
      cancellable,
    );
    return {
      success: proc.get_successful(),
      stdout: stdout ?? "",
      stderr: stderr ?? "",
    };
  } catch (e) {
    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) throw e;
    return { success: false, stdout: "", stderr: e.message ?? String(e) };
  }
}

function parseStatusToken(stdout) {
  const firstLine =
    (stdout ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  // Be defensive: lowercase, take the first "word-ish" token in case the
  // CLI prepends extra text in some version.
  const token = firstLine.toLowerCase().split(/\s+/)[0] ?? "";
  return token in STATUS_INFO ? token : "unknown";
}

/** Returns true if a single ICMP echo request got a reply within 1s. */
async function pingAddress(address, cancellable) {
  try {
    const result = await runCommand(
      ["ping", "-c", "1", "-W", "1", address],
      cancellable,
    );
    return result.success;
  } catch (e) {
    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) throw e;
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
  const lines = (stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (const line of lines) {
    const fields = line.split("\t").map((f) => f.trim());
    if (fields.length < 2 || /^email$/i.test(fields[0])) continue;
    return fields[1];
  }
  return null;
}

function parseResources(stdout) {
  const lines = (stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const rows = [];
  for (const line of lines) {
    const fields = line.split("\t").map((f) => f.trim());
    if (fields.length < 2 || /^resource name$/i.test(fields[0])) continue;
    rows.push({ name: fields[0], address: fields[1] });
  }
  return rows;
}

const Indicator = GObject.registerClass(
  class Indicator extends PanelMenu.Button {
    _init(extensionPath, settings, onOpenPreferences) {
      super._init(0.0, "Twingate Panel", false);

      this._extensionPath = extensionPath;
      this._settings = settings;
      this._onOpenPreferences = onOpenPreferences;
      this._cancellable = new Gio.Cancellable();
      this._timeoutId = null;
      this._pingTimeoutId = null;
      this._pendingRefreshIds = new Set();
      this._suppressToggle = false;
      this._busy = false;
      this._resourceGeneration = 0;
      this._resourceDots = new Map();
      this._allResources = [];
      this._resourceFilter = "";
      this._searchToggledOn = false;
      this._pingStatus = new Map();
      this._previousCategory = null;

      const iconPath = GLib.build_filenamev([
        extensionPath,
        "icons",
        "twingate-panel.png",
      ]);
      this._icon = new St.Icon({
        gicon: Gio.icon_new_for_string(iconPath),
        icon_size: 16,
      });
      this.add_child(this._icon);

      this._buildMenu();
      this._setState("unknown");

      this._refresh();
      this._startPolling();
      this._startPingPolling();
      this._loadNetworkName();

      this._menuOpenStateId = this.menu.connect(
        "open-state-changed",
        (_menu, isOpen) => {
          if (isOpen) this._refresh();
          else this._setSearchVisible(false);
          this._startPolling();
        },
      );
      this._settingsChangedId = this._settings.connect(
        "changed::poll-interval-seconds",
        () => {
          this._startPolling();
        },
      );
      this._pingSettingsChangedId = this._settings.connect(
        "changed::ping-enabled",
        () => {
          this._startPingPolling();
          this._refreshResources();
        },
      );
      this._pingIntervalChangedId = this._settings.connect(
        "changed::ping-interval-seconds",
        () => {
          this._startPingPolling();
        },
      );
    }

    async _loadNetworkName() {
      const binary = this._settings.get_string("twingate-binary");
      let result;
      try {
        result = await runCommand(
          [binary, "-d", "account", "list"],
          this._cancellable,
        );
      } catch (e) {
        return;
      }

      const name = parseNetworkName(result.stdout);
      if (name) this._networkNameLabel.text = name;
    }

    _startPolling() {
      if (this._timeoutId) {
        GLib.Source.remove(this._timeoutId);
        this._timeoutId = null;
      }
      const base = this._settings.get_int("poll-interval-seconds");
      const seconds = this.menu.isOpen ? base : base * BACKGROUND_POLL_MULTIPLIER;
      this._timeoutId = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        seconds,
        () => {
          this._refresh();
          return GLib.SOURCE_CONTINUE;
        },
      );
    }

    _startPingPolling() {
      if (this._pingTimeoutId) {
        GLib.Source.remove(this._pingTimeoutId);
        this._pingTimeoutId = null;
      }
      if (!this._settings.get_boolean("ping-enabled")) return;

      const seconds = this._settings.get_int("ping-interval-seconds");
      this._pingTimeoutId = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        seconds,
        () => {
          this._pingAllResources(this._resourceGeneration);
          return GLib.SOURCE_CONTINUE;
        },
      );
    }

    /**
     * Pings every known resource (regardless of the current search filter),
     * so `_pingStatus` stays fresh even for rows hidden by the filter. Only
     * updates a dot actor live if that address happens to be currently
     * rendered (present in `_resourceDots`).
     */
    _pingAllResources(generation) {
      for (const { address } of this._allResources) {
        if (generation !== this._resourceGeneration) return;
        pingAddress(address, this._cancellable)
          .then((reachable) => {
            if (generation !== this._resourceGeneration) return;
            this._pingStatus.set(address, reachable);
            const dot = this._resourceDots.get(address);
            if (dot) {
              for (const cls of PING_CLASSES) dot.remove_style_class_name(cls);
              dot.add_style_class_name(
                reachable
                  ? "twingate-dot-reachable"
                  : "twingate-dot-unreachable",
              );
            }
          })
          .catch(() => {});
      }
    }

    _buildMenu() {
      const headerItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
      });
      const headerBox = new St.BoxLayout({
        style_class: "twingate-header-box",
        x_expand: true,
      });

      this._networkNameLabel = new St.Label({
        style_class: "twingate-network-title",
        text: "Twingate",
        y_align: Clutter.ActorAlign.CENTER,
      });
      headerBox.add_child(this._networkNameLabel);

      this._statusDot = createDot("");
      headerBox.add_child(this._statusDot);

      const spacer = new St.Widget({ x_expand: true });
      headerBox.add_child(spacer);

      const settingsButton = new St.Button({
        style_class: "twingate-settings-button",
        y_align: Clutter.ActorAlign.START,
        child: new St.Icon({
          icon_name: "preferences-system-symbolic",
          style_class: "popup-menu-icon twingate-header-icon",
        }),
      });
      settingsButton.connect("clicked", () => {
        this.menu.close();
        this._onOpenPreferences?.();
      });
      headerBox.add_child(settingsButton);

      headerItem.add_child(headerBox);
      this.menu.addMenuItem(headerItem);

      this._switchItem = new PopupMenu.PopupSwitchMenuItem("Connected", false);
      this._switchItem.connect("toggled", (_item, state) => {
        if (this._suppressToggle) return;
        this._onToggle(state);
      });
      this.menu.addMenuItem(this._switchItem);

      this._resourcesSeparator = new PopupMenu.PopupSeparatorMenuItem();
      this.menu.addMenuItem(this._resourcesSeparator);

      this._resourcesHeader = new PopupMenu.PopupBaseMenuItem({
        reactive: true,
        can_focus: false,
        activate: false,
      });
      const resourcesHeaderBox = new St.BoxLayout({ x_expand: true });

      const resourcesLabel = new St.Label({
        style_class: "twingate-resources-header",
        text: "Resources",
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
      });
      resourcesHeaderBox.add_child(resourcesLabel);

      const searchToggleButton = new St.Button({
        style_class: "twingate-settings-button",
        child: new St.Icon({
          icon_name: "edit-find-symbolic",
          style_class: "popup-menu-icon twingate-header-icon",
        }),
      });
      searchToggleButton.connect("clicked", () => {
        this._setSearchVisible(!this._resourceSearchItem.visible);
      });
      resourcesHeaderBox.add_child(searchToggleButton);

      this._resourcesHeader.add_child(resourcesHeaderBox);
      this._resourcesHeader.visible = false;
      this.menu.addMenuItem(this._resourcesHeader);

      const searchItem = new PopupMenu.PopupBaseMenuItem({
        reactive: true,
        can_focus: false,
        activate: false,
      });
      this._searchEntry = new St.Entry({
        style_class: "twingate-search-entry",
        hint_text: "Search resources…",
        x_expand: true,
        can_focus: true,
      });
      this._searchEntry.clutter_text.connect("text-changed", () => {
        this._resourceFilter = this._searchEntry
          .get_text()
          .trim()
          .toLowerCase();
        this._renderResourceItems();
      });
      searchItem.add_child(this._searchEntry);
      searchItem.visible = false;
      this.menu.addMenuItem(searchItem);
      this._resourceSearchItem = searchItem;

      this._resourcesSection = new PopupMenu.PopupMenuSection();
      this.menu.addMenuItem(this._resourcesSection);
    }

    _setState(token) {
      const info = statusInfoFor(token);

      this._statusDot.set_style(`background-color: ${info.dotColor};`);

      if (info.connected)
        this._networkNameLabel.add_style_class_name(
          "twingate-network-title-connected",
        );
      else
        this._networkNameLabel.remove_style_class_name(
          "twingate-network-title-connected",
        );

      this._suppressToggle = true;
      this._switchItem.setToggleState(info.connected);
      this._suppressToggle = false;
    }

    _setResources(resources) {
      this._allResources = resources;
      if (resources.length === 0) this._pingStatus.clear();
      this._renderResourceItems();

      const pingEnabled = this._settings.get_boolean("ping-enabled");
      if (pingEnabled && resources.length > 0)
        this._pingAllResources(this._resourceGeneration);
    }

    _setSearchVisible(visible) {
      this._searchToggledOn = visible;
      if (!visible) this._searchEntry.set_text("");
      this._resourceSearchItem.visible =
        visible && this._allResources.length > 0;
      if (visible) this._searchEntry.grab_key_focus();
    }

    /**
     * Rebuilds the visible resource list from `_allResources`, filtered by
     * `_resourceFilter` (case-insensitive substring on name + address).
     * Dot colors come from the persisted `_pingStatus` map rather than
     * always starting "pending" — so filtering doesn't make already-known
     * dots flicker gray again.
     */
    _renderResourceItems() {
      this._resourcesSection.removeAll();

      const hasResources = this._allResources.length > 0;
      this._resourcesHeader.visible = hasResources;
      this._resourceSearchItem.visible = hasResources && this._searchToggledOn;

      this._resourceGeneration++;
      this._resourceDots.clear();

      const pingEnabled = this._settings.get_boolean("ping-enabled");
      const filter = this._resourceFilter;
      const filtered = filter
        ? this._allResources.filter(({ name, address }) =>
            `${name} ${address}`.toLowerCase().includes(filter),
          )
        : this._allResources;

      for (const { name, address } of filtered) {
        const item = new PopupMenu.PopupBaseMenuItem({
          reactive: false,
          can_focus: false,
        });
        const box = new St.BoxLayout({
          style_class: "twingate-resource-box",
          x_expand: true,
        });

        const label = new St.Label({
          style_class: "twingate-resource-label",
          text: `${name} · ${address}`,
          y_align: Clutter.ActorAlign.CENTER,
          x_expand: true,
        });
        box.add_child(label);

        const status = this._pingStatus.get(address);
        const pingClass =
          status === true
            ? "twingate-dot-reachable"
            : status === false
              ? "twingate-dot-unreachable"
              : "twingate-dot-pending";
        const pingDot = createDot(pingClass);
        pingDot.visible = pingEnabled;
        box.add_child(pingDot);

        item.add_child(box);
        this._resourcesSection.addMenuItem(item);

        if (pingEnabled) this._resourceDots.set(address, pingDot);
      }
    }

    _onToggle(wantConnected) {
      this._runPrivileged(wantConnected ? "start" : "stop");
    }

    async _runPrivileged(action) {
      if (this._busy) return;
      this._busy = true;

      const binary = this._settings.get_string("twingate-binary");
      const argv = this._settings.get_boolean("use-pkexec")
        ? ["pkexec", binary, action]
        : ["sudo", "-n", binary, action];

      try {
        await runCommand(argv, this._cancellable);
      } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
      } finally {
        this._busy = false;
      }

      // The daemon may take a moment to reflect the new state; poll a
      // couple more times shortly after the action.
      this._scheduleQuickRefreshes();
    }

    _scheduleQuickRefreshes() {
      for (const delay of [2, 5]) {
        const id = GLib.timeout_add_seconds(
          GLib.PRIORITY_DEFAULT,
          delay,
          () => {
            this._pendingRefreshIds.delete(id);
            this._refresh();
            return GLib.SOURCE_REMOVE;
          },
        );
        this._pendingRefreshIds.add(id);
      }
    }

    async _refresh() {
      const binary = this._settings.get_string("twingate-binary");
      let result;
      try {
        result = await runCommand([binary, "-d", "status"], this._cancellable);
      } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
        this._setState("unknown");
        this._maybeNotifyStateChange("unknown");
        return;
      }

      if (!result.success && result.stdout.length === 0) {
        this._setState("unknown");
        this._maybeNotifyStateChange("unknown");
        return;
      }

      const token = parseStatusToken(result.stdout);
      this._setState(token);
      this._maybeNotifyStateChange(token);

      if (statusInfoFor(token).connected) this._refreshResources();
      else this._setResources([]);
    }

    /**
     * Sends a native notification when the connection category (connected /
     * disconnected / error) actually changes — never on every poll tick, and
     * never for the very first status check after startup (that's just
     * discovering the current state, not a change). Transitional tokens
     * (connecting/authenticating) have no category and are ignored, but
     * don't reset the baseline, so a later real change is still caught.
     */
    _maybeNotifyStateChange(token) {
      const category = NOTIFY_CATEGORY[token] ?? null;
      if (
        category &&
        this._previousCategory !== null &&
        category !== this._previousCategory &&
        this._settings.get_boolean("notifications-enabled")
      ) {
        const network = this._networkNameLabel?.text || "Twingate";
        if (category === "connected")
          Main.notify("Twingate", `Connected to ${network}`);
        else if (category === "disconnected")
          Main.notify("Twingate", "Disconnected");
        else if (category === "error")
          Main.notifyError(
            "Twingate",
            "Something went wrong — check the connection status.",
          );
      }
      if (category) this._previousCategory = category;
    }

    async _refreshResources() {
      const binary = this._settings.get_string("twingate-binary");
      let result;
      try {
        result = await runCommand(
          [binary, "-d", "resources"],
          this._cancellable,
        );
      } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
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
      if (this._pingTimeoutId) {
        GLib.Source.remove(this._pingTimeoutId);
        this._pingTimeoutId = null;
      }
      for (const id of this._pendingRefreshIds) GLib.Source.remove(id);
      this._pendingRefreshIds.clear();
      this._resourceDots.clear();

      if (this._menuOpenStateId) {
        this.menu.disconnect(this._menuOpenStateId);
        this._menuOpenStateId = null;
      }
      if (this._settingsChangedId) {
        this._settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = null;
      }
      if (this._pingSettingsChangedId) {
        this._settings.disconnect(this._pingSettingsChangedId);
        this._pingSettingsChangedId = null;
      }
      if (this._pingIntervalChangedId) {
        this._settings.disconnect(this._pingIntervalChangedId);
        this._pingIntervalChangedId = null;
      }

      this._cancellable.cancel();

      super.destroy();
    }
  },
);

export default class TwingatePanelExtension extends Extension {
  enable() {
    this._indicator = new Indicator(this.path, this.getSettings(), () =>
      this.openPreferences(),
    );
    Main.panel.addToStatusArea(this.uuid, this._indicator);
  }

  disable() {
    this._indicator?.destroy();
    this._indicator = null;
  }
}
