// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class TwingatePanelPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: 'Twingate Panel',
            description: 'Behavior of the top-panel indicator.',
        });
        page.add(group);

        const pollRow = new Adw.SpinRow({
            title: 'Poll interval',
            subtitle: 'How often status and resources are refreshed, in seconds',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 60, step_increment: 1}),
        });
        settings.bind('poll-interval-seconds', pollRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(pollRow);

        const pkexecRow = new Adw.SwitchRow({
            title: 'Use pkexec',
            subtitle: 'Show a graphical password prompt for connect/disconnect. Turn off only if you configured passwordless sudo for these commands.',
        });
        settings.bind('use-pkexec', pkexecRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(pkexecRow);

        const binaryRow = new Adw.EntryRow({
            title: 'Twingate binary path',
        });
        settings.bind('twingate-binary', binaryRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(binaryRow);
    }
}
