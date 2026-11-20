"""Rebuild the public Mac download after updating local connector sources."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent
target = root / 'public/downloads/personal-line.zip'
target.parent.mkdir(exist_ok=True)
files = ['app.py', 'attio_bridge.py', 'confirmed_send.py', 'cloud_relay.py', 'token_store.py', 'test_token_store.py', 'personal.py', 'beeper_reader.py', 'README.md',
         '個人LINE起動.command', 'デモ起動.command', 'test_personal.py',
         'public/favicon.ico', 'public/favicon.svg', 'public/favicon-32.png', 'public/apple-touch-icon.png', 'public/index.html', 'public/cloud.js', 'public/send.js', 'public/attio.js', 'public/pipeline.html', 'public/pipeline.js', 'public/directory.js', 'public/cloud-config.json', 'public/demo.html']
with ZipFile(target, 'w', ZIP_DEFLATED) as archive:
    for name in files:
        archive.write(root / name, arcname='personal-line/' + name)
with ZipFile(target) as archive:
    assert archive.testzip() is None
    assert (archive.getinfo('personal-line/個人LINE起動.command').external_attr >> 16) & 0o111
print(target)
