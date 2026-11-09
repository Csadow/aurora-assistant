import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('recovery', Path(__file__).resolve().parent.parent / 'scripts/recovery.py')
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aurora-recovery-test-')
        self.root = Path(self.temp.name)
        for name in ['source', 'vault', 'data', 'profile']:
            (self.root/name).mkdir()
        (self.root/'source/package.json').write_text('{"name":"fixture"}')
        (self.root/'vault/Memory.md').write_text('Important memory.')
        (self.root/'data/workflow.json').write_text('{"status":"paused"}')
        (self.root/'data/followups').mkdir()
        (self.root/'data/followups/draft.json').write_text('{"status":"creating","childId":"reserved-child"}')
        (self.root/'data/task-workflows').mkdir()
        (self.root/'data/task-workflows/link.json').write_text('{"childId":"reserved-child","review":{"status":"pending","intent":{"afterRevision":"saved-note"}}}')
        self.attempts = {'childId': 'second', 'attempts': [{'workflowId': 'first', 'number': 1}, {'workflowId': 'second', 'number': 2}], 'attachment': {'status': 'pending', 'sourceId': 'second', 'targetId': 'third', 'linkRevision': 2}}
        (self.root/'data/task-workflows/attempts.json').write_text(json.dumps(self.attempts))
        (self.root/'source/mobile/web').mkdir(parents=True)
        (self.root/'source/mobile/web/core.js').write_text('export const mobile = true;')
        (self.root/'data/mobile-transfers/exports').mkdir(parents=True)
        (self.root/'data/mobile-transfers/exports/baseline.json').write_text('{"revision":"fixture"}')
        (self.root/'data/google-calendar-auth.json').write_text('OAUTH-MUST-NOT-APPEAR')
        (self.root/'data/google-calendar-auth.json.old').write_text('OLD-OAUTH-MUST-NOT-APPEAR')
        (self.root/'data/chatgpt-plan-auth.json').write_text('CHATGPT-TOKEN-MUST-NOT-APPEAR')
        (self.root/'data/chatgpt-plan-auth.json.old').write_text('OLD-CHATGPT-TOKEN-MUST-NOT-APPEAR')
        (self.root/'data/integrations.json').write_text('KEY-MUST-NOT-APPEAR')
        (self.root/'data/integrations.json.old').write_text('OLD-KEY-MUST-NOT-APPEAR')
        (self.root/'profile/speech.json').write_text('{"muted":true,"rate":1.1,"volume":0.4,"lipSync":true}')
        (self.root/'profile/overlay.json').write_text('{"height":900}')
        (self.root/'profile/avatars').mkdir()
        (self.root/'profile/avatars/model.json').write_text('{"fixture":true}')
        (self.root/'profile/Cookies').write_text('COOKIE-MUST-NOT-APPEAR')
        (self.root/'profile/avatars/link').symlink_to(self.root/'profile/Cookies')

    def tearDown(self):
        self.temp.cleanup()

    def test_private_bundle_restores_all_components_without_keys_sessions_or_links(self):
        result = recovery.create(**{n:self.root/n for n in ['source', 'vault', 'data', 'profile']}, destination=self.root/'backups')
        self.assertTrue(result['restoreVerified'])
        self.assertEqual(stat.S_IMODE(Path(result['path']).stat().st_mode), 0o600)
        destination = self.root/'restored'
        recovery.restore(result['path'], destination)
        self.assertEqual((destination/'vault/Memory.md').read_text(), 'Important memory.')
        self.assertTrue((destination/'profile/avatars/model.json').is_file())
        self.assertTrue((destination/'profile/overlay.json').is_file())
        self.assertTrue(json.loads((destination/'profile/speech.json').read_text())['muted'])
        self.assertTrue((destination/'data/workflow.json').is_file())
        self.assertEqual(json.loads((destination/'data/followups/draft.json').read_text()), {'status': 'creating', 'childId': 'reserved-child'})
        self.assertEqual(json.loads((destination/'data/task-workflows/link.json').read_text()), {'childId': 'reserved-child', 'review': {'status': 'pending', 'intent': {'afterRevision': 'saved-note'}}})
        self.assertEqual(json.loads((destination/'data/task-workflows/attempts.json').read_text()), self.attempts)
        self.assertTrue((destination/'source/package.json').is_file())
        self.assertTrue((destination/'source/mobile/web/core.js').is_file())
        self.assertTrue((destination/'data/mobile-transfers/exports/baseline.json').is_file())
        all_text = ''.join(p.read_text() for p in destination.rglob('*') if p.is_file())
        self.assertNotIn('KEY-MUST-NOT-APPEAR', all_text)
        self.assertNotIn('OAUTH-MUST-NOT-APPEAR', all_text)
        self.assertNotIn('CHATGPT-TOKEN-MUST-NOT-APPEAR', all_text)
        self.assertNotIn('COOKIE-MUST-NOT-APPEAR', all_text)
        self.assertFalse((destination/'profile/avatars/link').exists())
        with self.assertRaises(FileExistsError):
            recovery.restore(result['path'], destination)

    def malicious(self, name, info=None, manifest=None):
        file = self.root/'malicious.zip'
        with zipfile.ZipFile(file, 'w') as z:
            z.writestr(info or name, 'test')
            z.writestr('manifest.json', json.dumps(manifest or {'version':1,'files':{name:{'bytes':4,'sha256':'wrong'}}}))
        with self.assertRaises(ValueError):
            recovery.restore(file, self.root/'restored')
        self.assertFalse((self.root/'restored').exists())

    def test_traversal_absolute_and_unknown_paths_are_rejected_before_extraction(self):
        for name in ['../escape', '/tmp/escape', 'vault/../escape', 'vault//escape', 'vault\\escape', 'other/file']:
            with self.subTest(name=name):
                self.malicious(name)

    def test_links_and_hash_mismatches_are_rejected(self):
        info = zipfile.ZipInfo('vault/link')
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        self.malicious('vault/link', info)
        self.malicious('vault/changed')

    def test_nested_backup_is_rejected(self):
        with self.assertRaises(ValueError):
            recovery.create(**{n:self.root/n for n in ['source','vault','data','profile']}, destination=self.root/'vault/backups')


if __name__ == '__main__':
    unittest.main()
