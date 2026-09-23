#!/usr/bin/env bash
# Build frogbot.pak for ?pak=frogbot.pak from Frogbot FBCA v2 source (GPL,
# https://github.com/DrLex0/quake-frogbots) plus frogbot/jev-hook.patch, which
# adds the per-bot jev_goal / jev_enemy fields the Jev mind writes.
#
# Needs FTEQCC. Set FTEQCC=/path/to/fteqcc.bin, or it is built from
# https://github.com/fte-team/fteqw into the temp dir (a small C build).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
upstream="$(cat "$here/frogbot/UPSTREAM_COMMIT")"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT

git clone -q https://github.com/DrLex0/quake-frogbots.git "$work/src"
git -C "$work/src" checkout -q "$upstream"
git -C "$work/src" apply "$here/frogbot/jev-hook.patch"

fteqcc="${FTEQCC:-}"
if [[ -z "$fteqcc" ]]; then
  git clone -q --depth 1 https://github.com/fte-team/fteqw.git "$work/fteqw"
  make -s -C "$work/fteqw/engine/qclib" qcc >/dev/null
  fteqcc="$work/fteqw/engine/qclib/fteqcc.bin"
fi

mkdir -p "$work/src/Release/quake"
( cd "$work/src/src" && "$fteqcc" -DQUAKE=1 -O3 -srcfile progs-quake.src | tail -1 )

root="$work/pak"; mkdir -p "$root"
cp "$work/src/Release/quake/progs.dat" "$root/progs.dat"
cp "$work/src/frogbot-quake.cfg" "$root/frogbot.cfg"
cp -R "$work/src/configs-quake" "$work/src/sound" "$work/src/gfx" "$root/"
cp "$work/src/LICENSE.txt" "$root/frogbot-LICENSE.txt"

# Frogbot precaches registered-game assets the shareware pak0 lacks. Stand in
# for them from the local pak0 so the precache succeeds; with a registered
# pak1.pak the real files win (later packs override earlier ones).
if [[ ! -f "$here/pak1.pak" ]]; then
  python3 "$here/tools/pak_alias.py" "$here/pak0.pak" "$root" \
    progs/end2.mdl=progs/end1.mdl progs/end3.mdl=progs/end1.mdl progs/end4.mdl=progs/end1.mdl \
    progs/laser.mdl=progs/spike.mdl \
    sound/enforcer/enfire.wav=sound/weapons/spike2.wav \
    sound/enforcer/enfstop.wav=sound/weapons/tink1.wav \
    sound/boss2/pop2.wav=sound/misc/null.wav
fi
python3 "$here/tools/mkpak.py" "$here/frogbot.pak" "$root"
