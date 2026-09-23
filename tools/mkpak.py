#!/usr/bin/env python3
"""Write a Quake .pak: mkpak.py OUT.pak ROOT_DIR  (every file under ROOT_DIR, path relative to it)."""
import os, struct, sys

def main(out, root):
    files = []
    for dirpath, _, names in os.walk(root):
        for n in sorted(names):
            full = os.path.join(dirpath, n)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            if len(rel) > 55:
                sys.exit(f"path too long for a pak entry (max 55): {rel}")
            files.append((rel, open(full, "rb").read()))
    body, entries, pos = b"", [], 12
    for rel, data in files:
        entries.append((rel, pos, len(data)))
        body += data
        pos += len(data)
    directory = b"".join(struct.pack("<56sii", rel.encode(), ofs, ln) for rel, ofs, ln in entries)
    with open(out, "wb") as f:
        f.write(b"PACK" + struct.pack("<ii", 12 + len(body), len(directory)) + body + directory)
    print(f"{out}: {len(files)} files, {os.path.getsize(out)} bytes")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
