// Minimal StatusNotifierItem tray icon for the lock-cycle test
import Gtk from 'gi://Gtk?version=3.0';
import AppIndicator from 'gi://AyatanaAppIndicator3?version=0.1';

Gtk.init(null);
const indicator = AppIndicator.Indicator.new('lockcycle-test', 'mail-unread-symbolic',
    AppIndicator.IndicatorCategory.APPLICATION_STATUS);
indicator.set_status(AppIndicator.IndicatorStatus.ACTIVE);
const menu = new Gtk.Menu();
menu.append(new Gtk.MenuItem({label: 'item', visible: true}));
indicator.set_menu(menu);
Gtk.main();
