#!/usr/bin/env python3
"""Private recovery bundles and safe, isolated restore drills. No live restore."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import signal
import stat
import subprocess
import tempfile
from datetime import datetime, timezone
import uuid
import zipfile

MAX_BYTES = 2 * 1024**3
MAX_FILES = 20000
PROFILE_FILES = ['window.json', 'overlay.json', 'quick-window.json', 'screen.json', 'voice.json', 'speech.json']
SOURCE_DIRS = ['src', 'public', 'desktop', 'mobile', 'scripts', 'tests', 'docs']


def safe_name(name):
    p = PurePosixPath(name)
    if not name or '\\' in name or p.is_absolute() or '..' in p.parts or str(p) != name or any(ord(c) < 32 for c in name):
        raise ValueError('Unsafe archive path')
    return p


def restore(archive, destination):
    """Validate everything before writing into a new directory; never follow links."""
    destination = Path(destination).absolute()
    with zipfile.ZipFile(archive) as bundle:
        infos = bundle.infolist()
        names = [i.filename for i in infos]
        if len(infos) > MAX_FILES or len(set(names)) != len(names) or sum(i.file_size for i in infos) > MAX_BYTES:
            raise ValueError('Archive exceeds limits or contains duplicate paths')
        for i in infos:
            safe_name(i.filename)
            if i.file_size > 256 * 1024**2:
                raise ValueError('Recovery file exceeds size limit')
            mode = i.external_attr >> 16
            if i.is_dir() or stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG)) or i.flag_bits & 1:
                raise ValueError('Only ordinary, unencrypted files can be restored')
        if 'manifest.json' not in names or bundle.getinfo('manifest.json').file_size > 8_000_000:
            raise ValueError('Missing or oversized recovery manifest')
        manifest = json.loads(bundle.read('manifest.json'))
        if manifest.get('version') != 1 or set(manifest.get('files', {})) != set(names) - {'manifest.json'}:
            raise ValueError('Recovery manifest does not match archive')
        for name, record in manifest['files'].items():
            if len(PurePosixPath(name).parts) < 2 or PurePosixPath(name).parts[0] not in ['vault', 'data', 'profile', 'source']:
                raise ValueError('Unknown recovery component')
            data = bundle.read(name)
            if len(data) != record['bytes'] or hashlib.sha256(data).hexdigest() != record['sha256']:
                raise ValueError('Recovery file checksum mismatch: ' + name)
        destination.mkdir(mode=0o700, parents=False, exist_ok=False)
        try:
            for name, record in manifest['files'].items():
                target = destination / name
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with target.open('xb') as f:
                    os.fchmod(f.fileno(), 0o700 if record.get('executable') else 0o600)
                    f.write(bundle.read(name))
            (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2))
            os.chmod(destination / 'manifest.json', 0o600)
        except BaseException:
            shutil.rmtree(destination)
            raise
    return {'restored': str(destination), 'files': len(manifest['files']), 'verified': True}


def create(source, vault, data, profile, destination, verify=True):
    roots = {key: Path(value).resolve() for key, value in dict(source=source, vault=vault, data=data, profile=profile).items()}
    destination = Path(destination).resolve()
    if any(destination == p or destination.is_relative_to(p) for p in roots.values()):
        raise ValueError('Keep recovery bundles outside the source, vault, data and profile')
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    archive = destination / ('aurora-recovery-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:8] + '.zip')
    partial = archive.with_suffix('.partial')
    files = {}
    total = 0
    skipped = []
    def add(bundle, path, name):
        nonlocal total
        if path.is_symlink():
            skipped.append(name + ' (symlink)')
            return
        if path.is_dir():
            for child in sorted(path.iterdir()):
                if child.name.startswith(('integrations.json', 'google-calendar-auth.json', 'chatgpt-plan-auth.json')) or child.name.endswith(('.tmp', '.log')) or child.name in ['node_modules', '.git', '__pycache__']:
                    skipped.append(name + '/' + child.name)
                    continue
                add(bundle, child, name + '/' + child.name)
            return
        info = path.stat()
        if not stat.S_ISREG(info.st_mode):
            skipped.append(name + ' (special file)')
            return
        total += info.st_size
        if total > MAX_BYTES or len(files) >= MAX_FILES - 1 or info.st_size > 256 * 1024**2:
            raise ValueError('Recovery exceeds bundle limits')
        # O_NOFOLLOW closes the final-component symlink race; reject changing files.
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as f:
            before = os.fstat(f.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_ino != info.st_ino:
                raise ValueError('File changed during recovery snapshot')
            content = f.read(256 * 1024**2 + 1)
            after = os.fstat(f.fileno())
        if before.st_mtime_ns != after.st_mtime_ns or len(content) != before.st_size:
            raise ValueError('File changed during recovery snapshot; retry when idle')
        safe_name(name)
        bundle.writestr(name, content)
        files[name] = {'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest(), 'executable': bool(info.st_mode & 0o100)}
    try:
        fd = os.open(partial, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as bundle:
                for component in ['vault', 'data']:
                    add(bundle, roots[component], component)
                for name in PROFILE_FILES + ['avatars']:
                    path = roots['profile'] / name
                    if path.exists() or path.is_symlink():
                        add(bundle, path, 'profile/' + name)
                for name in SOURCE_DIRS + ['package.json', 'README.md', '.gitignore']:
                    path = roots['source'] / name
                    if path.exists():
                        add(bundle, path, 'source/' + name)
                if (roots['source'] / '.git').is_dir():
                    with tempfile.TemporaryDirectory(prefix='aurora-git-bundle-') as temp:
                        history = Path(temp) / 'history.bundle'
                        subprocess.run(['git', '-C', str(roots['source']), 'bundle', 'create', str(history), '--all'], check=True, capture_output=True, timeout=30)
                        add(bundle, history, 'source/history.bundle')
                manifest = {'version': 1, 'created': datetime.now(timezone.utc).isoformat(), 'files': files, 'skipped': skipped,
                            'excluded': ['cloud API key configuration', 'browser sessions and cookies', 'model weights and desktop runtime'],
                            'note': 'Private data. Restore is isolated and never starts Aurora or enables saved permissions.'}
                bundle.writestr('manifest.json', json.dumps(manifest, indent=2))
            stream.flush()
            os.fsync(stream.fileno())
        if verify:
            with tempfile.TemporaryDirectory(prefix='aurora-restore-check-') as temp:
                restore(partial, Path(temp) / 'restored')
        partial.rename(archive)
        return {'path': str(archive), 'files': len(files), 'bytes': archive.stat().st_size, 'restoreVerified': verify, 'skipped': len(skipped)}
    finally:
        partial.unlink(missing_ok=True)


if __name__ == '__main__':
    os.umask(0o077)
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(1)))
    home = Path.home()
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    make = commands.add_parser('create')
    for name, default in dict(source=Path(__file__).resolve().parent.parent, vault=home/'Documents/Aurora Memory', data=home/'.local/share/aurora-assistant', profile=home/'.config/aurora-assistant', destination=home/'Documents/Aurora Backups').items():
        make.add_argument('--' + name, default=str(default))
    extract = commands.add_parser('restore')
    extract.add_argument('archive')
    extract.add_argument('destination', help='A new directory that does not already exist')
    args = vars(parser.parse_args())
    command = args.pop('command')
    try:
        print(json.dumps(create(**args) if command == 'create' else restore(**args), indent=2))
    except Exception as error:
        parser.exit(1, 'Recovery failed: ' + str(error) + '\n')
