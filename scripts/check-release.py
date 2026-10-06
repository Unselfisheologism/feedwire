"""Fail before upload if the release tag, package versions or assets differ."""
import json
import os
from pathlib import Path
import re
try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib

root = Path(__file__).resolve().parents[1]
node = json.loads((root / 'node/package.json').read_text())
python = tomllib.loads((root / 'python/pyproject.toml').read_text())['project']
assert node['name'] == python['name'] == 'feedwire', 'Both packages must be named feedwire'
assert node['version'] == python['version'], 'Package versions differ'
tag = os.environ.get('RELEASE_TAG', 'v' + node['version'])
assert re.fullmatch(r'v\d+\.\d+\.\d+', tag), 'Use a stable vMAJOR.MINOR.PATCH tag'
assert tag == 'v' + node['version'], 'Release tag must match both package versions'
for package in ('node', 'python'):
    assert (root / package / 'LICENSE').read_bytes() == (root / 'LICENSE').read_bytes()
    assert (root / package / 'README.md').is_file()
print(f'Release {tag}: versions, names, READMEs and licenses OK')
