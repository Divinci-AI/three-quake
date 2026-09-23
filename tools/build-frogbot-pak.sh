#!/usr/bin/env bash
# Build frogbot.pak (GPL, https://github.com/DrLex0/quake-frogbots) for ?pak=frogbot.pak
set -euo pipefail
VERSION="${FROGBOT_VERSION:-v2.0b4}"
here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
gh release download "$VERSION" -R DrLex0/quake-frogbots -p "frogbot_${VERSION}-progs.tgz" -D "$work"
tar xzf "$work"/frogbot_*-progs.tgz -C "$work"
git clone --depth 1 -q https://github.com/DrLex0/quake-frogbots.git "$work/src"
root="$work/pak"; mkdir -p "$root"
cp "$work/Release/quake/progs.dat" "$root/progs.dat"
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
