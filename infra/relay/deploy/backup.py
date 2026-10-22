#!/usr/bin/env python3
"""Snapshot a local relay without copying an open WAL database."""
import argparse
import json
from pathlib import Path
import shutil
import sqlite3

parser = argparse.ArgumentParser()
parser.add_argument('config', type=Path)
parser.add_argument('destination', type=Path)
args = parser.parse_args()
config = json.loads(args.config.read_text())
state = Path(config['stateDir'])
args.destination.mkdir(mode=0o700, parents=True, exist_ok=False)
with sqlite3.connect(f'file:{state / "relay.sqlite"}?mode=ro', uri=True) as source:
    with sqlite3.connect(args.destination / 'relay.sqlite') as target:
        source.backup(target)
        if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('Backup database failed integrity check')
for name in ('owner-secret',):
    shutil.copyfile(state / name, args.destination / name)
shutil.copyfile(args.config, args.destination / 'config.json')
for path in args.destination.iterdir():
    path.chmod(0o600)
print(f'Backup verified: {args.destination}')
