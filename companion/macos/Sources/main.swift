import ApplicationServices
import AppKit
import AVFoundation
import CoreGraphics
import Foundation
import Network

private let companionPort = NWEndpoint.Port(rawValue: 50900)!
private let companionQueue = DispatchQueue(label: "com.premierebind.companion")
private let companionProtocolVersion = 7

private final class PremiereBindCompanion {
    private let stateLock = NSLock()
    private var shortcutMap: [String: String] = [:]
    private var heldAlignmentKeys = Set<String>()
    private var suppressedKeys = Set<String>()
    private var panelConnection: NWConnection?
    private var listener: NWListener?
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var idleExitTimer: Timer?
    private var accessibilityPollTimer: Timer?
    private var accessibilityPermissionGranted = false
    private var pendingExternalImports: [String] = []

    func start() throws {
        try startWebSocketServer()
        accessibilityPermissionGranted = requestAccessibilityPermission()
        if accessibilityPermissionGranted {
            installGlobalKeyboardMonitor()
        }
        startAccessibilityMonitoring()
    }

    private func startWebSocketServer() throws {
        let webSocketOptions = NWProtocolWebSocket.Options()
        webSocketOptions.autoReplyPing = true
        // Portable libraries include the complete saved-selection JSON in a
        // single request. Nested libraries can easily exceed the old 16 KB
        // shortcut-only limit.
        webSocketOptions.maximumMessageSize = 64 * 1024 * 1024
        webSocketOptions.setClientRequestHandler(companionQueue) { _, _ in
            NWProtocolWebSocket.Response(status: .accept, subprotocol: nil, additionalHeaders: nil)
        }

        let parameters = NWParameters(tls: nil, tcp: NWProtocolTCP.Options())
        parameters.defaultProtocolStack.applicationProtocols.insert(webSocketOptions, at: 0)
        // The panel always connects to 127.0.0.1. Binding here prevents the
        // helper from accepting a connection from another machine.
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: companionPort)
        parameters.requiredInterfaceType = .loopback

