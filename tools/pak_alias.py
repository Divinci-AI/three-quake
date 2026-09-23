#!/usr/bin/env python3
"""Copy files out of a .pak under new names: pak_alias.py SRC.pak DEST_DIR target=source ..."""
import os, struct, sys

def read_pak(path):
    b = open(path, "rb").read()
    assert b[:4] == b"PACK", f"{path} is not a pak"
    ofs, ln = struct.unpack("<ii", b[4:12])
    out = {}
    for i in range(ln // 64):
        name, fpos, flen = struct.unpack("<56sii", b[ofs + i * 64: ofs + (i + 1) * 64])
        out[name.split(b"\0")[0].decode()] = b[fpos:fpos + flen]
    return out

files = read_pak(sys.argv[1])
dest = sys.argv[2]
for pair in sys.argv[3:]:
    target, source = pair.split("=", 1)
    if source not in files:
        sys.exit(f"{source} is not in {sys.argv[1]}")
    path = os.path.join(dest, target)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "wb").write(files[source])
    print(f"  stand-in {target} <- {source}")
