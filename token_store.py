"""Beeper credential storage in this Mac's encrypted login Keychain.

Native Security APIs keep the password out of shell arguments and files.
"""
import ctypes
import sys

SERVICE = b'jp.line-per-sales.beeper'
ACCOUNT = b'personal-line'
NOT_FOUND = -25300


class KeychainError(RuntimeError):
    pass


def _apis():
    if sys.platform != 'darwin':
        raise KeychainError('トークンの保存はmacOSのキーチェーンに対応しています。')
    security = ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
    core = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    pointer = ctypes.c_void_p
    uint = ctypes.c_uint32
    security.SecKeychainFindGenericPassword.argtypes = [pointer, uint, ctypes.c_char_p, uint, ctypes.c_char_p, ctypes.POINTER(uint), ctypes.POINTER(pointer), ctypes.POINTER(pointer)]
    security.SecKeychainFindGenericPassword.restype = ctypes.c_int32
    security.SecKeychainAddGenericPassword.argtypes = [pointer, uint, ctypes.c_char_p, uint, ctypes.c_char_p, uint, pointer, ctypes.POINTER(pointer)]
    security.SecKeychainAddGenericPassword.restype = ctypes.c_int32
    security.SecKeychainItemModifyAttributesAndData.argtypes = [pointer, pointer, uint, pointer]
    security.SecKeychainItemModifyAttributesAndData.restype = ctypes.c_int32
    security.SecKeychainItemFreeContent.argtypes = [pointer, pointer]
    security.SecKeychainItemFreeContent.restype = ctypes.c_int32
    security.SecKeychainItemDelete.argtypes = [pointer]
    security.SecKeychainItemDelete.restype = ctypes.c_int32
    core.CFRelease.argtypes = [pointer]
    core.CFRelease.restype = None
    return security, core


def _check(status):
    if status:
        raise KeychainError(f'キーチェーンを利用できません（OSStatus {status}）。Macのキーチェーンのロックとアクセス許可を確認してください。')


def load_token(service=SERVICE):
    security, _ = _apis()
    size = ctypes.c_uint32()
    data = ctypes.c_void_p()
    status = security.SecKeychainFindGenericPassword(None, len(service), service, len(ACCOUNT), ACCOUNT, ctypes.byref(size), ctypes.byref(data), None)
    if status == NOT_FOUND:
        return None
    _check(status)
    try:
        return ctypes.string_at(data, size.value).decode('utf-8')
    finally:
        security.SecKeychainItemFreeContent(None, data)


def save_token(token, service=SERVICE):
    security, core = _apis()
    value = token.encode('utf-8')
    if not value:
        raise KeychainError('空のトークンは保存できません。')
    item = ctypes.c_void_p()
    status = security.SecKeychainFindGenericPassword(None, len(service), service, len(ACCOUNT), ACCOUNT, None, None, ctypes.byref(item))
    if status == NOT_FOUND:
        _check(security.SecKeychainAddGenericPassword(None, len(service), service, len(ACCOUNT), ACCOUNT, len(value), ctypes.c_char_p(value), None))
        return
    _check(status)
    try:
        _check(security.SecKeychainItemModifyAttributesAndData(item, None, len(value), ctypes.c_char_p(value)))
    finally:
        core.CFRelease(item)


def get_token(replace=False):
    import getpass
    import os
    if not replace and os.getenv('BEEPER_ACCESS_TOKEN', '').strip():
        return os.environ['BEEPER_ACCESS_TOKEN'].strip()
    if not replace:
        saved = load_token()
        if saved:
            print('MacのキーチェーンからBeeperトークンを読み込みました。')
            return saved
    token = getpass.getpass('Beeperアクセストークン（Macのキーチェーンに保存）: ').strip()
    if not token:
        raise KeychainError('トークンが入力されていません。')
    save_token(token)
    print('BeeperトークンをMacのキーチェーンに保存しました。次回から自動接続します。')
    return token


def delete_token(service=SERVICE):
    security, core = _apis()
    item = ctypes.c_void_p()
    status = security.SecKeychainFindGenericPassword(None, len(service), service, len(ACCOUNT), ACCOUNT, None, None, ctypes.byref(item))
    if status == NOT_FOUND:
        return
    _check(status)
    try:
        _check(security.SecKeychainItemDelete(item))
    finally:
        core.CFRelease(item)
