"""Build a native, terminal-free app bundle. Never includes credentials."""
import argparse
import os
from pathlib import Path
import plistlib
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent

def build(destination):
    app = destination / 'つながる営業.app'
    macos = app / 'Contents/MacOS'
    resources = app / 'Contents/Resources'
    macos.mkdir(parents=True, exist_ok=True)
    connector = resources / 'connector'
    connector.mkdir(parents=True, exist_ok=True)
    for name in ('app.py', 'attio_bridge.py', 'confirmed_send.py', 'sales_assist.py', 'personal.py', 'beeper_reader.py', 'token_store.py', 'cloud_relay.py'):
        shutil.copyfile(ROOT / name, connector / name)
    (connector / 'public').mkdir(exist_ok=True)
    for name in ('index.html', 'settings.html', 'settings.js', 'cloud.js', 'send.js', 'attio.js', 'pipeline.html', 'pipeline.js', 'directory.js', 'marked.umd.js', 'marked-LICENSE.md', 'note-editor.js', 'sales-assist.js', 'ui.css', 'cloud-config.json', 'favicon.ico', 'favicon.svg', 'favicon-32.png', 'apple-touch-icon.png'):
        shutil.copyfile(ROOT / 'public' / name, connector / 'public' / name)
    cache = ROOT / '.build/module-cache'
    cache.mkdir(parents=True, exist_ok=True)
    executable = macos / 'LineConnector'
    subprocess.run(['/usr/bin/swiftc', str(ROOT / 'macos/LineConnector.swift'),
                    '-module-cache-path', str(cache), '-framework', 'Cocoa', '-framework', 'Security',
                    '-o', str(executable)], check=True)
    with (app / 'Contents/Info.plist').open('wb') as f:
        plistlib.dump({'CFBundleExecutable': 'LineConnector',
                      'CFBundleIdentifier': 'jp.line-per-sales.connector',
                      'CFBundleName': 'つながる営業',
                      'CFBundleDisplayName': 'つながる営業',
                      'CFBundlePackageType': 'APPL', 'CFBundleShortVersionString': '2.0.1',
                      'CFBundleVersion': '16', 'LSMinimumSystemVersion': '13.0',
                      'NSHighResolutionCapable': True,
                      'NSLocalNetworkUsageDescription': 'このMac内のBeeperと接続して、選択したLINEトークを読み取ります。'}, f)
    subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', '--identifier',
                    'jp.line-per-sales.connector', str(app)], check=True)
    # Exclude bytecode, user preferences, .env and runtime state by explicit allowlist above.
    return app

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=ROOT / '.build/macos')
    parser.add_argument('--archive', type=Path)
    args = parser.parse_args()
    app = build(args.output.resolve())
    if args.archive:
        args.archive.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['/usr/bin/ditto', '-c', '-k', '--sequesterRsrc', '--keepParent',
                        str(app), str(args.archive.resolve())], check=True)
    print(app)
