#!/bin/bash
# Headless lock/unlock test of AppIndicator + Top Bar Tidy, in a private gnome-shell (pattern from
# px-13-linux/extensions/top-bar-tidy/tests/headless.sh).  usage: lockcycle-test.sh new|old
# "new" runs the build staged with: DESTDIR=$PWD/stage meson install -C build. "old" runs the installed upstream
# AppIndicator + the separate top-bar-tidy@proxblox, which show the "_indicator is null" errors on each cycle.
MODE=$1; S=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$S/../.." && pwd); W=${XDG_RUNTIME_DIR:-/tmp}/ai-lockcycle-$MODE
EXT=$W/data/gnome-shell/extensions
for p in $(pgrep -x gnome-shell); do tr '\0' '\n' </proc/$p/environ 2>/dev/null | grep -q "^XDG_RUNTIME_DIR=$W/run$" && kill -9 $p; done
rm -rf "$W"; mkdir -p "$W"/{config,data/gnome-shell/extensions,cache,state,run}; chmod 700 "$W/run"
if [ "$MODE" = new ]; then
    cp -r "$REPO/stage$HOME/.local/share/gnome-shell/extensions/appindicatorsupport@proxblox" "$EXT/"
    ENABLED="['appindicatorsupport@proxblox']"; TIDY="lookup('appindicatorsupport@proxblox').stateObj._topBarTidy"
else
    cp -r ~/.local/share/gnome-shell/extensions/appindicatorsupport@rgcjonas.gmail.com "$EXT/"
    cp -r ~/projects/personal/px-13-linux/extensions/top-bar-tidy/top-bar-tidy@proxblox "$EXT/"
    glib-compile-schemas "$EXT/top-bar-tidy@proxblox/schemas"
    ENABLED="['appindicatorsupport@rgcjonas.gmail.com', 'top-bar-tidy@proxblox']"; TIDY="lookup('top-bar-tidy@proxblox').stateObj"
fi
DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus" notify-send -a "Hidden desktop" "Hidden desktop: clood, AppIndicator lock-cycle test ($MODE), about 60 s" 2>/dev/null || true
setsid env -i HOME="$HOME" USER="$USER" PATH=/usr/local/bin:/usr/bin:/bin LANG=en_US.UTF-8 \
  XDG_CONFIG_HOME="$W/config" XDG_DATA_HOME="$W/data" XDG_CACHE_HOME="$W/cache" XDG_STATE_HOME="$W/state" XDG_RUNTIME_DIR="$W/run" XDG_SESSION_TYPE=wayland \
  dbus-run-session -- bash -c "{ [ \"\$XDG_RUNTIME_DIR\" = \"$W/run\" ]; } || exit 97; gsettings set org.gnome.shell enabled-extensions \"$ENABLED\"; gsettings set org.gnome.shell disable-user-extensions false; exec nice -n 15 timeout 75 gnome-shell --headless --wayland --no-x11 --virtual-monitor 1920x1200 --unsafe-mode" > "$W/shell.log" 2>&1 < /dev/null &
P=; B=
for i in $(seq 1 30); do sleep 1
    P=$(for p in $(pgrep -x gnome-shell); do tr '\0' '\n' </proc/$p/environ 2>/dev/null | grep -q "^XDG_RUNTIME_DIR=$W/run$" && echo $p; done | head -1)
    [ -n "$P" ] && B=$(tr '\0' '\n' </proc/$P/environ | sed -n 's/^DBUS_SESSION_BUS_ADDRESS=//p') && \
        DBUS_SESSION_BUS_ADDRESS=$B gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "(Main.extensionManager.$TIDY?._settings ? 1 : 0)" 2>/dev/null | grep -q "'1'" && break
    P=
done
[ -n "$P" ] || { echo "shell did not start"; tail -20 "$W/shell.log"; exit 1; }
ev(){ DBUS_SESSION_BUS_ADDRESS=$B gdbus call --session --timeout 10 --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" | sed -E "s/^\(true, '\"?//; s/\"?'\)$//"; }
pass=0; fail=0; check(){ if [ "$2" = "$3" ]; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1  (got: $2, want: $3)"; fail=$((fail+1)); fi; }
X="Main.extensionManager.$TIDY"
WD=$(ls "$W/run" | grep -m1 '^wayland-[0-9]$')
env -i HOME="$HOME" PATH=/usr/bin:/bin XDG_RUNTIME_DIR="$W/run" WAYLAND_DISPLAY="$WD" GDK_BACKEND=wayland DBUS_SESSION_BUS_ADDRESS="$B" \
    timeout 70 gjs -m "$S/tray-app.js" > "$W/tray.log" 2>&1 &
ev "($X)._settings.set_strv('overflow-items', ['id:lockcycle-test']); 'x'" >/dev/null
icon(){ ev "(() => { const b = Object.values(Main.panel.statusArea).find(b => b?._indicator?.id === 'lockcycle-test'); return b ? String(b.container.visible) : 'none'; })()"; }
for i in $(seq 1 15); do sleep 1; [ "$(icon)" != none ] && break; done
check "tray icon appears, tucked" "$(icon)" "false"
ev "Main.overview.hide(); 'x'" >/dev/null
for n in 1 2 3; do
    ev "Main.sessionMode.pushMode('unlock-dialog'); 'x'" >/dev/null; sleep 1
    ev "Main.sessionMode.popMode('unlock-dialog'); 'x'" >/dev/null; sleep 3
done
for i in $(seq 1 10); do [ "$(icon)" = false ] && break; sleep 1; done
check "after 3 lock/unlock cycles: icon back and tucked" "$(icon)" "false"
check "exactly one arrow" "$(ev "String(Main.panel._rightBox.get_children().filter(c => c.has_style_class_name?.('top-bar-tidy-arrow')).length)")" "1"
check "no '_indicator is null'" "$(grep -c '_indicator is null' "$W/shell.log")" "0"
check "no 'already disposed'" "$(grep -c 'already disposed' "$W/shell.log")" "0"
check "no JS ERROR" "$(grep -c 'JS ERROR' "$W/shell.log")" "0"
echo "=== $MODE: $pass passed, $fail failed  (log: $W/shell.log)"
kill $P 2>/dev/null
