"""Offline project/CLI regression tests. No network, native credentials or dependencies."""
import ast
from contextlib import redirect_stdout, redirect_stderr
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
from types import ModuleType
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / 'console/public/skills/tidb-agent-workspace'

# These tests stop before cryptography/OS storage. Real signing/store integration
# remains in agent_trial_client.py; no optional Python packages are needed here.
modules = {}
for name in ('cryptography', 'cryptography.hazmat', 'cryptography.hazmat.primitives',
             'cryptography.hazmat.primitives.asymmetric',
             'cryptography.hazmat.primitives.asymmetric.ed25519', 'keyring', 'keyring.errors'):
    modules[name] = ModuleType(name)
modules['cryptography.hazmat.primitives.asymmetric.ed25519'].Ed25519PrivateKey = Mock()
modules['keyring.errors'].KeyringError = type('KeyringError', (Exception,), {})
modules['keyring.errors'].PasswordDeleteError = type('PasswordDeleteError', (Exception,), {})
with patch.dict(sys.modules, modules):
    helper = runpy.run_path(str(ASSETS / 'report.py'))
    private = runpy.run_path(str(ASSETS / 'private_csv.py'))


class ReportUX(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='tidb-report-ux-')
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name).resolve() / 'home'
        self.downloads = self.home / 'Downloads'
        self.downloads.mkdir(parents=True)
        (self.home / '.git').mkdir()
        self.profile = self.home / 'state'
        home_patch = patch.object(Path, 'home', return_value=self.home)
        home_patch.start()
        self.addCleanup(home_patch.stop)

    def binding(self, project, public=True):
        identity = helper['PRODUCTION'] + ('\0' + os.path.normcase(str(project)) if public else '\n' + str(project))
        return self.profile / hashlib.sha256(identity.encode()).hexdigest() / 'binding.json'

    def save(self, project, public=True):
        path = self.binding(project, public)
        path.parent.mkdir(parents=True)
        state = {'status': 'forgotten', 'projectFile': str(project / 'reports/old.md')}
        path.write_text(json.dumps(state))
        return path

    def test_home_repository_does_not_capture_downloads(self):
        self.assertEqual(helper['project_dir'](self.downloads), self.downloads)
        repo = self.downloads / 'project'
        nested = repo / 'src'
        nested.mkdir(parents=True)
        (repo / '.git').write_text('gitdir: a-worktree')
        self.assertEqual(helper['project_dir'](nested), repo)
        self.assertEqual(helper['project_dir'](nested, exact=True), nested)
        # Git at the filesystem root must also be ignored.
        root = Path(self.home.anchor)
        original = Path.exists
        with patch.object(Path, 'exists', lambda p: True if p == root / '.git' else original(p)):
            self.assertEqual(helper['project_dir'](self.downloads), self.downloads)

    def test_old_home_binding_requires_choice_before_any_side_effect(self):
        for public in (True, False):
            with self.subTest(public=public):
                path = self.save(self.home, public)
                before = path.read_bytes()
                store = Mock(side_effect=AssertionError('must not access the credential store'))
                operation = helper['trial'] if public else private['private_csv']
                with self.assertRaisesRegex(ValueError, 'Choose: continue there'):
                    operation(helper['PRODUCTION'], self.downloads, self.profile,
                              'start' if public else 'resume', store_factory=store)
                self.assertFalse(self.binding(self.downloads, public).exists())
                self.assertEqual(path.read_bytes(), before)
                store.assert_not_called()
        result = helper['trial'](helper['PRODUCTION'], self.home, self.profile, 'start',
                                 store_factory=store, project_exact=True)
        self.assertEqual(result['report'], str(self.home / 'reports/old.md'))
        store.assert_not_called()

    def test_new_projects_cannot_use_home_or_root(self):
        store = Mock(side_effect=AssertionError('no credential changes'))
        for folder in (self.home, Path(self.home.anchor)):
            with self.assertRaisesRegex(ValueError, 'project folder'):
                helper['trial'](helper['PRODUCTION'], folder, self.profile, 'start', store_factory=store)
        self.assertFalse(self.profile.exists())
        store.assert_not_called()

    def test_explicit_separate_report_preserves_old_binding(self):
        path = self.save(self.home)
        before = path.read_bytes()
        binding_for = lambda p: self.binding(p).parent.name
        project = helper['resolve_project'](self.downloads, self.profile, binding_for, 'new', exact=True)
        self.assertEqual(project, self.downloads)
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse(self.binding(self.downloads).exists())

    def test_explicit_nested_binding_survives_another_agent(self):
        repo = self.downloads / 'repo'
        project = repo / 'selected'
        nested = project / 'src'
        nested.mkdir(parents=True)
        (repo / '.git').mkdir()
        path = self.save(project)
        store = Mock(side_effect=AssertionError('must reuse retained binding'))
        for directory in (project, nested):
            announced = []
            result = helper['trial'](helper['PRODUCTION'], directory, self.profile, 'start',
                                     store_factory=store, announce=announced.append)
            self.assertEqual(result['report'], str(project / 'reports/old.md'))
            self.assertEqual(announced, [project])
        self.assertTrue(path.exists())
        self.assertFalse(self.binding(repo).exists())
        store.assert_not_called()

    def test_non_git_project_binding_is_reused_from_a_subfolder(self):
        self.save(self.downloads)
        nested = self.downloads / 'work'
        nested.mkdir()
        store = Mock(side_effect=AssertionError('must reuse the existing report'))
        result = helper['trial'](helper['PRODUCTION'], nested, self.profile, 'start', store_factory=store)
        self.assertEqual(result['report'], str(self.downloads / 'reports/old.md'))
        self.assertFalse(self.binding(nested).exists())
        store.assert_not_called()

    def test_explicit_selection_cannot_silently_replace_old_repository_binding(self):
        repo = self.downloads / 'repo'
        nested = repo / 'src'
        nested.mkdir(parents=True)
        (repo / '.git').mkdir()
        self.save(repo)
        with self.assertRaisesRegex(ValueError, 'Choose: continue there'):
            helper['trial'](helper['PRODUCTION'], nested, self.profile, 'start', project_exact=True)
        self.assertFalse(self.binding(nested).exists())

    def cli(self, arguments, result=None, error=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(sys, 'argv', ['report.py', *arguments]), redirect_stdout(stdout), redirect_stderr(stderr), patch.dict(helper['main'].__globals__, trial=Mock(return_value=result, side_effect=error)):
            status = helper['main']()
        return status, stdout.getvalue(), stderr.getvalue()

    def test_default_output_and_json_mode(self):
        result = {'status': 'synced', 'finding': 'California leads with $48,000.',
                  'studioUrl': 'https://example.invalid/report/#fixture', 'report': '/project/report.md',
                  'expiresAt': '2030-01-02T00:00:00+00:00', 'markdown': '# Canonical report'}
        status, output, _ = self.cli(['start'], result)
        self.assertEqual(status, 0)
        for value in ('California', 'View report in Studio', '/project/report.md', 'Anyone with this link', 'unshare', 'Next:', result['expiresAt']):
            self.assertIn(value, output)
        self.assertNotIn('# Canonical report', output)
        self.assertEqual(json.loads(self.cli(['start', '--json'], result)[1]), result)
        revoked = dict(result)
        del revoked['studioUrl']
        output = self.cli(['start'], revoked)[1]
        self.assertIn('Sharing is closed', output)
        self.assertNotIn('https://', output)

    def test_machine_recovery_choices(self):
        status, output, _ = self.cli(['start', '--json'], error=helper['ProjectChoice'](self.home, self.downloads))
        result = json.loads(output)
        self.assertEqual(status, 2)
        self.assertEqual(result['status'], 'needs-project-choice')
        self.assertEqual([(v['action'], v['project']) for v in result['options']],
                         [('start', str(self.home)), ('new', str(self.downloads))])

    def test_numeric_verification_does_not_construct_another_report(self):
        sample = (ROOT / 'specs/gh-150/fixtures/us-sales.csv').read_bytes()
        result = helper['verify_sample'](sample, False)
        self.assertIn('$48,000', result)
        self.assertNotIn('|', result)
        with self.assertRaisesRegex(ValueError, 'integrity'):
            helper['verify_sample'](sample + b'\n', False)
        with self.assertRaisesRegex(ValueError, 'totals differ'):
            helper['verify_sample'](sample, False, {'sample': 'us-sales-v1', 'stateSales': {}})

    def test_first_report_and_another_agent_update_same_files(self):
        sample = (ROOT / 'specs/gh-150/fixtures/us-sales.csv').read_bytes()
        canonical = {'id': '11111111-1111-4111-8111-111111111111', 'revision': 0,
                     'expiresAt': 2100000000, 'sample': 'us-sales-v1',
                     'stateSales': {'California': 48000, 'Texas': 20000, 'New York': 12000,
                                    'Washington': 8000, 'Florida': 7000, 'Massachusetts': 5000}}
        import csv
        from collections import Counter
        products = Counter()
        for row in csv.DictReader(io.StringIO(sample.decode())):
            if row['state'] == 'California':
                products[row['product']] += int(row['sales_usd'])
        canonical['leadingStateProducts'] = dict(products)
        enrollments = []

        def api(base, route, **kwargs):
            if route.endswith('.csv'):
                return sample
            if route == 'challenges':
                return {'challenge': 'fixture'}
            if route == 'sessions':
                enrollments.append(kwargs['payload']['enroll'])
                return {'report': canonical, 'token': 'fixture'}
            if route == 'report':
                if kwargs.get('method') == 'PUT':
                    canonical['revision'] += 1
                    canonical['markdown'] = '# Server report revision ' + str(canonical['revision'])
                return dict(canonical)
            raise AssertionError(route)

        key = Mock()
        key.private_bytes_raw.return_value = b'k' * 32
        key.public_key.return_value.public_bytes_raw.return_value = b'p' * 32
        key.sign.return_value = b's' * 64
        ed = Mock()
        ed.generate.return_value = ed.from_private_bytes.return_value = key
        secrets = {}
        store = Mock()
        store.get_password.side_effect = lambda service, user: secrets.get(service)
        store.set_password.side_effect = lambda service, user, value: secrets.update({service: value})
        with patch.dict(helper['trial'].__globals__, api=api, Ed25519PrivateKey=ed), patch.dict(helper['sync_report'].__globals__, api=api):
            first = helper['trial'](helper['PRODUCTION'], self.downloads, self.profile, 'start', store_factory=lambda: store)
            second = helper['trial'](helper['PRODUCTION'], self.downloads, self.profile, 'products', store_factory=lambda: store)
        self.assertEqual(enrollments, [True, False])
        self.assertEqual(store.set_password.call_count, 1)
        self.assertEqual(first['reportId'], second['reportId'])
        self.assertEqual(first['studioUrl'], second['studioUrl'])
        self.assertEqual(first['report'], second['report'])
        self.assertEqual(Path(second['report']).parent, self.downloads / 'reports/tidb-agent-workspace')
        self.assertEqual(Path(second['report']).read_text(), canonical['markdown'])
        self.assertEqual(Path(second['source']).read_bytes(), sample)
        self.assertFalse((self.home / 'reports').exists())

    def test_python_39_syntax(self):
        for filename in ('report.py', 'private_csv.py', 'install.py'):
            ast.parse((ASSETS / filename).read_text(), feature_version=(3, 9))


if __name__ == '__main__':
    unittest.main()
