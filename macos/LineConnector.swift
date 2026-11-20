import Cocoa
import Security

struct CredentialStore {
    let service: String
    let account = "personal-line"
    var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
    func load() throws -> String? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let token = String(data: data, encoding: .utf8) else { throw StoreError(status: status) }
        return token
    }
    func save(_ token: String) throws {
        let attributes = [kSecValueData as String: Data(token.utf8)]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var q = query
            q[kSecValueData as String] = Data(token.utf8)
            let added = SecItemAdd(q as CFDictionary, nil)
            guard added == errSecSuccess else { throw StoreError(status: added) }
        } else if status != errSecSuccess { throw StoreError(status: status) }
    }
    func delete() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw StoreError(status: status) }
    }
}
struct StoreError: LocalizedError {
    let status: OSStatus
    var errorDescription: String? { "Macのキーチェーンを利用できません（\(status)）。ロックとアクセス許可を確認してください。" }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let tokenField = NSSecureTextField()
    let statusLabel = NSTextField(wrappingLabelWithString: "初回だけBeeperトークンを入力してください。")
    let startButton = NSButton(title: "保存して接続アプリを起動", target: nil, action: nil)
    let stopButton = NSButton(title: "接続を停止", target: nil, action: nil)
    let openButton = NSButton(title: "LINEの接続画面を開く", target: nil, action: nil)
    let forgetButton = NSButton(title: "保存したトークンを削除", target: nil, action: nil)
    let store = CredentialStore(service: "jp.line-per-sales.beeper")
    var server: Process?
    var starting = false
    var monitor: Timer?
    var quitting = false
    let baseURL = URL(string: "http://127.0.0.1:8767/")!
    let qaMode = CommandLine.arguments.contains("--ui-test")

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        menu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "つながる営業を終了", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let editItem = NSMenuItem()
        menu.addItem(editItem)
        let editMenu = NSMenu(title: "編集")
        editMenu.addItem(withTitle: "カット", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "コピー", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "ペースト", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "すべてを選択", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        NSApp.mainMenu = menu

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 570, height: 485), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "つながる営業 — Mac接続（送信対応）"
        window.center()
        let title = NSTextField(labelWithString: "LINEを、このMacにつなぐ")
        title.font = .systemFont(ofSize: 24, weight: .semibold)
        let description = NSTextField(wrappingLabelWithString: "Beeperを起動してから接続してください。\nターミナルは不要です。このアプリを開いたまま使います。")
        description.font = .systemFont(ofSize: 14)
        let label = NSTextField(labelWithString: "Beeperアクセストークン（初回・変更時のみ）")
        tokenField.placeholderString = "ここにトークンを貼り付け"
        tokenField.font = .systemFont(ofSize: 15)
        tokenField.translatesAutoresizingMaskIntoConstraints = false
        tokenField.heightAnchor.constraint(equalToConstant: 32).isActive = true
        let privacy = NSTextField(wrappingLabelWithString: "トークンはMacのキーチェーンに保存します。GitHubや公開サイトには送信しません。保存済みなら、入力欄を空のまま起動できます。")
        privacy.font = .systemFont(ofSize: 12)
        privacy.textColor = .secondaryLabelColor
        startButton.target = self; startButton.action = #selector(startClicked)
        startButton.bezelStyle = .rounded
        startButton.keyEquivalent = "\r"
        stopButton.target = self; stopButton.action = #selector(stopClicked)
        stopButton.bezelStyle = .rounded
        openButton.target = self; openButton.action = #selector(openLocal)
        openButton.bezelStyle = .rounded
        let publicButton = NSButton(title: "公開サイトを開く", target: self, action: #selector(openPublic))
        publicButton.bezelStyle = .rounded
        forgetButton.target = self; forgetButton.action = #selector(forgetToken)
        forgetButton.bezelStyle = .rounded
        statusLabel.font = .systemFont(ofSize: 14)
        statusLabel.setAccessibilityIdentifier("connectionStatus")
        statusLabel.textColor = .secondaryLabelColor
        let firstRow = NSStackView(views: [startButton, stopButton])
        firstRow.orientation = .horizontal; firstRow.spacing = 12
        let secondRow = NSStackView(views: [openButton, publicButton])
        secondRow.orientation = .horizontal; secondRow.spacing = 12
        let stack = NSStackView(views: [title, description, label, tokenField, privacy, firstRow, statusLabel, secondRow, forgetButton])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 17
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 28),
            stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -28),
            stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 28),
            tokenField.widthAnchor.constraint(equalTo: stack.widthAnchor)
        ])
        updateControls()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if !qaMode {
            loadCredential()
        } else { statusLabel.stringValue = "画面確認モード：トークンの読み込み・保存やLINEへの接続は行いません。" }
    }

    func updateControls() {
        let running = server?.isRunning ?? false
        forgetButton.isEnabled = !starting
        startButton.isEnabled = !starting && !running
        stopButton.isEnabled = running
        tokenField.isEnabled = !running && !starting
        openButton.isEnabled = running && !starting
    }
    func showError(_ message: String) {
        statusLabel.stringValue = message
        statusLabel.textColor = .systemRed
    }
    @objc func startClicked() {
        if qaMode || starting { return }
        let typed = tokenField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        tokenField.stringValue = ""
        loadCredential(typed: typed.isEmpty ? nil : typed)
    }
    func loadCredential(typed: String? = nil) {
        starting = true; updateControls()
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.stringValue = "Macのキーチェーンを確認しています。macOSの確認画面が表示された場合は内容を確認してください。"
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            do {
                let token: String?
                if let typed = typed { try self.store.save(typed); token = typed }
                else { token = try self.store.load() }
                DispatchQueue.main.async {
                    guard !self.quitting else { return }
                    self.starting = false
                    if let token = token, !token.isEmpty { self.startServer(token: token) }
                    else {
                        self.statusLabel.stringValue = "初回だけBeeperトークンを入力してください。"
                        self.updateControls()
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    guard !self.quitting else { return }
                    self.starting = false
                    self.showError(error.localizedDescription)
                    self.updateControls()
                }
            }
        }
    }
    func pythonExecutable() -> String? {
        for path in ["/opt/homebrew/bin/python3.13", "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"] {
            guard FileManager.default.isExecutableFile(atPath: path) else { continue }
            let probe = Process()
            probe.executableURL = URL(fileURLWithPath: path)
            probe.arguments = ["-c", "import sys;sys.exit(sys.version_info < (3,10))"]
            probe.standardOutput = FileHandle.nullDevice; probe.standardError = FileHandle.nullDevice
            do { try probe.run(); probe.waitUntilExit(); if probe.terminationStatus == 0 { return path } } catch { continue }
        }
        return nil
    }
    func startServer(token: String) {
        guard server == nil else { return }
        guard let python = pythonExecutable(), let resources = Bundle.main.resourceURL else {
            showError("Python 3.10以降が必要です。python.orgのMac用インストーラーでインストールしてください。")
            return
        }
        starting = true; updateControls()
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.stringValue = "Mac内の接続アプリを起動しています…"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: python)
        let connector = resources.appendingPathComponent("connector")
        process.currentDirectoryURL = connector
        process.arguments = [connector.appendingPathComponent("app.py").path, "--personal", "--port", "8767", "--no-browser", "--token-stdin"]
        var env = ProcessInfo.processInfo.environment
        env.removeValue(forKey: "BEEPER_ACCESS_TOKEN")
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        process.environment = env
        let input = Pipe()
        process.standardInput = input
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] child in
            DispatchQueue.main.async {
                guard let self = self, self.server === child else { return }
                self.monitor?.invalidate(); self.monitor = nil
                self.server = nil; self.starting = false
                if !self.quitting {
                    self.showError("接続アプリが終了しました。別の接続アプリが起動中の場合は終了してください。Beeperトークンを変更するときは新しいトークンを入力して起動してください。")
                    self.updateControls()
                }
            }
        }
        do {
            try process.run()
            server = process
            try input.fileHandleForWriting.write(contentsOf: Data((token + "\n").utf8))
            try input.fileHandleForWriting.close()
            var received = Data()
            output.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                if data.isEmpty { handle.readabilityHandler = nil; return }
                DispatchQueue.main.async {
                    guard let self = self, self.server === process, self.starting else { return }
                    received.append(data)
                    if String(data: received, encoding: .utf8)?.contains("LINE_CONNECTOR_READY") == true {
                        self.monitor?.invalidate(); self.monitor = nil
                        self.starting = false
                        self.statusLabel.textColor = .systemGreen
                        self.statusLabel.stringValue = "接続アプリは起動中です。LINEの接続画面で一覧を取得できます。終了すると接続も止まります。"
                        self.updateControls()
                        self.openLocal()
                    }
                    if received.count > 16384 { received.removeAll() }
                }
            }
            monitor = Timer.scheduledTimer(withTimeInterval: 20, repeats: false) { [weak self] _ in
                guard let self = self, self.server === process, self.starting else { return }
                self.stopClicked()
                self.showError("接続アプリの起動が完了しませんでした。もう一度起動してください。")
            }
        } catch {
            input.fileHandleForWriting.closeFile()
            if process.isRunning { process.terminate() }
            server = nil; starting = false
            showError("接続アプリを起動できませんでした。Pythonのインストールとアプリの配置を確認してください。")
            updateControls()
        }
    }
    @objc func stopClicked() {
        monitor?.invalidate(); monitor = nil
        let child = server
        server = nil; starting = false
        child?.terminate()
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.stringValue = "接続を停止しました。保存したトークンは次回も使えます。"
        updateControls()
    }
    @objc func openLocal() { NSWorkspace.shared.open(baseURL) }
    @objc func openPublic() { NSWorkspace.shared.open(URL(string: "https://line-per-line.netlify.app/")!) }
    @objc func forgetToken() {
        if qaMode { return }
        let alert = NSAlert()
        alert.messageText = "保存したBeeperトークンを削除しますか？"
        alert.informativeText = "接続を停止し、このMacのキーチェーンから削除します。次回はトークンの入力が必要です。"
        alert.addButton(withTitle: "削除"); alert.addButton(withTitle: "キャンセル")
        if alert.runModal() == .alertFirstButtonReturn {
            stopClicked()
            starting = true; updateControls()
            statusLabel.stringValue = "キーチェーンの削除を確認しています…"
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                guard let self = self else { return }
                do {
                    try self.store.delete()
                    DispatchQueue.main.async {
                        guard !self.quitting else { return }
                        self.starting = false; self.tokenField.stringValue = ""
                        self.statusLabel.stringValue = "保存したトークンを削除しました。"; self.updateControls()
                    }
                } catch {
                    DispatchQueue.main.async {
                        guard !self.quitting else { return }
                        self.starting = false; self.showError(error.localizedDescription); self.updateControls()
                    }
                }
            }
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil); return true
    }
    func applicationWillTerminate(_ notification: Notification) {
        quitting = true
        monitor?.invalidate()
        server?.terminate()
    }
}

if CommandLine.arguments.contains("--self-test-keychain") {
    let store = CredentialStore(service: "jp.line-per-sales.test." + UUID().uuidString)
    do {
        let empty = try store.load(); precondition(empty == nil)
        try store.save("fictional-test-one")
        let first = try store.load(); precondition(first == "fictional-test-one")
        try store.save("fictional-test-two")
        let second = try store.load(); precondition(second == "fictional-test-two")
        try store.delete()
        let deleted = try store.load(); precondition(deleted == nil)
        print("Keychain create/read/update/delete: OK")
    } catch { try? store.delete(); fputs("Keychain self-test failed\n", stderr); exit(1) }
} else {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run()
}
