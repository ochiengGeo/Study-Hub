#!/usr/bin/env python3
"""Automatic snapshots of the sync hub (sync-data/), the one place that holds everything.

serve.py takes a snapshot when it starts and once a day while it runs. Snapshots are plain
folders in ~/StudyHub-backups/<date>/ (open them with any file manager). Files (PDFs, photos)
never change once synced, so each snapshot hard-links them instead of copying: a snapshot
costs almost no extra disk space, yet each one is complete on its own.

Kept: one per day for the last 7 days, then one per week for 8 weeks, then one per month for
a year. Your API key is not part of a snapshot (sync-data/gemini-key only names its file).

This guards against a bad sync, an accidental delete, or a broken db.json. It is on the same
disk, so for a dead laptop copy ~/StudyHub-backups/ to a USB stick or cloud drive now and then.

  python3 backup.py              list snapshots
  python3 backup.py now          take one now
  python3 backup.py restore DATE put a snapshot back (stop ./run.sh first)
"""
import datetime
import json
import os
import shutil
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'sync-data')
DEST = os.path.expanduser(os.environ.get('STUDYHUB_BACKUPS', '~/StudyHub-backups'))
SKIP = {'gemini-key'}                       # never put the key (or its path) in a backup
DAILY, WEEKLY, MONTHLY = 7, 8, 12


def _summary(folder):
    try:
        with open(os.path.join(folder, 'db.json'), encoding='utf-8') as f:
            items = json.load(f).get('items', {}).values()
    except (OSError, ValueError):
        return {}
    out = {}
    for v in items:
        if not v.get('deleted'):
            out[v['store']] = out.get(v['store'], 0) + 1
    return out


def snapshot(data=DATA, dest=DEST, lock=None):
    """Copy sync-data into dest/<YYYY-MM-DD_HHMM>/. Returns the new folder."""
    os.makedirs(dest, exist_ok=True)
    name = datetime.datetime.now().strftime('%Y-%m-%d_%H%M')
    tmp = os.path.join(dest, f'.{name}.partial')
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(os.path.join(tmp, 'blobs'))
    prev = latest(dest)
    # the small files, copied while the hub can't write them
    if lock:
        lock.acquire()
    try:
        for n in os.listdir(data):
            p = os.path.join(data, n)
            if os.path.isfile(p) and n not in SKIP and not n.endswith(('.tmp', '.part')):
                shutil.copy2(p, os.path.join(tmp, n))
    finally:
        if lock:
            lock.release()
    # files: hard link (same disk) or copy; reuse the previous snapshot's link when unchanged
    src_blobs = os.path.join(data, 'blobs')
    for n in os.listdir(src_blobs) if os.path.isdir(src_blobs) else []:
        if n.endswith('.part'):
            continue
        src, dst = os.path.join(src_blobs, n), os.path.join(tmp, 'blobs', n)
        try:
            os.link(src, dst)
        except OSError:
            shutil.copy2(src, dst)
    final = os.path.join(dest, name)
    if os.path.exists(final):
        shutil.rmtree(final)
    os.replace(tmp, final)
    with open(os.path.join(final, 'SNAPSHOT.txt'), 'w', encoding='utf-8') as f:
        f.write(f'StudyHub snapshot {name}\nContents: {json.dumps(_summary(final))}\n'
                f'Restore: python3 {os.path.join(HERE, "backup.py")} restore {name}\n')
    prune(dest)
    return final, prev


def snapshots(dest=DEST):
    if not os.path.isdir(dest):
        return []
    return sorted(n for n in os.listdir(dest) if not n.startswith('.') and os.path.isfile(os.path.join(dest, n, 'db.json')))


def latest(dest=DEST):
    s = snapshots(dest)
    return os.path.join(dest, s[-1]) if s else None


def prune(dest=DEST):
    """Keep the newest per day (7 days), per ISO week (8 weeks), per month (12 months)."""
    names = snapshots(dest)
    when = {n: datetime.datetime.strptime(n, '%Y-%m-%d_%H%M') for n in names}
    keep = set()
    for bucket, count in ((lambda d: d.date(), DAILY), (lambda d: d.isocalendar()[:2], WEEKLY),
                          (lambda d: (d.year, d.month), MONTHLY)):
        seen = []
        for n in sorted(names, reverse=True):
            b = bucket(when[n])
            if b not in seen:
                seen.append(b)
                if len(seen) <= count:
                    keep.add(n)
    for n in names:
        if n not in keep:
            shutil.rmtree(os.path.join(dest, n), ignore_errors=True)


def age_hours(dest=DEST):
    s = snapshots(dest)
    if not s:
        return None
    return (time.time() - datetime.datetime.strptime(s[-1], '%Y-%m-%d_%H%M').timestamp()) / 3600


class AutoBackup:
    """Used by serve.py: a snapshot at start (if the last is over an hour old) and every 24 h."""
    def __init__(self, hub):
        self.hub = hub
        self.last = None
        self.error = ''

    def run_once(self):
        try:
            folder, _ = snapshot(self.hub.dir, DEST, self.hub.lock)
            self.last, self.error = os.path.basename(folder), ''
            sys.stderr.write(f'💾 Backup saved: {folder}\n')
        except Exception as e:
            self.error = f'{type(e).__name__}: {e}'
            sys.stderr.write(f'💾 Backup FAILED: {self.error}\n')

    def _loop(self):
        while True:
            h = age_hours()
            if h is None or h >= 24 or (h >= 1 and self.last is None):
                self.run_once()
            time.sleep(3600)

    def start(self):
        threading.Thread(target=self._loop, name='backup', daemon=True).start()

    def status(self):
        s = snapshots()
        return {'dir': DEST, 'count': len(s), 'latest': s[-1] if s else None, 'error': self.error}


def restore(name):
    import socket
    with socket.socket() as s:
        s.settimeout(0.5)
        if s.connect_ex(('127.0.0.1', int(os.environ.get('PORT', 8000)))) == 0:
            sys.exit('StudyHub is running. Stop ./run.sh (Ctrl+C) first, then restore.')
    src = os.path.join(DEST, name)
    if not os.path.isfile(os.path.join(src, 'db.json')):
        sys.exit(f'No snapshot called {name}. Run: python3 backup.py')
    if os.path.exists(DATA):
        aside = f'{DATA}.before-restore-{datetime.datetime.now():%Y-%m-%d_%H%M%S}'
        key = os.path.join(DATA, 'gemini-key')
        os.replace(DATA, aside)
        print(f'Current sync-data moved to {aside}')
    else:
        key = None
    shutil.copytree(src, DATA, ignore=shutil.ignore_patterns('SNAPSHOT.txt'))
    if key and os.path.exists(key.replace(DATA, aside)):
        shutil.copy2(key.replace(DATA, aside), os.path.join(DATA, 'gemini-key'))
    print(f'Restored {name}: {_summary(DATA)}')
    print('Start ./run.sh phone again. Note: devices sync whatever they changed since, on top of this.')


def main():
    args = sys.argv[1:]
    if not args:
        s = snapshots()
        print(f'Snapshots in {DEST}:' if s else f'No snapshots yet in {DEST}.')
        for n in s:
            print(f'  {n}   {_summary(os.path.join(DEST, n))}')
    elif args[0] == 'now':
        folder, _ = snapshot()
        print(f'Saved {folder}  {_summary(folder)}')
    elif args[0] == 'restore' and len(args) == 2:
        restore(args[1])
    else:
        print(__doc__)


if __name__ == '__main__':
    main()
