// SPDX-License-Identifier: GPL-2.0-or-later
//
// Top Bar Tidy
//  1. hidden-indicators: hides chosen status icons in the quick-settings icon row (next to Wi-Fi/battery) while
//     keeping their toggles in the quick settings menu. Owners flip visibility on their own (GSConnect shows its
//     icon whenever a device connects), so hidden ones are held hidden. ServiceIndicator = GSConnect.
//  2. overflow-items: an arrow button just left of the system icons (Wi-Fi, battery). Listed buttons are grouped
//     right next to it and stay tucked away until the arrow is clicked, then slide out to its left (they stay real
//     top-bar buttons, so their menus work as usual); click again to tuck them back. Entries are status-area roles, or for app tray icons
//     "title:NAME" / "id:ID" (AppIndicator title or id; their roles contain a PID and change on every restart).
//     always-show-arrow (S9, 2026-10-22, default on): the arrow stays when nothing is tucked, so there is always
//     somewhere to drop an icon. Without it he took the last tucked icon (WARP) out, the arrow went, and nothing
//     could be tucked again ("now the arrow for top bar tidy is no longer showing so i have no way to move warp icon
//     back into it"). Off: the old behaviour, no arrow while nothing is tucked.
//  3. Super+drag (like Cmd+drag on macOS) any icon on the right side to reorder it; the order is saved (order).
//     Drop it on the arrow to tuck it away; with the arrow open, drag a tucked icon out of the group to un-tuck it.
//     A mouse press while Super is held cancels Super's overview, so the drag doesn't open the overview.
//  4. auto-hide-seconds: opened icons tuck themselves away again after that many seconds (0 = never), but not
//     while the pointer is over the arrow or a revealed icon, or one of their menus is open.
//
// Merged into the AppIndicator fork (2026-10-28) from top-bar-tidy@proxblox, so the tray icons and the code that
// tucks them away are set up and torn down in one known order. As two extensions, GNOME disabled Top Bar Tidy first
// on every screen lock; its disable() un-hid the tray icons, and AppIndicator then destroyed them while their
// "wait until shown" promises were still running ("this._indicator is null").

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const ARROW_ROLE = 'top-bar-tidy-overflow';

const OverflowArrow = GObject.registerClass(
class OverflowArrow extends St.Button {
    _init(onToggle) {
        super._init({
            style_class: 'panel-button top-bar-tidy-arrow',
            reactive: true, can_focus: true, track_hover: true,
            accessible_name: 'Show hidden icons',
            y_expand: true,
        });
        this._icon = new St.Icon({icon_name: 'pan-start-symbolic', style_class: 'system-status-icon'});
        this.set_child(this._icon);
        this.connect('clicked', () => onToggle());
    }

    setExpanded(expanded) {
        this._icon.icon_name = expanded ? 'pan-end-symbolic' : 'pan-start-symbolic';
        this.accessible_name = expanded ? 'Hide icons' : 'Show hidden icons';
    }
});

