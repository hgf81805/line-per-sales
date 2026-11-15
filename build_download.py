"""Rebuild the public Mac download after updating local connector sources."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent
target = root / 'public/downloads/personal-line.zip'
target.parent.mkdir(exist_ok=True)
files = ['app.py', 'personal.py', 'beeper_reader.py', 'README.md',
         '個人LINE起動.command', 'デモ起動.command', 'test_personal.py',
         'public/index.html', 'public/demo.html']
with ZipFile(target, 'w', ZIP_DEFLATED) as archive:
    for name in files:
        archive.write(root / name, arcname='personal-line/' + name)
with ZipFile(target) as archive:
    assert archive.testzip() is None
    assert (archive.getinfo('personal-line/個人LINE起動.command').external_attr >> 16) & 0o111
print(target)