        let listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { [weak self] connection in
            self?.acceptPanelConnection(connection)
        }
        listener.stateUpdateHandler = { state in
            if case .failed(let error) = state {
                NSLog("[PremiereBind Companion] Local WebSocket listener failed: %@", String(describing: error))
            }
        }
        self.listener = listener
        listener.start(queue: companionQueue)
    }

    private func acceptPanelConnection(_ connection: NWConnection) {
        companionQueue.async { [weak self] in
            guard let self else { return }

            if let previous = self.panelConnection, previous !== connection {
                previous.cancel()
            }
            self.panelConnection = connection
            self.cancelIdleExit()

            connection.stateUpdateHandler = { [weak self, weak connection] state in
                guard let self, let connection else { return }
                if case .failed = state {
                    self.panelDidDisconnect(connection)
                } else if case .cancelled = state {
                    self.panelDidDisconnect(connection)
                }
            }
            connection.start(queue: companionQueue)
            self.send([
                "type": "companionStatus",
                "status": "connected",
                "protocolVersion": companionProtocolVersion
            ], on: connection)
            if !self.accessibilityPermissionGranted {
                self.send(["type": "companionStatus", "status": "accessibility-permission-required"], on: connection)
            }
            self.flushPendingExternalImports(on: connection)
            self.receiveNextMessage(on: connection)
        }
    }

    private func panelDidDisconnect(_ connection: NWConnection) {
        companionQueue.async { [weak self] in
            guard let self, self.panelConnection === connection else { return }
            self.panelConnection = nil
            self.scheduleIdleExit()
        }
    }

    private func receiveNextMessage(on connection: NWConnection) {
        connection.receiveMessage { [weak self, weak connection] content, _, _, error in
            guard let self, let connection else { return }
            if let content, !content.isEmpty {
                self.handlePanelMessage(content, from: connection)
            }
            if error == nil {
                self.receiveNextMessage(on: connection)
            } else {
                self.panelDidDisconnect(connection)
            }
        }
    }

    private func handlePanelMessage(_ data: Data, from connection: NWConnection) {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else { return }

        switch type {
        case "syncShortcuts":
            guard let presets = object["presets"] as? [[String: Any]] else { return }
            var newMap: [String: String] = [:]
            for preset in presets {
                guard let id = preset["id"] as? String,
                      let shortcut = preset["shortcut"] as? String,
                      let combo = normalizeCombo(shortcut),
                      !id.isEmpty else { continue }
                if newMap[combo] == nil { newMap[combo] = id }
            }
            stateLock.lock()
            shortcutMap = newMap
            stateLock.unlock()

        case "copyProjectSnapshot":
            copyProjectSnapshot(object, to: connection)

        case "readProjectTransitionMetadata":
            readProjectTransitionMetadata(object, to: connection)

        case "exportLibraryZip":
            exportLibraryZip(object, to: connection)

        case "importLibraryZip":
            importLibraryZip(object, to: connection)

        case "analyzeAudioBeats":
            analyzeAudioBeats(object, to: connection)

        case "premiereClipboardShortcut":
            sendPremiereClipboardShortcut(object, to: connection)

        case "openAccessibilitySettings":
            openAccessibilitySettings(object, to: connection)

        default:
            break
        }
    }

    private func sendPremiereClipboardShortcut(_ message: [String: Any], to connection: NWConnection) {
        let requestId = message["requestId"] as? String ?? ""
        let action = message["action"] as? String ?? ""
        guard AXIsProcessTrusted() else {
            send(["type": "premiereClipboardShortcutResult", "requestId": requestId, "ok": false, "error": "Allow PremiereBind Companion in System Settings → Privacy & Security → Accessibility, then try again."], on: connection)
            send(["type": "companionStatus", "status": "accessibility-permission-required"], on: connection)
            return
        }
        guard let premiere = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "com.adobe.PremierePro" }) else {
            send(["type": "premiereClipboardShortcutResult", "requestId": requestId, "ok": false, "error": "Premiere Pro is not running."], on: connection)
            return
        }
        premiere.activate(options: [.activateIgnoringOtherApps])
        let keyCode: CGKeyCode
        switch action.lowercased() {
        case "copy": keyCode = 8
        case "paste": keyCode = 9
        case "focus":
            let source = CGEventSource(stateID: .hidSystemState)
            let down = CGEvent(keyboardEventSource: source, virtualKey: 20, keyDown: true)
            let up = CGEvent(keyboardEventSource: source, virtualKey: 20, keyDown: false)
            down?.flags = .maskShift
            up?.flags = .maskShift
            down?.post(tap: .cghidEventTap)
            up?.post(tap: .cghidEventTap)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.30) { [weak self, weak connection] in
                guard let self, let connection else { return }
                self.send(["type": "premiereClipboardShortcutResult", "requestId": requestId, "ok": true, "action": action], on: connection)
            }
            return
        default:
            send(["type": "premiereClipboardShortcutResult", "requestId": requestId, "ok": false, "error": "Unsupported clipboard action."], on: connection)
            return
        }
        let source = CGEventSource(stateID: .hidSystemState)
        let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true)
        let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false)
        down?.flags = .maskCommand
        up?.flags = .maskCommand
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { [weak self, weak connection] in
            guard let self, let connection else { return }
            self.send(["type": "premiereClipboardShortcutResult", "requestId": requestId, "ok": true, "action": action, "clipboardChanged": action.lowercased() == "copy"], on: connection)
        }
    }

    private func openAccessibilitySettings(_ message: [String: Any], to connection: NWConnection) {
        let requestId = message["requestId"] as? String ?? ""
        _ = requestAccessibilityPermission()
        let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!
        DispatchQueue.main.async { [weak self, weak connection] in
            guard let self, let connection else { return }
            let opened = NSWorkspace.shared.open(url)
            self.send(["type": "openAccessibilitySettingsResult", "requestId": requestId, "ok": opened, "error": opened ? "" : "macOS could not open Accessibility settings."], on: connection)
        }
    }

    private func analyzeAudioBeats(_ message: [String: Any], to connection: NWConnection) {
        let requestId = message["requestId"] as? String ?? ""
        let mediaPath = normalizeNativePath(message["mediaPath"] as? String ?? "")
        let sensitivity = message["sensitivity"] as? String ?? "balanced"
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let beats = try self.detectAudioBeats(mediaPath: mediaPath, sensitivity: sensitivity)
                self.send(["type": "audioBeatAnalysisResult", "requestId": requestId, "ok": true, "beats": beats], on: connection)
            } catch {
                self.send(["type": "audioBeatAnalysisResult", "requestId": requestId, "ok": false, "error": error.localizedDescription], on: connection)
            }
        }
    }

    private func detectAudioBeats(mediaPath: String, sensitivity: String) throws -> [Double] {
        guard !mediaPath.isEmpty, FileManager.default.fileExists(atPath: mediaPath) else {
            throw makeError("Audio media was not found.")
        }
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: mediaPath))
        let format = file.processingFormat
        let sampleRate = format.sampleRate
        let channelCount = Int(format.channelCount)
        let hopFrames: AVAudioFrameCount = 512
        guard sampleRate > 0, channelCount > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: hopFrames) else {
            throw makeError("This audio format cannot be analyzed.")
        }

        var strengths: [Double] = []
        var onsetTimes: [Double] = []
        var previousEnergy = 0.0
        var previousDifference = 0.0
        var framePosition: Int64 = 0

        while file.framePosition < file.length {
            try file.read(into: buffer, frameCount: hopFrames)
            let frameLength = Int(buffer.frameLength)
            if frameLength == 0 { break }
            guard let channelData = buffer.floatChannelData else {
                throw makeError("PremiereBind could not read PCM samples from this audio file.")
            }
            var energy = 0.0
            var difference = 0.0
            var previousMono = 0.0
            for frame in 0..<frameLength {
                var mono = 0.0
                for channel in 0..<channelCount { mono += Double(channelData[channel][frame]) }
                mono /= Double(channelCount)
                energy += mono * mono
                if frame > 0 { difference += abs(mono - previousMono) }
                previousMono = mono
            }
            energy = sqrt(energy / Double(frameLength))
            difference /= Double(frameLength)
            let strength = max(0, energy - previousEnergy) + 0.65 * max(0, difference - previousDifference)
            strengths.append(strength)
            onsetTimes.append(Double(framePosition) / sampleRate)
            previousEnergy = 0.75 * previousEnergy + 0.25 * energy
            previousDifference = 0.75 * previousDifference + 0.25 * difference
            framePosition += Int64(frameLength)
        }

        let mode = sensitivity.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        // Keep confidence and density meaningfully separated so strong,
        // regular clicks do not produce identical results in every mode.
        let thresholdMultiplier = mode == "high" ? 1.25 : (mode == "low" ? 2.75 : 1.85)
        let minimumSpacing = mode == "high" ? 0.12 : (mode == "low" ? 1.40 : 0.65)
        var beats: [Double] = []
        guard strengths.count >= 5 else { return beats }
        for index in 2..<(strengths.count - 2) {
            let lower = max(0, index - 24)
            let history = strengths[lower..<index]
            guard history.count >= 4 else { continue }
            let mean = history.reduce(0, +) / Double(history.count)
            let variance = history.reduce(0) { $0 + pow($1 - mean, 2) } / Double(history.count)
            let threshold = mean * thresholdMultiplier + sqrt(variance) * 0.35 + 0.00001
            let isPeak = strengths[index] >= strengths[index - 1] && strengths[index] > strengths[index + 1]
            guard isPeak, strengths[index] >= threshold else { continue }
            let seconds = onsetTimes[index]
            if beats.last == nil || seconds - beats.last! >= minimumSpacing {
                beats.append((seconds * 1_000_000).rounded() / 1_000_000)
            }
        }
        return beats
    }

    private func copyProjectSnapshot(_ message: [String: Any], to connection: NWConnection) {
        let requestId = message["requestId"] as? String ?? ""
        let sourcePath = normalizeNativePath(message["sourcePath"] as? String ?? "")
        let destinationPath = normalizeNativePath(message["destinationPath"] as? String ?? "")

        do {
            guard !sourcePath.isEmpty,
                  FileManager.default.fileExists(atPath: sourcePath) else {
                throw NSError(domain: "PremiereBindCompanion", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "The saved Premiere project file was not found."
                ])
            }
            guard !destinationPath.isEmpty else {
                throw NSError(domain: "PremiereBindCompanion", code: 2, userInfo: [
                    NSLocalizedDescriptionKey: "The PremiereBind library destination is invalid."
                ])
            }

            let destinationURL = URL(fileURLWithPath: destinationPath)
            try FileManager.default.createDirectory(
                at: destinationURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            if FileManager.default.fileExists(atPath: destinationPath) {
                try FileManager.default.removeItem(at: destinationURL)
            }
            try FileManager.default.copyItem(at: URL(fileURLWithPath: sourcePath), to: destinationURL)
            send([
                "type": "projectSnapshotResult",
                "requestId": requestId,
                "ok": true,
                "destinationPath": destinationPath
            ], on: connection)
        } catch {
            send([
                "type": "projectSnapshotResult",
                "requestId": requestId,
                "ok": false,
                "error": error.localizedDescription
            ], on: connection)
        }
    }

    private func readProjectTransitionMetadata(_ message: [String: Any], to connection: NWConnection) {
        let requestId = message["requestId"] as? String ?? ""
        let projectPath = normalizeNativePath(message["projectPath"] as? String ?? "")
        let sequenceGuid = message["sequenceGuid"] as? String ?? ""
        let sequenceName = message["sequenceName"] as? String ?? ""
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let data = try Data(contentsOf: URL(fileURLWithPath: projectPath))
                let isGzip = data.count >= 2 && data[0] == 0x1f && data[1] == 0x8b
                let xmlData: Data
                if isGzip {
                    let temp = FileManager.default.temporaryDirectory.appendingPathComponent("PremiereBind_Transition_\(UUID().uuidString).prproj")
                    try data.write(to: temp)
                    defer { try? FileManager.default.removeItem(at: temp) }
                    xmlData = try self.runProcessCapturingOutput("/usr/bin/gzip", arguments: ["-dc", temp.path])
                } else {
                    xmlData = data
                }
                // Premiere project XML can be emitted with a UTF BOM depending
                // on the macOS/Premiere build. The Windows StreamReader detects
                // that automatically; do the equivalent here instead of
                // silently returning no transition metadata on Mac.
                guard let xml = String(data: xmlData, encoding: .utf8)
                    ?? String(data: xmlData, encoding: .utf16)
                    ?? String(data: xmlData, encoding: .utf16LittleEndian)
                    ?? String(data: xmlData, encoding: .utf16BigEndian)
                else { throw self.makeError("Could not read project transition metadata.") }
                let ns = xml as NSString
                func firstMatch(_ pattern: String, in text: String, options: NSRegularExpression.Options = [.caseInsensitive]) -> String? {
                    guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return nil }
                    let value = text as NSString
                    guard let match = regex.firstMatch(in: text, range: NSRange(location: 0, length: value.length)),
                          match.numberOfRanges > 1,
                          match.range(at: 1).location != NSNotFound else { return nil }
                    return value.substring(with: match.range(at: 1))
                }

                func objectBlock(tag: String, attribute: String, value: String) -> String? {
                    let escapedTag = NSRegularExpression.escapedPattern(for: tag)
                    let escapedValue = NSRegularExpression.escapedPattern(for: value)
                    return firstMatch(
                        "(<\(escapedTag)\\b[^>]*\(attribute)=\\\"\(escapedValue)\\\"[^>]*>[\\s\\S]*?</\(escapedTag)>)",
                        in: xml
                    )
                }

                // Follow the private sequence's real object graph:
                // Sequence -> VideoTrackGroup -> VideoClipTrack(s) ->
                // TransitionItems -> VideoTransitionTrackItem ObjectIDs.
                var scopedTransitionIDs: Set<String>? = nil
                var incomingOwners: [String: [String: Any]] = [:]
                var outgoingOwners: [String: [String: Any]] = [:]
                var sequenceBlock: String? = nil
                if !sequenceGuid.isEmpty {
                    sequenceBlock = objectBlock(tag: "Sequence", attribute: "ObjectUID", value: sequenceGuid)
                }
                if sequenceBlock == nil, !sequenceName.isEmpty {
                    let escapedName = NSRegularExpression.escapedPattern(for: sequenceName)
                    sequenceBlock = firstMatch(
                        "(<Sequence\\b[^>]*ObjectUID=\\\"[^\\\"]+\\\"[^>]*>[\\s\\S]*?<Name>\\s*\(escapedName)\\s*</Name>[\\s\\S]*?</Sequence>)",
                        in: xml
                    )
                }
                if let sequenceBlock {
                    let trackKinds = [
                        (groupIndex: 0, groupTag: "VideoTrackGroup", trackTag: "VideoClipTrack", clipTag: "VideoClipTrackItem"),
                        (groupIndex: 1, groupTag: "AudioTrackGroup", trackTag: "AudioClipTrack", clipTag: "AudioClipTrackItem")
                    ]
                    var ids = Set<String>()
                    for kind in trackKinds {
                        let groupPattern = "<TrackGroup\\b[^>]*Index=\\\"\(kind.groupIndex)\\\"[^>]*>[\\s\\S]*?<Second\\b[^>]*ObjectRef=\\\"([^\\\"]+)\\\""
                        guard let groupID = firstMatch(groupPattern, in: sequenceBlock),
                              let groupBlock = objectBlock(tag: kind.groupTag, attribute: "ObjectID", value: groupID) else { continue }
                    let groupNSString = groupBlock as NSString
                    let trackRegex = try NSRegularExpression(
                        pattern: #"<Track\b[^>]*ObjectURef="([^"]+)"[^>]*/>"#,
                        options: [.caseInsensitive]
                    )
                    let trackUIDs = trackRegex.matches(
                        in: groupBlock,
                        range: NSRange(location: 0, length: groupNSString.length)
                    ).compactMap { match -> String? in
                        guard match.numberOfRanges > 1 else { return nil }
                        return groupNSString.substring(with: match.range(at: 1))
                    }
                    for trackUID in trackUIDs {
                        guard let trackBlock = objectBlock(tag: kind.trackTag, attribute: "ObjectUID", value: trackUID),
                              let transitionItems = firstMatch(
                                  #"(<TransitionItems\b[\s\S]*?</TransitionItems>)"#,
                                  in: trackBlock
                              ) else { continue }
                        // Clip head/tail references identify the actual owner;
                        // time proximity cannot distinguish both sides of a cut.
                        let trackIndex = Int(firstMatch(#"<Index>\s*([0-9]+)\s*</Index>"#, in: trackBlock) ?? "0") ?? 0
                        if let clipItems = firstMatch(#"(<ClipItems\b[\s\S]*?</ClipItems>)"#, in: trackBlock) {
                            let refs = try NSRegularExpression(pattern: #"<TrackItem\b[^>]*ObjectRef="([^"]+)""#)
                            let clipsNS = clipItems as NSString
                            for ref in refs.matches(in: clipItems, range: NSRange(location: 0, length: clipsNS.length)) {
                                let clipID = clipsNS.substring(with: ref.range(at: 1))
                                guard let clipBlock = objectBlock(tag: kind.clipTag, attribute: "ObjectID", value: clipID),
                                      let timingBlock = firstMatch(#"(<TrackItem\b[^>]*>[\s\S]*?</TrackItem>)"#, in: clipBlock),
                                      let clipStart = Double(firstMatch(#"<Start>\s*([^<]+)</Start>"#, in: timingBlock) ?? "0") else { continue }
                                let owner: [String: Any] = ["trackIndex": trackIndex, "startSeconds": clipStart / 254016000000.0]
                                if let head = firstMatch(#"<HeadTransition\b[^>]*ObjectRef="([^"]+)""#, in: clipBlock) {
                                    incomingOwners[head] = owner
                                }
                                if let tail = firstMatch(#"<TailTransition\b[^>]*ObjectRef="([^"]+)""#, in: clipBlock) {
                                    outgoingOwners[tail] = owner
                                }
                            }
                        }
                        let itemsNSString = transitionItems as NSString
                        let refRegex = try NSRegularExpression(
                            pattern: #"<TrackItem\b[^>]*ObjectRef="([^"]+)"[^>]*/>"#,
                            options: [.caseInsensitive]
                        )
                        refRegex.matches(
                            in: transitionItems,
                            range: NSRange(location: 0, length: itemsNSString.length)
                        ).forEach { match in
                            if match.numberOfRanges > 1 {
                                ids.insert(itemsNSString.substring(with: match.range(at: 1)))
                            }
                        }
                    }
                    }
                    scopedTransitionIDs = ids
                }
                // Premiere changes the order and nesting of transition fields
                // between macOS builds. Parse each transition block first and
                // then read its tags independently instead of relying on one
                // exact XML field order.
                let blockRegex = try NSRegularExpression(
                    pattern: #"<(?:Video|Audio)TransitionTrackItem\b[\s\S]*?</(?:Video|Audio)TransitionTrackItem>"#,
                    options: [.caseInsensitive]
                )
                let blockMatches = blockRegex.matches(in: xml, range: NSRange(location: 0, length: ns.length)).filter { blockMatch in
                    guard let scopedTransitionIDs else { return sequenceGuid.isEmpty && sequenceName.isEmpty }
                    let openingTag = ns.substring(with: blockMatch.range)
                    guard let objectID = firstMatch(#"<(?:Video|Audio)TransitionTrackItem\b[^>]*ObjectID="([^"]+)""#, in: openingTag) else {
                        return false
                    }
                    return scopedTransitionIDs.contains(objectID)
                }
                let transitions: [[String: Any]] = blockMatches.compactMap { blockMatch in
                    let block = ns.substring(with: blockMatch.range)
                    let blockNSString = block as NSString

                    func tagValues(_ tag: String) -> [String] {
                        let escapedTag = NSRegularExpression.escapedPattern(for: tag)
                        guard let tagRegex = try? NSRegularExpression(
                            pattern: "<\\s*\(escapedTag)\\s*>([\\s\\S]*?)</\\s*\(escapedTag)\\s*>",
                            options: [.caseInsensitive]
                        ) else { return [] }
                        return tagRegex.matches(
                            in: block,
                            range: NSRange(location: 0, length: blockNSString.length)
                        ).compactMap { match in
                            guard match.numberOfRanges > 1, match.range(at: 1).location != NSNotFound else { return nil }
                            return blockNSString.substring(with: match.range(at: 1))
                                .trimmingCharacters(in: .whitespacesAndNewlines)
                        }
                    }

                    // Read timeline geometry only from the TrackItem, not
                    // nested effect parameters. Premiere omits Start when it
                    // is zero (confirmed by the client's Mac project). Missing
                    // Start is therefore zero, not a missing transition.
                    guard let trackItemBlock = firstMatch(
                        #"(<TrackItem\b[^>]*>[\s\S]*?</TrackItem>)"#,
                        in: block
                    ) else { return nil }
                    let startText = firstMatch(#"<Start\b[^>]*>\s*([^<]+)</Start>"#, in: trackItemBlock)
                    let endText = firstMatch(#"<End\b[^>]*>\s*([^<]+)</End>"#, in: trackItemBlock)
                    guard let startTicks = Double((startText ?? "0").trimmingCharacters(in: .whitespacesAndNewlines)),
                          let endText,
                          let endTicks = Double(endText.trimmingCharacters(in: .whitespacesAndNewlines)),
                          startTicks.isFinite, endTicks.isFinite, endTicks > startTicks else { return nil }
                    let transitionRange = (start: startTicks, end: endTicks, duration: endTicks - startTicks)
                    let displayNames = tagValues("DisplayName").filter { !$0.isEmpty }
                    let matchNames = tagValues("MatchName").filter { !$0.isEmpty }
                    let displayName = displayNames.first(where: { $0.caseInsensitiveCompare("Transition") != .orderedSame })
                        ?? displayNames.first
                        ?? "Transition"
                    let matchName = matchNames.first(where: { $0.caseInsensitiveCompare("Transition") != .orderedSame })
                        ?? matchNames.first
                        ?? displayName
                    let outgoing = tagValues("HasOutgoingClip").first?.lowercased() == "true"
                    let incoming = tagValues("HasIncomingClip").first?.lowercased() == "true"
                    let objectID = firstMatch(#"<(?:Video|Audio)TransitionTrackItem\b[^>]*ObjectID="([^"]+)""#, in: block) ?? ""
                    let transitionType = firstMatch(#"<(Video|Audio)TransitionTrackItem\b"#, in: block)?.lowercased() ?? "video"
                    var metadata: [String: Any] = [
                        "objectID": objectID,
                        "displayName": displayName,
                        "matchName": matchName,
                        "hasOutgoingClip": outgoing,
                        "hasIncomingClip": incoming,
                        "startSeconds": transitionRange.start / 254016000000.0,
                        "endSeconds": transitionRange.end / 254016000000.0,
                        "durationSeconds": transitionRange.duration / 254016000000.0,
                        "type": transitionType
                    ]
                    if let owner = incomingOwners[objectID] {
                        metadata["owner"] = owner
                        metadata["applyToStart"] = true
                    } else if let owner = outgoingOwners[objectID] {
                        metadata["owner"] = owner
                        metadata["applyToStart"] = false
                    }
                    // Head/TailTransition references establish ownership, but
                    // some macOS project builds serialize only one reference
                    // for a transition that still participates in both clips.
                    // HasOutgoingClip + HasIncomingClip are authoritative for
                    // centred/two-sided geometry.
                    metadata["forceSingleSided"] = !(outgoing && incoming)
                    return metadata
                }
                self.send(["type": "projectTransitionMetadataResult", "requestId": requestId, "ok": true, "exactOwnership": true, "transitions": transitions], on: connection)
            } catch {
                self.send(["type": "projectTransitionMetadataResult", "requestId": requestId, "ok": false, "error": error.localizedDescription], on: connection)
            }
        }
    }

    private func exportLibraryZip(_ message: [String: Any], to connection: NWConnection) {
        let requestId = message["requestId"] as? String ?? ""
        let outputPath = normalizeNativePath(message["outputPath"] as? String ?? "")
        let libraryData = message["libraryData"] ?? [:]
        let requestedPaths = (message["mediaPaths"] as? [String] ?? []).map(normalizeNativePath)

        // File copying and compression must not block shortcut handling or the
        // WebSocket receive loop.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            var temporaryDirectory: URL?
            do {
                guard !outputPath.isEmpty else {
                    throw self.makeError("An export destination is required.")
                }

                var portablePaths = Set(requestedPaths.filter { !$0.isEmpty })
                let desiredMediaNames = self.collectSavedClipFileNames(from: libraryData)
                for mediaPath in self.discoverSnapshotMediaPaths(
                    projectPaths: Array(portablePaths),
                    desiredMediaNames: desiredMediaNames
                ) {
                    portablePaths.insert(mediaPath)
                }
                let uniquePaths = Array(portablePaths).sorted()
                let missingPaths = uniquePaths.filter { !FileManager.default.fileExists(atPath: $0) }
                guard missingPaths.isEmpty else {
                    throw self.makeError("Cannot create a portable package because \(missingPaths.count) referenced file(s) are missing. First missing file: \(missingPaths[0])")
                }

                let tempURL = FileManager.default.temporaryDirectory
                    .appendingPathComponent("PremiereBind_Export_\(UUID().uuidString)", isDirectory: true)
                temporaryDirectory = tempURL
                let mediaURL = tempURL.appendingPathComponent("media", isDirectory: true)
                try FileManager.default.createDirectory(at: mediaURL, withIntermediateDirectories: true)

                self.sendExportProgress(
                    requestId: requestId,
                    percent: 8,
                    label: "Preparing package…",
                    detail: "\(uniquePaths.count) file\(uniquePaths.count == 1 ? "" : "s") to package",
                    on: connection
                )

                let libraryJSON = try JSONSerialization.data(withJSONObject: libraryData, options: [])
                try libraryJSON.write(to: tempURL.appendingPathComponent("library.json"), options: .atomic)

                var manifest: [String: String] = [:]
                var usedNames = Set<String>()
                for (index, sourcePath) in uniquePaths.enumerated() {
                    let sourceURL = URL(fileURLWithPath: sourcePath)
                    let destinationName = self.uniqueFileName(for: sourceURL.lastPathComponent, usedNames: &usedNames)
                    let destinationURL = mediaURL.appendingPathComponent(destinationName)
                    try FileManager.default.copyItem(at: sourceURL, to: destinationURL)
                    manifest[sourcePath] = "media/\(destinationName)"

                    let percent = uniquePaths.isEmpty
                        ? 76
                        : 10 + Int((Double(index + 1) / Double(uniquePaths.count) * 66.0).rounded())
                    self.sendExportProgress(
                        requestId: requestId,
                        percent: percent,
                        label: "Copying library files…",
                        detail: "\(index + 1) / \(uniquePaths.count)  ·  \(sourceURL.lastPathComponent)",
                        on: connection
                    )
                }

                let manifestJSON = try JSONSerialization.data(withJSONObject: manifest, options: [])
                try manifestJSON.write(to: tempURL.appendingPathComponent("media-manifest.json"), options: .atomic)

                self.sendExportProgress(
                    requestId: requestId,
                    percent: 82,
                    label: "Compressing package…",
                    detail: "Keep Premiere Pro open until export completes",
                    on: connection
                )

                let outputURL = URL(fileURLWithPath: outputPath)
                try FileManager.default.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)
                if FileManager.default.fileExists(atPath: outputURL.path) {
                    try FileManager.default.removeItem(at: outputURL)
                }
                try self.runProcess("/usr/bin/ditto", arguments: [
                    "-c", "-k", "--sequesterRsrc", tempURL.path + "/", outputURL.path
                ])

                try? FileManager.default.removeItem(at: tempURL)
                temporaryDirectory = nil
                self.send([
                    "type": "exportResult",
                    "requestId": requestId,
                    "ok": true,
                    "outputPath": outputPath,
                    "mediaCount": uniquePaths.count,
                    "missingCount": 0
                ], on: connection)
            } catch {
                if let temporaryDirectory { try? FileManager.default.removeItem(at: temporaryDirectory) }
                self.send([
                    "type": "exportResult",
                    "requestId": requestId,
                    "ok": false,
                    "error": error.localizedDescription
                ], on: connection)
            }
        }
    }

    private func importLibraryZip(_ message: [String: Any], to connection: NWConnection) {
        let requestId = message["requestId"] as? String ?? ""
        let inputPath = normalizeNativePath(message["inputPath"] as? String ?? "")

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                try self.importAndSendToPanel(inputPath: inputPath, requestId: requestId, connection: connection)
            } catch {
                self.send([
                    "type": "importResult",
                    "requestId": requestId,
                    "ok": false,
                    "error": error.localizedDescription
                ], on: connection)
            }
        }
    }

    func queueExternalImports(_ urls: [URL]) {
        let paths = urls
            .filter { ["prbind", "json"].contains($0.pathExtension.lowercased()) }
            .map(\.path)
        guard !paths.isEmpty else { return }
        companionQueue.async { [weak self] in
            guard let self else { return }
            self.pendingExternalImports.append(contentsOf: paths)
            if let connection = self.panelConnection {
                self.flushPendingExternalImports(on: connection)
            }
        }
    }

    private func flushPendingExternalImports(on connection: NWConnection) {
        let imports = pendingExternalImports
        pendingExternalImports.removeAll()
        for inputPath in imports {
            let requestId = "external-import-\(UUID().uuidString)"
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                guard let self else { return }
                do {
                    try self.importAndSendToPanel(inputPath: inputPath, requestId: requestId, connection: connection)
                } catch {
                    self.send([
                        "type": "importResult",
                        "requestId": requestId,
                        "ok": false,
                        "error": error.localizedDescription
                    ], on: connection)
                }
            }
        }
    }

    private func importAndSendToPanel(inputPath: String, requestId: String, connection: NWConnection) throws {
        guard !inputPath.isEmpty, FileManager.default.fileExists(atPath: inputPath) else {
            throw makeError("The portable library package was not found.")
        }

        if inputPath.lowercased().hasSuffix(".json") {
            let data = try Data(contentsOf: URL(fileURLWithPath: inputPath))
            let library = try JSONSerialization.jsonObject(with: data)
            send(["type": "import_library", "data": library, "requestId": requestId, "ok": true], on: connection)
            return
        }

        let applicationSupport = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let packageName = URL(fileURLWithPath: inputPath).deletingPathExtension().lastPathComponent
        let extractURL = applicationSupport
            .appendingPathComponent("PremiereBind/imported_media", isDirectory: true)
            .appendingPathComponent("\(packageName)-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: extractURL, withIntermediateDirectories: true)

        do {
            try runProcess("/usr/bin/ditto", arguments: ["-x", "-k", inputPath, extractURL.path])
            let packageRoot = try locatePackageRoot(in: extractURL)
            let libraryURL = packageRoot.appendingPathComponent("library.json")
            guard FileManager.default.fileExists(atPath: libraryURL.path) else {
                throw makeError("Invalid .prbind package: missing library.json.")
            }

            var libraryObject = try JSONSerialization.jsonObject(with: Data(contentsOf: libraryURL))
            let manifestURL = packageRoot.appendingPathComponent("media-manifest.json")
            if FileManager.default.fileExists(atPath: manifestURL.path) {
                let manifestData = try Data(contentsOf: manifestURL)
                guard let manifest = try JSONSerialization.jsonObject(with: manifestData) as? [String: String] else {
                    throw makeError("Invalid .prbind package: media manifest is unreadable.")
                }
                let replacements = manifest.reduce(into: [String: String]()) { result, item in
                    result[normalizeNativePath(item.key)] = packageRoot
                        .appendingPathComponent(item.value)
                        .standardizedFileURL.path
                }
                try rewriteExtractedProjectSnapshots(packageRoot: packageRoot, manifest: manifest, replacements: replacements)
                libraryObject = rewriteJSONPaths(libraryObject, replacements: replacements)
            }

            send([
                "type": "import_library",
                "data": libraryObject,
                "requestId": requestId,
                "ok": true
            ], on: connection)
        } catch {
            try? FileManager.default.removeItem(at: extractURL)
            throw error
        }
    }

    private func locatePackageRoot(in extractURL: URL) throws -> URL {
        if FileManager.default.fileExists(atPath: extractURL.appendingPathComponent("library.json").path) {
            return extractURL
        }
        let children = try FileManager.default.contentsOfDirectory(
            at: extractURL,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )
        for child in children where FileManager.default.fileExists(atPath: child.appendingPathComponent("library.json").path) {
            return child
        }
        return extractURL
    }

    private func rewriteExtractedProjectSnapshots(
        packageRoot: URL,
        manifest: [String: String],
        replacements: [String: String]
    ) throws {
        for (originalProjectPath, relativeProjectPath) in manifest where originalProjectPath.lowercased().hasSuffix(".prproj") {
            let projectURL = packageRoot.appendingPathComponent(relativeProjectPath).standardizedFileURL
            guard FileManager.default.fileExists(atPath: projectURL.path) else { continue }

            let projectData = try Data(contentsOf: projectURL)
            let isGzip = projectData.count >= 2 && projectData[0] == 0x1f && projectData[1] == 0x8b
            let workingDirectory = FileManager.default.temporaryDirectory
                .appendingPathComponent("PremiereBind_Project_\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: workingDirectory, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: workingDirectory) }

            let sourceURL = workingDirectory.appendingPathComponent("source.prproj")
            let textURL = workingDirectory.appendingPathComponent("project.xml")
            try projectData.write(to: sourceURL)
            if isGzip {
                let inflated = try runProcessCapturingOutput("/usr/bin/gzip", arguments: ["-dc", sourceURL.path])
                try inflated.write(to: textURL)
            } else {
                try projectData.write(to: textURL)
            }

            guard var projectText = String(data: try Data(contentsOf: textURL), encoding: .utf8) else {
                throw makeError("Could not read an imported Premiere project snapshot.")
            }
            for (original, local) in replacements where !original.lowercased().hasSuffix(".prproj") {
                projectText = replaceProjectPathVariants(in: projectText, originalPath: original, localPath: local)
            }
            guard let rewrittenData = projectText.data(using: .utf8) else {
                throw makeError("Could not encode an imported Premiere project snapshot.")
            }
            try rewrittenData.write(to: textURL)

            if isGzip {
                let compressed = try runProcessCapturingOutput("/usr/bin/gzip", arguments: ["-c", textURL.path])
                try compressed.write(to: projectURL, options: .atomic)
            } else {
                try rewrittenData.write(to: projectURL, options: .atomic)
            }
        }
    }

    private func rewriteJSONPaths(_ value: Any, replacements: [String: String]) -> Any {
        if let dictionary = value as? [String: Any] {
            return dictionary.mapValues { rewriteJSONPaths($0, replacements: replacements) }
        }
        if let array = value as? [Any] {
            return array.map { rewriteJSONPaths($0, replacements: replacements) }
        }
        if let string = value as? String {
            let normalized = normalizeNativePath(string)
            if let replacement = replacements.first(where: {
                $0.key.caseInsensitiveCompare(normalized) == .orderedSame
                    || $0.key.replacingOccurrences(of: "\\", with: "/").caseInsensitiveCompare(
                        normalized.replacingOccurrences(of: "\\", with: "/")
                    ) == .orderedSame
            })?.value {
                return replacement
            }
        }
        return value
    }

    private func replaceProjectPathVariants(in content: String, originalPath: String, localPath: String) -> String {
        var result = content
        var variants: [(String, String)] = [
            (originalPath, localPath),
            (originalPath.replacingOccurrences(of: "\\", with: "/"), localPath.replacingOccurrences(of: "\\", with: "/"))
        ]
        let localURL = URL(fileURLWithPath: localPath).absoluteString
        if let originalURL = URL(string: originalPath)?.absoluteString {
            variants.append((originalURL, localURL))
        }
        let slashPath = originalPath.replacingOccurrences(of: "\\", with: "/")
        if slashPath.range(of: "^[A-Za-z]:/", options: .regularExpression) != nil {
            let encodedPath = slashPath.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? slashPath
            variants.append(("file:///" + encodedPath, localURL))
        }
        for (oldValue, newValue) in variants where !oldValue.isEmpty {
            result = result.replacingOccurrences(of: oldValue, with: newValue, options: [.caseInsensitive])
        }
        return result
    }

    private func uniqueFileName(for originalName: String, usedNames: inout Set<String>) -> String {
        let url = URL(fileURLWithPath: originalName)
        let base = url.deletingPathExtension().lastPathComponent
        let fileExtension = url.pathExtension
        var candidate = originalName
        var counter = 1
        while usedNames.contains(candidate.lowercased()) {
            candidate = fileExtension.isEmpty ? "\(base)_\(counter)" : "\(base)_\(counter).\(fileExtension)"
            counter += 1
        }
        usedNames.insert(candidate.lowercased())
        return candidate
    }

    private func collectSavedClipFileNames(from value: Any) -> Set<String> {
        var names = Set<String>()
        func visit(_ node: Any, insideClip: Bool) {
            if let dictionary = node as? [String: Any] {
                let identifier = dictionary["id"] as? String ?? ""
                let isClip = insideClip || identifier.lowercased().hasPrefix("clip-")
                for (key, child) in dictionary {
                    if isClip,
                       (key == "title" || key == "name"),
                       let text = child as? String,
                       !URL(fileURLWithPath: text).pathExtension.isEmpty {
                        names.insert(URL(fileURLWithPath: text).lastPathComponent.lowercased())
                    }
                    visit(child, insideClip: isClip)
                }
            } else if let array = node as? [Any] {
                for child in array { visit(child, insideClip: insideClip) }
            }
        }
        visit(value, insideClip: false)
        return names
    }

    private func discoverSnapshotMediaPaths(
        projectPaths: [String],
        desiredMediaNames: Set<String>
    ) -> Set<String> {
        guard !desiredMediaNames.isEmpty else { return [] }
        var results = Set<String>()
        let expression = try? NSRegularExpression(
            pattern: #"(?i)(?:file://)?/(?:Users|Volumes|private|Network)/[^<\"\r\n]+"#,
            options: []
        )
        guard let expression else { return [] }

        for projectPath in projectPaths where projectPath.lowercased().hasSuffix(".prproj") {
            guard FileManager.default.fileExists(atPath: projectPath),
                  let projectData = try? Data(contentsOf: URL(fileURLWithPath: projectPath)) else { continue }
            let workingDirectory = FileManager.default.temporaryDirectory
                .appendingPathComponent("PremiereBind_Scan_\(UUID().uuidString)", isDirectory: true)
            defer { try? FileManager.default.removeItem(at: workingDirectory) }

            let isGzip = projectData.count >= 2 && projectData[0] == 0x1f && projectData[1] == 0x8b
            var textData = projectData
            if isGzip {
                do {
                    try FileManager.default.createDirectory(at: workingDirectory, withIntermediateDirectories: true)
                    let sourceURL = workingDirectory.appendingPathComponent("snapshot.prproj")
                    try projectData.write(to: sourceURL)
                    textData = try runProcessCapturingOutput("/usr/bin/gzip", arguments: ["-dc", sourceURL.path])
                } catch {
                    continue
                }
            }
            guard let projectText = String(data: textData, encoding: .utf8) else { continue }
            let fullRange = NSRange(projectText.startIndex..<projectText.endIndex, in: projectText)
            for match in expression.matches(in: projectText, options: [], range: fullRange) {
                guard let range = Range(match.range, in: projectText) else { continue }
                var candidate = String(projectText[range])
                candidate = decodeXMLPath(candidate).trimmingCharacters(in: .whitespacesAndNewlines)
                candidate = normalizeNativePath(candidate)
                guard FileManager.default.fileExists(atPath: candidate) else { continue }
                let fileName = URL(fileURLWithPath: candidate).lastPathComponent.lowercased()
                guard desiredMediaNames.contains(fileName) else { continue }
                results.insert(candidate)
            }
        }
        return results
    }

    private func decodeXMLPath(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&apos;", with: "'")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
    }

    private func sendExportProgress(
        requestId: String,
        percent: Int,
        label: String,
        detail: String,
        on connection: NWConnection
    ) {
        send([
            "type": "exportProgress",
            "requestId": requestId,
            "percent": percent,
            "label": label,
            "detail": detail
        ], on: connection)
    }

    @discardableResult
    private func runProcess(_ executable: String, arguments: [String]) throws -> Data {
        try runProcessCapturingOutput(executable, arguments: arguments)
    }

    private func runProcessCapturingOutput(_ executable: String, arguments: [String]) throws -> Data {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()
        let output = stdout.fileHandleForReading.readDataToEndOfFile()
        let errorOutput = stderr.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let detail = String(data: errorOutput, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
            throw makeError(detail?.isEmpty == false ? detail! : "A macOS packaging command failed.")
        }
        return output
    }

    private func makeError(_ message: String) -> NSError {
        NSError(domain: "PremiereBindCompanion", code: 10, userInfo: [NSLocalizedDescriptionKey: message])
    }

    private func send(_ payload: [String: Any], on connection: NWConnection? = nil) {
        guard let target = connection ?? panelConnection,
              let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(
            identifier: "PremiereBind",
            metadata: [metadata]
        )
        target.send(content: data, contentContext: context, isComplete: true, completion: .idempotent)
    }

    private func requestAccessibilityPermission() -> Bool {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    private func startAccessibilityMonitoring() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.accessibilityPollTimer?.invalidate()
            self.accessibilityPollTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
                self?.refreshAccessibilityState()
            }
            self.refreshAccessibilityState()
        }
    }

    private func refreshAccessibilityState() {
        let isTrusted = AXIsProcessTrusted()
        if isTrusted {
            if !accessibilityPermissionGranted || eventTap == nil {
                accessibilityPermissionGranted = true
                removeGlobalKeyboardMonitor()
                installGlobalKeyboardMonitor()
                if eventTap != nil {
                    companionQueue.async { [weak self] in
                        self?.send(["type": "companionStatus", "status": "global-shortcuts-ready"])
                    }
                }
            }
        } else if accessibilityPermissionGranted || eventTap != nil {
            accessibilityPermissionGranted = false
            removeGlobalKeyboardMonitor()
            companionQueue.async { [weak self] in
                self?.send(["type": "companionStatus", "status": "accessibility-permission-required"])
            }
        }
    }

    private func installGlobalKeyboardMonitor() {
        let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
            | CGEventMask(1 << CGEventType.keyUp.rawValue)
        let userInfo = UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: keyboardEventCallback,
            userInfo: userInfo
        ) else {
            accessibilityPermissionGranted = false
            companionQueue.async { [weak self] in
                self?.send(["type": "companionStatus", "status": "accessibility-permission-required"])
            }
            return
        }

        eventTap = tap
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        runLoopSource = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
    }

    private func removeGlobalKeyboardMonitor() {
        if let runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
        }
        if let eventTap {
            CGEvent.tapEnable(tap: eventTap, enable: false)
        }
        runLoopSource = nil
        eventTap = nil
    }

    fileprivate func handleKeyboardEvent(type: CGEventType, event: CGEvent) -> Bool {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let eventTap { CGEvent.tapEnable(tap: eventTap, enable: true) }
            return false
        }
        guard type == .keyDown || type == .keyUp else { return false }

        let key = keyFromKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
        guard !key.isEmpty else { return false }
        let isDown = type == .keyDown

        if isInsertAlignmentKey(key) {
            stateLock.lock()
            let changed = isDown ? heldAlignmentKeys.insert(key).inserted : (heldAlignmentKeys.remove(key) != nil)
            stateLock.unlock()
            if changed {
                companionQueue.async { [weak self] in
                    self?.send(["type": "insertAlignmentKeyState", "key": key.lowercased(), "isDown": isDown])
                }
            }
        }

        if !isDown {
            stateLock.lock()
            let suppressed = suppressedKeys.remove(key) != nil
            stateLock.unlock()
            return suppressed
        }

        stateLock.lock()
        let alreadySuppressed = suppressedKeys.contains(key)
        stateLock.unlock()
        if alreadySuppressed { return true }

        guard event.getIntegerValueField(.keyboardEventAutorepeat) == 0 else { return false }

        let combo = comboForKey(key, flags: event.flags)
        stateLock.lock()
        let presetId = shortcutMap[combo]
        stateLock.unlock()
        guard let presetId else { return false }

        stateLock.lock()
        suppressedKeys.insert(key)
        stateLock.unlock()

        companionQueue.async { [weak self] in
            self?.send(["type": "shortcut", "presetId": presetId, "combo": combo])
        }
        return true
    }

    private func comboForKey(_ key: String, flags: CGEventFlags) -> String {
        var parts: [String] = []
        if flags.contains(.maskControl) { parts.append("CTRL") }
        if flags.contains(.maskAlternate) { parts.append("ALT") }
        if flags.contains(.maskShift) { parts.append("SHIFT") }
        if flags.contains(.maskCommand) { parts.append("META") }
        parts.append(key)
        return parts.joined(separator: "+")
    }

    private func normalizeCombo(_ value: String) -> String? {
        let aliases = [
            "CONTROL": "CTRL", "LCTRL": "CTRL", "RCTRL": "CTRL",
            "OPTION": "ALT", "LALT": "ALT", "RALT": "ALT",
            "LSHIFT": "SHIFT", "RSHIFT": "SHIFT",
            "COMMAND": "META", "LCMD": "META", "RCMD": "META",
            "RETURN": "ENTER", "ESCAPE": "ESC", "BACK": "BACKSPACE",
            "LEFT": "ARROWLEFT", "RIGHT": "ARROWRIGHT",
            "UP": "ARROWUP", "DOWN": "ARROWDOWN",
            "PRIOR": "PAGEUP", "NEXT": "PAGEDOWN"
        ]
        let keys = value
            .split(separator: "+")
            .map { String($0).trimmingCharacters(in: .whitespaces).uppercased() }
            .map { aliases[$0] ?? $0 }
            .filter { !$0.isEmpty }
        let modifierOrder = ["CTRL", "ALT", "SHIFT", "META"]
        let modifiers = modifierOrder.filter { keys.contains($0) }
        let mainKeys = Array(Set(keys.filter { !modifierOrder.contains($0) }))
        guard mainKeys.count == 1 else { return nil }
        return (modifiers + mainKeys).joined(separator: "+")
    }

    private func normalizeNativePath(_ value: String) -> String {
        if let url = URL(string: value), url.isFileURL { return url.path }
        return value.removingPercentEncoding ?? value
    }

    private func isInsertAlignmentKey(_ key: String) -> Bool {
        key == "S" || key == "A" || key == "E"
    }

    private func keyFromKeyCode(_ keyCode: Int64) -> String {
        switch keyCode {
        case 0: return "A"
        case 1: return "S"
        case 2: return "D"
        case 3: return "F"
        case 4: return "H"
        case 5: return "G"
        case 6: return "Z"
        case 7: return "X"
        case 8: return "C"
        case 9: return "V"
        case 11: return "B"
        case 12: return "Q"
        case 13: return "W"
        case 14: return "E"
        case 15: return "R"
        case 16: return "Y"
        case 17: return "T"
        case 18: return "1"
        case 19: return "2"
        case 20: return "3"
        case 21: return "4"
        case 23: return "5"
        case 22: return "6"
        case 26: return "7"
        case 28: return "8"
        case 25: return "9"
        case 29: return "0"
        case 31: return "O"
        case 32: return "U"
        case 34: return "I"
        case 35: return "P"
        case 36: return "ENTER"
        case 48: return "TAB"
        case 49: return "SPACE"
        case 51: return "BACKSPACE"
        case 53: return "ESC"
        case 115: return "HOME"
        case 116: return "PAGEUP"
        case 117: return "DELETE"
        case 119: return "END"
        case 121: return "PAGEDOWN"
        case 122: return "F1"
        case 120: return "F2"
        case 99: return "F3"
        case 118: return "F4"
        case 96: return "F5"
        case 97: return "F6"
        case 98: return "F7"
        case 100: return "F8"
        case 101: return "F9"
        case 109: return "F10"
        case 103: return "F11"
        case 111: return "F12"
        case 105: return "F13"
        case 107: return "F14"
        case 113: return "F15"
        case 106: return "F16"
        case 64: return "F17"
        case 79: return "F18"
        case 80: return "F19"
        case 90: return "F20"
        case 123: return "ARROWLEFT"
        case 124: return "ARROWRIGHT"
        case 125: return "ARROWDOWN"
        case 126: return "ARROWUP"
        default: return ""
        }
    }

    private func scheduleIdleExit() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.idleExitTimer?.invalidate()
            self.idleExitTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: false) { [weak self] _ in
                guard let self, self.panelConnection == nil else { return }
                self.stop()
                exit(0)
            }
        }
    }

    private func cancelIdleExit() {
        DispatchQueue.main.async { [weak self] in
            self?.idleExitTimer?.invalidate()
            self?.idleExitTimer = nil
        }
    }

    private func stop() {
        listener?.cancel()
        panelConnection?.cancel()
        removeGlobalKeyboardMonitor()
        accessibilityPollTimer?.invalidate()
        accessibilityPollTimer = nil
        idleExitTimer?.invalidate()
    }
}

private let keyboardEventCallback: CGEventTapCallBack = { _, type, event, userInfo in
    if let userInfo {
        let companion = Unmanaged<PremiereBindCompanion>.fromOpaque(userInfo).takeUnretainedValue()
        if companion.handleKeyboardEvent(type: type, event: event) { return nil }
    }
    return Unmanaged.passUnretained(event)
}

private let companion = PremiereBindCompanion()
private final class CompanionApplicationDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            try companion.start()
            companion.queueExternalImports(CommandLine.arguments.dropFirst().map { URL(fileURLWithPath: $0) })
        } catch {
            NSLog("[PremiereBind Companion] Could not start: %@", error.localizedDescription)
            NSApplication.shared.terminate(nil)
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        companion.queueExternalImports(urls)
    }
}

private let applicationDelegate = CompanionApplicationDelegate()
private let application = NSApplication.shared
application.setActivationPolicy(.accessory)
application.delegate = applicationDelegate
application.run()
