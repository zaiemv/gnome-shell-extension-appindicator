// SPDX-License-Identifier: GPL-2.0-or-later
/* exported TopBarTidyPage */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';

export var TopBarTidyPage = GObject.registerClass(
class AppIndicatorTopBarTidyPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({
            title: 'Top Bar Tidy',
            icon_name: 'view-more-horizontal-symbolic',
            name: 'Top Bar Tidy Page',
        });

        const group = new Adw.PreferencesGroup({
            title: 'Tucked icons',
            description: 'Icons behind the arrow. Super+drag an icon onto the arrow to tuck it away.',
        });
        const row = new Adw.SpinRow({
            title: 'Hide again after',
            subtitle: 'Seconds after you open the arrow (0 = stay open). Waits while you are using an icon.',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 600, step_increment: 5, page_increment: 30}),
        });
        settings.bind('auto-hide-seconds', row, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(row);
        const always = new Adw.SwitchRow({
            title: 'Always show the arrow',
            subtitle: 'Also when nothing is tucked away, so there is always somewhere to drop an icon',
        });
        settings.bind('always-show-arrow', always, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(always);
        this.add(group);
    }
});