export class TopBarTidy {
    constructor(settings) {
        this._settings = settings;

        // 1. quick-settings icons held hidden
        this._qsBox = Main.panel.statusArea.quickSettings._indicators;
        this._held = new Map();     // indicator -> [notify::visible handler id, destroy handler id]
        this._qsAddedId = this._qsBox.connect('child-added', () => this._applyHidden());

        // 2. overflow arrow + tucked buttons
        this._expanded = false;
        this._hideId = 0;
        this._tucked = new Map();   // container actor -> [notify::visible handler id, destroy handler id]
        this._arrow = new OverflowArrow(() => this._toggle());
        Main.panel._rightBox.add_child(this._arrow);
        this._rightAddedId = Main.panel._rightBox.connect('child-added', () => this._queueOverflow());

        // 3. Super+drag to rearrange
        this._drag = null;
        this._pressId = Main.panel.connect('captured-event', (_a, event) => this._onPanelEvent(event));

        this._settingsId = this._settings.connect('changed', () => {
            this._applyHidden();
            this._applyOverflow();
        });
        this._applyHidden();
        this._applyOverflow();
        // tray icons get their titles a moment after they appear; look again shortly after startup. A look that has
        // run leaves the list, so disable() removes only the ones still waiting (it logged three "Source ID … not
        // found" when disabled more than 15 s after enable, work order 130)
        this._retryIds = [1, 5, 15].map(s => {
            const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, s, () => {
                this._retryIds = this._retryIds.filter(x => x !== id);
                this._applyOverflow();
                return GLib.SOURCE_REMOVE;
            });
            return id;
        });
    }

    destroy() {
        this._stopAutoHide();
        this._endDrag(false);
        Main.panel.disconnect(this._pressId);
        this._retryIds.forEach(id => GLib.source_remove(id));
        this._retryIds = [];
        if (this._idle)
            GLib.source_remove(this._idle);
        this._idle = 0;
        this._settings.disconnect(this._settingsId);
        this._qsBox.disconnect(this._qsAddedId);
        Main.panel._rightBox.disconnect(this._rightAddedId);
        // the destroy handlers too: these actors outlive us, and each enable (every unlock) would add another set
        for (const [ind, ids] of this._held)
            ids.forEach(id => ind.disconnect(id));
        this._held.clear();
        for (const [actor, ids] of this._tucked) {
            ids.forEach(id => actor.disconnect(id));
            actor.visible = true;
        }
        this._tucked.clear();
        this._arrow.destroy();
        this._arrow = null;
        this._settings = null;
    }

    // ---- 1. quick-settings icons

    _applyHidden() {
        const hidden = new Set(this._settings.get_strv('hidden-indicators'));
        for (const ind of this._qsBox.get_children()) {
            const want = hidden.has(ind.constructor.name);
            if (want && !this._held.has(ind)) {
                ind.visible = false;
                const id = ind.connect('notify::visible', () => {
                    if (ind.visible)
                        ind.visible = false;
                });
                const destroyId = ind.connect('destroy', () => this._held.delete(ind));
                this._held.set(ind, [id, destroyId]);
            } else if (!want && this._held.has(ind)) {
                this._held.get(ind).forEach(i => ind.disconnect(i));
                this._held.delete(ind);
            }
        }
    }

    // ---- 2. overflow

    _queueOverflow() {
        if (this._idle)
            return;
        this._idle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idle = 0;
            this._applyOverflow();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Stable keys of a status-area button. Tray icons (AppIndicator) get a role that contains the app's PID, which
     * changes on every restart, so they are keyed by their tray title, or by their tray id when the title is empty
     * (Slack's is). Everything else by its role.
     */
    _keysOf(role, button) {
        const ind = button?._indicator;
        if (!ind)
            return [role];
        const keys = [];
        if (ind.title)
            keys.push(`title:${ind.title}`);
        if (ind.id)
            keys.push(`id:${ind.id}`);
        return keys.length ? keys : [role];
    }

    /** The top-bar actors (button containers) that match overflow-items right now. */
    _overflowActors() {
        const wanted = this._settings.get_strv('overflow-items');
        const found = [];
        for (const [role, button] of Object.entries(Main.panel.statusArea)) {
            const key = this._keysOf(role, button).find(k => wanted.includes(k)) ?? (wanted.includes(role) ? role : null);
            if (key)
                found.push([button.container ?? button, key]);
        }
        // in the order the setting lists them
        found.sort((a, b) => wanted.indexOf(a[1]) - wanted.indexOf(b[1]));
        return found.map(([actor]) => actor);
    }

    _applyOverflow() {
        const box = Main.panel._rightBox;
        const ordered = this._overflowActors();
        const actors = new Set(ordered);
        // release buttons no longer listed
        for (const [actor, ids] of this._tucked) {
            if (!actors.has(actor)) {
                ids.forEach(id => actor.disconnect(id));
                this._tucked.delete(actor);
                actor.visible = true;
            }
        }
        for (const actor of actors) {
            if (!this._tucked.has(actor)) {
                const id = actor.connect('notify::visible', () => {
                    if (!this._expanded && actor.visible)
                        actor.visible = false;
                });
                const destroyId = actor.connect('destroy', () => this._tucked.delete(actor));
                this._tucked.set(actor, [id, destroyId]);
            }
            actor.visible = this._expanded;
        }
        // arrow right before the system icons; tucked buttons (in overflow-items order) right before the arrow
        const system = Main.panel.statusArea.quickSettings?.container;
        if (system?.get_parent() === box)
            box.set_child_below_sibling(this._arrow, system);
        for (const actor of ordered) {
            if (actor.get_parent() === box)
                box.set_child_below_sibling(actor, this._arrow);
        }
        // visible icons in the saved (Super+drag) order
        this._applyOrder();
        // nothing to tuck (e.g. all those apps closed): no arrow, unless it is always shown (the drop target stays)
        this._arrow.visible = this._tucked.size > 0 || this._settings.get_boolean('always-show-arrow');
    }

    // ---- 3. order + Super+drag

    /** Stable key of a right-box child: "title:NAME" for tray icons, else its status-area role. */
    _keyOf(actor) {
        for (const [role, button] of Object.entries(Main.panel.statusArea)) {
            if ((button?.container ?? button) === actor)
                return this._keysOf(role, button)[0];
        }
        return null;
    }

    /** Re-sort the visible, keyed icons by the saved order, within the slots they already occupy. */
    _applyOrder() {
        const order = this._settings.get_strv('order');
        if (!order.length)
            return;
        const box = Main.panel._rightBox;
        const system = Main.panel.statusArea.quickSettings?.container;
        const kids = box.get_children().filter(c => c !== this._arrow && c !== system && !this._tucked.has(c));
        const keyed = kids.map(c => [c, this._keyOf(c)]).filter(([, k]) => k && order.includes(k));
        const slots = keyed.map(([c]) => box.get_children().indexOf(c)).sort((a, b) => a - b);
        const sorted = [...keyed].sort((a, b) => order.indexOf(a[1]) - order.indexOf(b[1]));
        sorted.forEach(([c], i) => box.set_child_at_index(c, slots[i]));
    }

    _draggable(actor) {
        const box = Main.panel._rightBox;
        let a = actor;
        while (a && a.get_parent() !== box)
            a = a.get_parent();
        if (!a || a === this._arrow || a === Main.panel.statusArea.quickSettings?.container)
            return null;
        return this._keyOf(a) ? a : null;
    }

    _onPanelEvent(event) {
        const type = event.type();
        if (!this._drag) {
            if (type !== Clutter.EventType.BUTTON_PRESS || event.get_button() !== Clutter.BUTTON_PRIMARY ||
                !(event.get_state() & Clutter.ModifierType.MOD4_MASK))
                return Clutter.EVENT_PROPAGATE;
            const actor = this._draggable(global.stage.get_event_actor(event));
            if (!actor)
                return Clutter.EVENT_PROPAGATE;
            this._drag = {actor, grab: global.stage.grab(Main.panel)};
            actor.opacity = 140;
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.MOTION) {
            this._dragTo(event.get_coords()[0]);
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_RELEASE) {
            const [x, y] = event.get_coords();
            const [ax, ay] = this._arrow.get_transformed_position();
            const overArrow = this._arrow.visible && x >= ax && x <= ax + this._arrow.width && y >= ay && y <= ay + this._arrow.height;
            this._endDrag(true, overArrow);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_STOP;
    }

    /** Move the dragged icon to the slot under x (left of the arrow and system icons only). */
    _dragTo(x) {
        const box = Main.panel._rightBox;
        const {actor} = this._drag;
        const limit = box.get_children().indexOf(this._arrow);
        let target = 0;
        box.get_children().forEach((c, i) => {
            if (c === actor || i >= limit || !c.visible)
                return;
            const [cx] = c.get_transformed_position();
            if (x > cx + c.width / 2)
                target = i + 1;
        });
        const cur = box.get_children().indexOf(actor);
        if (target > cur)
            target--;
        target = Math.min(target, box.get_children().indexOf(this._arrow) - (cur < limit ? 1 : 0));
        if (target !== cur)
            box.set_child_at_index(actor, target);
    }

    _endDrag(commit, overArrow = false) {
        const d = this._drag;
        this._drag = null;
        if (!d)
            return;
        d.grab.dismiss();
        d.actor.opacity = 255;
        if (!commit)
            return;
        const box = Main.panel._rightBox;
        const key = this._keyOf(d.actor);
        let overflow = this._settings.get_strv('overflow-items').filter(k => k !== key);
        const roleKey = key;
        // membership: dropped on the arrow, or (arrow open) placed inside the tucked group -> tucked
        const kids = box.get_children();
        const tuckedIdx = [...this._tucked.keys()].filter(a => a !== d.actor).map(a => kids.indexOf(a)).filter(i => i >= 0);
        const firstTucked = tuckedIdx.length ? Math.min(...tuckedIdx) : kids.indexOf(this._arrow);
        const tuck = overArrow || (this._expanded && kids.indexOf(d.actor) > firstTucked);
        if (tuck) {
            const before = [...this._tucked.keys()].filter(a => a !== d.actor && kids.indexOf(a) < kids.indexOf(d.actor)).length;
            overflow.splice(overArrow ? overflow.length : before, 0, roleKey);
        }
        // save the visible order left to right
        const visibleOrder = box.get_children()
            .filter(c => c !== this._arrow && !(tuck && c === d.actor) && !this._tucked.has(c) || (c === d.actor && !tuck))
            .map(c => this._keyOf(c)).filter(Boolean);
        this._settings.set_strv('order', visibleOrder);
        this._settings.set_strv('overflow-items', overflow);   // triggers _applyOverflow
    }

    _toggle() {
        this._expanded = !this._expanded;
        this._arrow.setExpanded(this._expanded);
        if (this._expanded)
            this._startAutoHide();
        else
            this._stopAutoHide();
        for (const actor of this._tucked.keys()) {
            actor.visible = this._expanded;
            if (this._expanded) {
                actor.opacity = 0;
                actor.ease({opacity: 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            }
        }
    }

    // 4. auto-hide: re-checked every period; while the icons are in use the period starts over
    _startAutoHide() {
        this._stopAutoHide();
        const seconds = this._settings.get_uint('auto-hide-seconds');
        if (!seconds)
            return;
        this._hideId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            if (!this._expanded) {
                this._hideId = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (this._inUse())
                return GLib.SOURCE_CONTINUE;
            this._hideId = 0;
            this._toggle();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopAutoHide() {
        if (this._hideId)
            GLib.source_remove(this._hideId);
        this._hideId = 0;
    }

    _inUse() {
        if (this._drag)
            return true;
        const [x, y] = global.get_pointer();
        const over = a => {
            if (!a.visible || !a.mapped)
                return false;
            const [ax, ay] = a.get_transformed_position();
            return x >= ax && x < ax + a.width && y >= ay && y < ay + a.height;
        };
        if (over(this._arrow))
            return true;
        for (const actor of this._tucked.keys()) {
            if (over(actor))
                return true;
            const button = Object.values(Main.panel.statusArea).find(b => (b.container ?? b) === actor);
            if (button?.menu?.isOpen)
                return true;
        }
        return false;
    }
}
