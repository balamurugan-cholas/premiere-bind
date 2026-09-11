using System.IO.Compression;
using System.Net;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace PremiereBindCompanion;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length > 0 && !string.IsNullOrWhiteSpace(args[0]) && File.Exists(args[0]))
        {
            var filePath = Path.GetFullPath(args[0]);
            if (filePath.EndsWith(".prbind", StringComparison.OrdinalIgnoreCase) || filePath.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
            {
                if (TryForwardImportToRunningInstance(filePath))
                {
                    return;
                }
            }
        }

        using var singleInstance = new Mutex(true, "Local\\PremiereBindCompanion-v2", out var isFirstInstance);
        if (!isFirstInstance)
        {
            if (args.Length > 0 && File.Exists(args[0]))
            {
                TryForwardImportToRunningInstance(Path.GetFullPath(args[0]));
            }
            return;
        }

        TryRegisterFileAssociation();

        var companion = new ShortcutCompanion();
        try
        {
            companion.Start();
        }
        catch (HttpListenerException)
        {
            // Another helper instance, a stale listener, or a restricted launch owns
            // the loopback endpoint. Exit quietly instead of showing a Windows crash.
            companion.Dispose();
            return;
        }

        if (args.Length > 0 && File.Exists(args[0]))
        {
            companion.QueueInitialImport(Path.GetFullPath(args[0]));
        }

        try
        {
            while (GetMessage(out var message, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref message);
                DispatchMessage(ref message);
            }
        }
        finally
        {
            companion.Dispose();
        }
    }

    private static bool TryForwardImportToRunningInstance(string filePath)
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
            var content = new StringContent(JsonSerializer.Serialize(new { action = "openFile", path = filePath }), Encoding.UTF8, "application/json");
            var response = client.PostAsync("http://127.0.0.1:50900/open-file", content).GetAwaiter().GetResult();
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    private static void TryRegisterFileAssociation()
    {
        try
        {
            var exePath = Environment.ProcessPath;
            if (string.IsNullOrWhiteSpace(exePath) || !File.Exists(exePath)) return;

            using var keyPrbind = Registry.CurrentUser.CreateSubKey(@"Software\Classes\.prbind");
            keyPrbind.SetValue("", "PremiereBind.Package");

            using var keyProgId = Registry.CurrentUser.CreateSubKey(@"Software\Classes\PremiereBind.Package");
            keyProgId.SetValue("", "PremiereBind Preset Package");

            var iconPath = Path.Combine(AppContext.BaseDirectory, "assets", "premierebind-package.ico");
            if (!File.Exists(iconPath)) iconPath = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "assets", "premierebind-package.ico"));
            using var keyIcon = Registry.CurrentUser.CreateSubKey(@"Software\Classes\PremiereBind.Package\DefaultIcon");
            keyIcon.SetValue("", File.Exists(iconPath) ? $"\"{iconPath}\"" : $"\"{exePath}\",0");

            using var keyShell = Registry.CurrentUser.CreateSubKey(@"Software\Classes\PremiereBind.Package\shell\open\command");
            keyShell.SetValue("", $"\"{exePath}\" \"%1\"");
        }
        catch
        {
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Message
    {
        public IntPtr HWnd;
        public uint MessageId;
        public UIntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public Point Point;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll")]
    private static extern int GetMessage(out Message message, IntPtr hWnd, uint minFilter, uint maxFilter);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref Message message);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref Message message);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostThreadMessage(uint threadId, uint message, UIntPtr wParam, IntPtr lParam);
}

internal sealed class ShortcutCompanion : IDisposable
{
    private const int WhKeyboardLl = 13;
    private const int WmKeyDown = 0x0100;
    private const int WmKeyUp = 0x0101;
    private const int WmSysKeyDown = 0x0104;
    private const int WmSysKeyUp = 0x0105;

    private static readonly string[] ModifierOrder = ["CTRL", "ALT", "SHIFT", "META"];
    private static readonly Dictionary<string, string> KeyAliases = new(StringComparer.OrdinalIgnoreCase)
    {
        ["CONTROL"] = "CTRL", ["LCTRL"] = "CTRL", ["RCTRL"] = "CTRL",
        ["MENU"] = "ALT", ["LALT"] = "ALT", ["RALT"] = "ALT",
        ["LSHIFT"] = "SHIFT", ["RSHIFT"] = "SHIFT",
        ["LWIN"] = "META", ["RWIN"] = "META",
        ["RETURN"] = "ENTER", ["ESCAPE"] = "ESC",
        ["LEFT"] = "ARROWLEFT", ["RIGHT"] = "ARROWRIGHT",
        ["UP"] = "ARROWUP", ["DOWN"] = "ARROWDOWN",
        ["PRIOR"] = "PAGEUP", ["NEXT"] = "PAGEDOWN",
        ["BACK"] = "BACKSPACE"
    };

    private readonly object _stateLock = new();
    private readonly HttpListener _listener = new();
    private readonly CancellationTokenSource _cancellation = new();
    private readonly HashSet<string> _heldKeys = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _suppressedKeys = new(StringComparer.OrdinalIgnoreCase);
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private readonly LowLevelKeyboardProc _keyboardCallback;
    private readonly Timer _idleTimer;
    private Dictionary<string, string> _shortcutMap = new(StringComparer.OrdinalIgnoreCase);
    private WebSocket? _panelSocket;
    private IntPtr _hookHandle;
    private uint _mainThreadId;
    private DateTime _lastPanelDisconnectUtc = DateTime.UtcNow;
    private string? _pendingImportFilePath;

    public ShortcutCompanion()
    {
        _keyboardCallback = KeyboardHookCallback;
        _idleTimer = new Timer(OnIdleTimer, null, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
    }

    public void QueueInitialImport(string filePath)
    {
        lock (_stateLock) _pendingImportFilePath = filePath;
    }

    public void Start()
    {
        _mainThreadId = Program.GetCurrentThreadId();
        _listener.Prefixes.Add("http://127.0.0.1:50900/");
        _listener.Start();
        _ = Task.Run(ListenForPanelsAsync);

        _hookHandle = SetWindowsHookEx(WhKeyboardLl, _keyboardCallback, GetModuleHandle(null), 0);
        if (_hookHandle == IntPtr.Zero)
        {
            Dispose();
            throw new InvalidOperationException("PremiereBind could not install its global keyboard listener.");
        }

        _idleTimer.Change(TimeSpan.FromSeconds(15), TimeSpan.FromSeconds(15));
    }

    private async Task ListenForPanelsAsync()
    {
        while (!_cancellation.IsCancellationRequested)
        {
            HttpListenerContext context;
            try
            {
                context = await _listener.GetContextAsync().WaitAsync(_cancellation.Token);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch
            {
                if (_cancellation.IsCancellationRequested) return;
                continue;
            }

            _ = HandleContextAsync(context);
        }
    }

    private async Task HandleContextAsync(HttpListenerContext context)
    {
        if (context.Request.HttpMethod.Equals("POST", StringComparison.OrdinalIgnoreCase) &&
            context.Request.Url?.AbsolutePath == "/open-file")
        {
            await HandleOpenFileHttpAsync(context);
            return;
        }

        if (!context.Request.IsWebSocketRequest)
        {
            context.Response.StatusCode = (int)HttpStatusCode.BadRequest;
            context.Response.Close();
            return;
        }

        WebSocket socket;
        try
        {
            socket = (await context.AcceptWebSocketAsync(null)).WebSocket;
        }
        catch
        {
            return;
        }

        WebSocket? previousSocket;
        lock (_stateLock)
        {
            previousSocket = _panelSocket;
            _panelSocket = socket;
            _lastPanelDisconnectUtc = DateTime.UtcNow;
        }

        if (previousSocket is not null && previousSocket.State == WebSocketState.Open)
        {
            try { await previousSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Replaced by newer panel connection.", CancellationToken.None); } catch { }
            previousSocket.Dispose();
        }

        await SendToPanelAsync(socket, new { type = "companionStatus", status = "ready" });

        string? pendingPath;
        lock (_stateLock)
        {
            pendingPath = _pendingImportFilePath;
            _pendingImportFilePath = null;
        }
        if (!string.IsNullOrEmpty(pendingPath))
        {
            _ = Task.Run(async () =>
            {
                await Task.Delay(500);
                await ImportAndSendToPanelAsync(socket, pendingPath);
            });
        }

        await ReceiveLoopAsync(socket);
    }

    private async Task HandleOpenFileHttpAsync(HttpListenerContext context)
    {
        try
        {
            using var reader = new StreamReader(context.Request.InputStream, Encoding.UTF8);
            var body = await reader.ReadToEndAsync();
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.TryGetProperty("path", out var pathProp))
            {
                var filePath = pathProp.GetString();
                if (!string.IsNullOrWhiteSpace(filePath) && File.Exists(filePath))
                {
                    WebSocket? socket;
                    lock (_stateLock) socket = _panelSocket;
                    if (socket is not null && socket.State == WebSocketState.Open)
                    {
                        await ImportAndSendToPanelAsync(socket, filePath);
                        context.Response.StatusCode = (int)HttpStatusCode.OK;
                        context.Response.Close();
                        return;
                    }
                }
            }
        }
        catch { }

        context.Response.StatusCode = (int)HttpStatusCode.Accepted;
        context.Response.Close();
    }

    private async Task ReceiveLoopAsync(WebSocket socket)
    {
        var buffer = new byte[65536];
        try
        {
            while (socket.State == WebSocketState.Open && !_cancellation.IsCancellationRequested)
            {
                using var messageBuffer = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await socket.ReceiveAsync(buffer, _cancellation.Token);
                    if (result.MessageType == WebSocketMessageType.Close) break;
                    if (result.MessageType == WebSocketMessageType.Text && result.Count > 0)
                    {
                        await messageBuffer.WriteAsync(buffer.AsMemory(0, result.Count), _cancellation.Token);
                    }

                    // Protect the local helper from malformed/unbounded input.
                    if (messageBuffer.Length > 64L * 1024L * 1024L)
                    {
                        throw new InvalidDataException("The PremiereBind request is larger than 64 MB.");
                    }
                }
                while (!result.EndOfMessage);

                if (result.MessageType == WebSocketMessageType.Close) break;
                if (result.MessageType != WebSocketMessageType.Text) continue;

                var message = Encoding.UTF8.GetString(messageBuffer.ToArray());
                await HandlePanelMessageAsync(socket, message);
            }
        }
        catch
        {
        }
        finally
        {
            lock (_stateLock)
            {
                if (_panelSocket == socket)
                {
                    _panelSocket = null;
                    _lastPanelDisconnectUtc = DateTime.UtcNow;
                }
            }
            socket.Dispose();
        }
    }

    private async Task HandlePanelMessageAsync(WebSocket socket, string message)
    {
        try
        {
            using var document = JsonDocument.Parse(message);
            var root = document.RootElement;
            if (!root.TryGetProperty("type", out var type)) return;

            var typeStr = type.GetString();
            if (typeStr == "syncShortcuts")
            {
                SyncShortcuts(root);
                return;
            }

            if (typeStr == "copyProjectSnapshot")
            {
                await CopyProjectSnapshotAsync(socket, root);
                return;
            }

            if (typeStr == "readProjectTransitionMetadata")
            {
                await ReadProjectTransitionMetadataAsync(socket, root);
                return;
            }

            if (typeStr == "exportLibraryZip")
            {
                await ExportLibraryZipAsync(socket, root);
                return;
            }

            if (typeStr == "importLibraryZip")
            {
                await ImportLibraryZipAsync(socket, root);
                return;
            }

            if (typeStr == "analyzeAudioBeats")
            {
                await AnalyzeAudioBeatsAsync(socket, root);
                return;
            }

            if (typeStr == "premiereClipboardShortcut")
            {
                await SendPremiereClipboardShortcutAsync(socket, root);
                return;
            }
        }
        catch (JsonException)
        {
        }
    }

    private async Task SendPremiereClipboardShortcutAsync(WebSocket socket, JsonElement root)
    {
        var requestId = root.TryGetProperty("requestId", out var requestValue) ? requestValue.GetString() ?? "" : "";
        var action = root.TryGetProperty("action", out var actionValue) ? actionValue.GetString() ?? "" : "";
        var virtualKey = action.Equals("copy", StringComparison.OrdinalIgnoreCase) ? (byte)0x43
            : action.Equals("paste", StringComparison.OrdinalIgnoreCase) ? (byte)0x56
            : (byte)0;
        if (virtualKey == 0 && action != "focus")
        {
            await SendToPanelAsync(socket, new { type = "premiereClipboardShortcutResult", requestId, ok = false, error = "Unsupported clipboard action." });
            return;
        }

        // Never deliver clipboard shortcuts to whichever application happens to be active.
        var premiere = System.Diagnostics.Process.GetProcessesByName("Adobe Premiere Pro")
            .FirstOrDefault(process => process.MainWindowHandle != IntPtr.Zero);
        if (premiere == null || (!IsPremiereForeground(premiere.Id) && !SetForegroundWindow(premiere.MainWindowHandle)))
        {
            await SendToPanelAsync(socket, new { type = "premiereClipboardShortcutResult", requestId, ok = false, error = "Activate Premiere Pro before transferring native clips." });
            return;
        }
        await Task.Delay(150);
        if (!IsPremiereForeground(premiere.Id))
        {
            await SendToPanelAsync(socket, new { type = "premiereClipboardShortcutResult", requestId, ok = false, error = "Premiere Pro lost focus; native transfer cancelled." });
            return;
        }
        // Premiere's Timeline shortcut. A customized binding is detected by the copy verification below.
        if (action == "focus") {
        keybd_event(0x10, 0, 0, UIntPtr.Zero);
        keybd_event(0x33, 0, 0, UIntPtr.Zero);
        keybd_event(0x33, 0, 0x0002, UIntPtr.Zero);
        keybd_event(0x10, 0, 0x0002, UIntPtr.Zero);
        await Task.Delay(150);
        await SendToPanelAsync(socket, new { type = "premiereClipboardShortcutResult", requestId, ok = true, action });
        return; }
        var clipboardBefore = GetClipboardSequenceNumber();
        const byte controlKey = 0x11;
        const uint keyUp = 0x0002;
        keybd_event(controlKey, 0, 0, UIntPtr.Zero);
        keybd_event(virtualKey, 0, 0, UIntPtr.Zero);
        keybd_event(virtualKey, 0, keyUp, UIntPtr.Zero);
        keybd_event(controlKey, 0, keyUp, UIntPtr.Zero);
        if (action == "copy") {
            for (var poll = 0; poll < 50 && GetClipboardSequenceNumber() == clipboardBefore; poll++)
                await Task.Delay(100);
        } else await Task.Delay(250);
        var clipboardAfter = GetClipboardSequenceNumber();
        await SendToPanelAsync(socket, new { type = "premiereClipboardShortcutResult", requestId, ok = true, action, clipboardToken = clipboardAfter, clipboardChanged = clipboardAfter != clipboardBefore });
    }

    private async Task AnalyzeAudioBeatsAsync(WebSocket socket, JsonElement root)
    {
        var requestId = root.TryGetProperty("requestId", out var requestValue) ? requestValue.GetString() ?? "" : "";
        var mediaPath = root.TryGetProperty("mediaPath", out var pathValue) ? NormalizeNativePath(pathValue.GetString() ?? "") : "";
        var sensitivity = root.TryGetProperty("sensitivity", out var sensitivityValue) ? sensitivityValue.GetString() ?? "balanced" : "balanced";
        try
        {
            if (string.IsNullOrWhiteSpace(mediaPath) || !File.Exists(mediaPath)) throw new FileNotFoundException("Audio media was not found", mediaPath);
            var beats = await Task.Run(() => DetectAudioBeats(mediaPath, sensitivity));
            await SendToPanelAsync(socket, new { type = "audioBeatAnalysisResult", requestId, ok = true, beats });
        }
        catch (Exception error)
        {
            await SendToPanelAsync(socket, new { type = "audioBeatAnalysisResult", requestId, ok = false, error = error.Message });
        }
    }

    private static List<double> DetectAudioBeats(string mediaPath, string sensitivity)
    {
        using var reader = new NAudio.Wave.AudioFileReader(mediaPath);
        var channels = Math.Max(1, reader.WaveFormat.Channels);
        var sampleRate = Math.Max(1, reader.WaveFormat.SampleRate);
        var hopFrames = 512;
        var buffer = new float[hopFrames * channels];
        var onsets = new List<double>();
        var strengths = new List<double>();
        double previousEnergy = 0, previousDifference = 0;
        long framePosition = 0;

        while (true)
        {
            var read = reader.Read(buffer, 0, buffer.Length);
            if (read <= 0) break;
            var frames = read / channels;
            if (frames <= 0) break;
            double energy = 0, difference = 0, previousMono = 0;
            for (var frame = 0; frame < frames; frame++)
            {
                double mono = 0;
                for (var channel = 0; channel < channels; channel++) mono += buffer[frame * channels + channel];
                mono /= channels;
                energy += mono * mono;
                if (frame > 0) difference += Math.Abs(mono - previousMono);
                previousMono = mono;
            }
            energy = Math.Sqrt(energy / frames);
            difference /= frames;
            var strength = Math.Max(0, energy - previousEnergy) + 0.65 * Math.Max(0, difference - previousDifference);
            strengths.Add(strength);
            onsets.Add((double)framePosition / sampleRate);
            previousEnergy = 0.75 * previousEnergy + 0.25 * energy;
            previousDifference = 0.75 * previousDifference + 0.25 * difference;
            framePosition += frames;
        }

        var mode = sensitivity.Trim().ToLowerInvariant();
        // Sensitivity controls both confidence and density. Keeping meaningful
        // separation here prevents strong, regular clicks from passing all
        // three modes with effectively identical output.
        var thresholdMultiplier = mode == "high" ? 1.25 : mode == "low" ? 2.75 : 1.85;
        var minimumSpacing = mode == "high" ? 0.12 : mode == "low" ? 1.40 : 0.65;
        var beats = new List<double>();
        for (var index = 2; index < strengths.Count - 2; index++)
        {
            var from = Math.Max(0, index - 24);
            var count = index - from;
            if (count < 4) continue;
            var mean = 0.0;
            for (var i = from; i < index; i++) mean += strengths[i];
            mean /= count;
            var variance = 0.0;
            for (var i = from; i < index; i++) variance += Math.Pow(strengths[i] - mean, 2);
            var deviation = Math.Sqrt(variance / count);
            var threshold = mean * thresholdMultiplier + deviation * 0.35 + 0.00001;
            var isPeak = strengths[index] >= strengths[index - 1] && strengths[index] > strengths[index + 1];
            if (!isPeak || strengths[index] < threshold) continue;
            var seconds = onsets[index];
            if (beats.Count == 0 || seconds - beats[^1] >= minimumSpacing) beats.Add(Math.Round(seconds, 6));
            else if (strengths[index] > strengths[Math.Max(0, index - 1)]) beats[^1] = Math.Round(seconds, 6);
        }
        return beats;
    }

    private void SyncShortcuts(JsonElement root)
    {
        if (!root.TryGetProperty("presets", out var presets) || presets.ValueKind != JsonValueKind.Array) return;

        var shortcuts = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var preset in presets.EnumerateArray())
        {
            if (!preset.TryGetProperty("id", out var idValue) || !preset.TryGetProperty("shortcut", out var shortcutValue)) continue;
            var id = idValue.GetString();
            var combo = NormalizeCombo(shortcutValue.GetString());
            if (!string.IsNullOrWhiteSpace(id) && !string.IsNullOrWhiteSpace(combo)) shortcuts.TryAdd(combo, id);
        }

        lock (_stateLock) _shortcutMap = shortcuts;
    }

    private async Task CopyProjectSnapshotAsync(WebSocket socket, JsonElement root)
    {
        var requestId = root.TryGetProperty("requestId", out var requestIdValue) ? requestIdValue.GetString() ?? "" : "";
        var sourcePath = root.TryGetProperty("sourcePath", out var sourcePathValue) ? NormalizeNativePath(sourcePathValue.GetString() ?? "") : "";
        var destinationPath = root.TryGetProperty("destinationPath", out var destinationPathValue) ? NormalizeNativePath(destinationPathValue.GetString() ?? "") : "";

        try
        {
            if (string.IsNullOrWhiteSpace(sourcePath) || !File.Exists(sourcePath)) throw new FileNotFoundException("Source not found", sourcePath);
            if (string.IsNullOrWhiteSpace(destinationPath)) throw new InvalidOperationException("Invalid destination");

            var destDir = Path.GetDirectoryName(destinationPath);
            if (!string.IsNullOrWhiteSpace(destDir)) Directory.CreateDirectory(destDir);
            File.Copy(sourcePath, destinationPath, true);

            await SendToPanelAsync(socket, new { type = "projectSnapshotResult", requestId, ok = true, destinationPath });
        }
        catch (Exception error)
        {
            await SendToPanelAsync(socket, new { type = "projectSnapshotResult", requestId, ok = false, error = error.Message });
        }
    }

    private async Task ReadProjectTransitionMetadataAsync(WebSocket socket, JsonElement root)
    {
        var requestId = root.TryGetProperty("requestId", out var requestIdValue) ? requestIdValue.GetString() ?? "" : "";
        var projectPath = root.TryGetProperty("projectPath", out var pathValue) ? NormalizeNativePath(pathValue.GetString() ?? "") : "";
        try
        {
            if (string.IsNullOrWhiteSpace(projectPath) || !File.Exists(projectPath)) throw new FileNotFoundException("Project snapshot not found.", projectPath);
            string xml;
            await using (var input = File.OpenRead(projectPath))
            {
                var signature = new byte[2];
                var count = await input.ReadAsync(signature);
                input.Position = 0;
                Stream content = count == 2 && signature[0] == 0x1f && signature[1] == 0x8b
                    ? new GZipStream(input, CompressionMode.Decompress, leaveOpen: false)
                    : input;
                using var reader = new StreamReader(content, Encoding.UTF8);
                xml = await reader.ReadToEndAsync();
            }
            var matches = Regex.Matches(xml, @"<(?<media>Video|Audio)TransitionTrackItem\b[\s\S]*?<TransitionTrackItem\b[\s\S]*?<Start>(?<start>\d+)</Start>[\s\S]*?<End>(?<end>\d+)</End>[\s\S]*?<DisplayName>(?<name>[\s\S]*?)</DisplayName>[\s\S]*?<MatchName>(?<match>[\s\S]*?)</MatchName>[\s\S]*?<HasOutgoingClip>(?<out>true|false)</HasOutgoingClip>[\s\S]*?<HasIncomingClip>(?<in>true|false)</HasIncomingClip>[\s\S]*?</\k<media>TransitionTrackItem>", RegexOptions.IgnoreCase);
            const double ticksPerSecond = 254016000000.0;
            var transitions = matches.Cast<Match>().Select(match => new
            {
                displayName = System.Net.WebUtility.HtmlDecode(match.Groups["name"].Value),
                matchName = System.Net.WebUtility.HtmlDecode(match.Groups["match"].Value),
                type = match.Groups["media"].Value.ToLowerInvariant(),
                hasOutgoingClip = string.Equals(match.Groups["out"].Value, "true", StringComparison.OrdinalIgnoreCase),
                hasIncomingClip = string.Equals(match.Groups["in"].Value, "true", StringComparison.OrdinalIgnoreCase),
                startSeconds = double.Parse(match.Groups["start"].Value) / ticksPerSecond,
                endSeconds = double.Parse(match.Groups["end"].Value) / ticksPerSecond,
                durationSeconds = Math.Max(0, (double.Parse(match.Groups["end"].Value) - double.Parse(match.Groups["start"].Value)) / ticksPerSecond)
            }).ToArray();
            await SendToPanelAsync(socket, new { type = "projectTransitionMetadataResult", requestId, ok = true, transitions });
        }
        catch (Exception error)
        {
            await SendToPanelAsync(socket, new { type = "projectTransitionMetadataResult", requestId, ok = false, error = error.Message });
        }
    }

    private async Task ExportLibraryZipAsync(WebSocket socket, JsonElement root)
    {
        var requestId = root.TryGetProperty("requestId", out var reqId) ? reqId.GetString() ?? "" : "";
        var outputPath = root.TryGetProperty("outputPath", out var outP) ? NormalizeNativePath(outP.GetString() ?? "") : "";
        var libraryData = root.TryGetProperty("libraryData", out var libD) ? libD.GetRawText() : "";
        var mediaPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var missingPaths = new List<string>();

        if (root.TryGetProperty("mediaPaths", out var mediaArr) && mediaArr.ValueKind == JsonValueKind.Array)
        {
            foreach (var el in mediaArr.EnumerateArray())
            {
                var p = NormalizeNativePath(el.GetString() ?? "");
                if (!string.IsNullOrWhiteSpace(p) && File.Exists(p))
                {
                    mediaPaths.Add(p);
                }
                else if (!string.IsNullOrWhiteSpace(p))
                {
                    missingPaths.Add(p);
                }
            }
        }

        // Premiere can return an empty mediaPath for timeline clips (notably
        // on macOS and for some imported/still/audio project items). The
        // private snapshot still contains the real absolute paths, so recover
        // the media used by the saved clips before creating the package.
        var desiredMediaNames = CollectSavedClipFileNames(libraryData);
        foreach (var discoveredPath in DiscoverSnapshotMediaPaths(mediaPaths, desiredMediaNames))
        {
            mediaPaths.Add(discoveredPath);
        }

        try
        {
            if (string.IsNullOrWhiteSpace(outputPath)) throw new ArgumentException("Output path is required.");
            if (missingPaths.Count > 0)
            {
                throw new FileNotFoundException(
                    $"Cannot create a portable package because {missingPaths.Count} referenced file(s) are missing. First missing file: {missingPaths[0]}"
                );
            }
            if (File.Exists(outputPath)) File.Delete(outputPath);

            var tempDir = Path.Combine(Path.GetTempPath(), $"PremiereBind_Export_{Guid.NewGuid():N}");
            Directory.CreateDirectory(tempDir);
            var mediaDir = Path.Combine(tempDir, "media");
            Directory.CreateDirectory(mediaDir);

            await SendToPanelAsync(socket, new
            {
                type = "exportProgress",
                requestId,
                percent = 8,
                label = "Preparing package…",
                detail = $"{mediaPaths.Count} file{(mediaPaths.Count == 1 ? "" : "s")} to package"
            });

            await File.WriteAllTextAsync(Path.Combine(tempDir, "library.json"), libraryData, Encoding.UTF8);

            var mediaManifest = new Dictionary<string, string>();
            var copiedCount = 0;
            foreach (var origMedia in mediaPaths)
            {
                var fileName = Path.GetFileName(origMedia);
                var destMedia = Path.Combine(mediaDir, fileName);
                var counter = 1;
                while (File.Exists(destMedia))
                {
                    destMedia = Path.Combine(mediaDir, $"{Path.GetFileNameWithoutExtension(fileName)}_{counter++}{Path.GetExtension(fileName)}");
                }
                File.Copy(origMedia, destMedia, true);
                mediaManifest[origMedia] = $"media/{Path.GetFileName(destMedia)}";
                copiedCount++;
                var copyPercent = mediaPaths.Count == 0
                    ? 76
                    : 10 + (int)Math.Round((double)copiedCount / mediaPaths.Count * 66);
                await SendToPanelAsync(socket, new
                {
                    type = "exportProgress",
                    requestId,
                    percent = copyPercent,
                    label = "Copying library files…",
                    detail = $"{copiedCount} / {mediaPaths.Count}  ·  {Path.GetFileName(origMedia)}"
                });
            }

            await File.WriteAllTextAsync(Path.Combine(tempDir, "media-manifest.json"), JsonSerializer.Serialize(mediaManifest), Encoding.UTF8);

            await SendToPanelAsync(socket, new
            {
                type = "exportProgress",
                requestId,
                percent = 82,
                label = "Compressing package…",
                detail = "Keep Premiere Pro open until export completes"
            });

            ZipFile.CreateFromDirectory(tempDir, outputPath, CompressionLevel.Optimal, false);
            Directory.Delete(tempDir, true);

            await SendToPanelAsync(socket, new
            {
                type = "exportResult",
                requestId,
                ok = true,
                outputPath,
                mediaCount = mediaPaths.Count,
                missingCount = 0
            });
        }
        catch (Exception ex)
        {
            await SendToPanelAsync(socket, new { type = "exportResult", requestId, ok = false, error = ex.Message });
        }
    }

    private async Task ImportLibraryZipAsync(WebSocket socket, JsonElement root)
    {
        var requestId = root.TryGetProperty("requestId", out var reqId) ? reqId.GetString() ?? "" : "";
        var inputPath = root.TryGetProperty("inputPath", out var inP) ? NormalizeNativePath(inP.GetString() ?? "") : "";

        try
        {
            await ImportAndSendToPanelAsync(socket, inputPath, requestId);
        }
        catch (Exception ex)
        {
            await SendToPanelAsync(socket, new { type = "importResult", requestId, ok = false, error = ex.Message });
        }
    }

    private async Task ImportAndSendToPanelAsync(WebSocket socket, string filePath, string requestId = "")
    {
        filePath = NormalizeNativePath(filePath);
        if (!File.Exists(filePath)) throw new FileNotFoundException("Package file not found.", filePath);

        if (filePath.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
        {
            var jsonContent = await File.ReadAllTextAsync(filePath, Encoding.UTF8);
            using var doc = JsonDocument.Parse(jsonContent);
            await SendToPanelAsync(socket, new { type = "import_library", data = doc.RootElement, requestId, ok = true });
            return;
        }

        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        // Every import receives its own immutable media directory. Reusing the
        // package name can collide with clips that Premiere still has open.
        var packageName = Path.GetFileNameWithoutExtension(filePath);
        var extractDir = Path.Combine(appData, "PremiereBind", "imported_media", $"{packageName}-{Guid.NewGuid():N}");
        Directory.CreateDirectory(extractDir);
        var extractRoot = Path.GetFullPath(extractDir).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;

        using (var archive = ZipFile.OpenRead(filePath))
        {
            foreach (var entry in archive.Entries)
            {
                var destinationPath = Path.GetFullPath(Path.Combine(extractDir, entry.FullName));
                if (!destinationPath.StartsWith(extractRoot, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Invalid .prbind package: an entry points outside the package.");
                if (entry.FullName.EndsWith("/") || entry.FullName.EndsWith("\\"))
                {
                    Directory.CreateDirectory(destinationPath);
                    continue;
                }
                Directory.CreateDirectory(Path.GetDirectoryName(destinationPath)!);
                entry.ExtractToFile(destinationPath, true);
            }
        }

        var libraryJsonPath = Path.Combine(extractDir, "library.json");
        if (!File.Exists(libraryJsonPath)) throw new InvalidDataException("Invalid .prbind package: missing library.json.");

        var rawLibrary = await File.ReadAllTextAsync(libraryJsonPath, Encoding.UTF8);
        var mediaManifestPath = Path.Combine(extractDir, "media-manifest.json");

        if (File.Exists(mediaManifestPath))
        {
            var manifestJson = await File.ReadAllTextAsync(mediaManifestPath, Encoding.UTF8);
            var manifest = JsonSerializer.Deserialize<Dictionary<string, string>>(manifestJson);
            if (manifest != null)
            {
                RewriteExtractedProjectSnapshots(extractDir, manifest);
                var replacements = manifest.ToDictionary(
                    pair => pair.Key,
                    pair => Path.GetFullPath(Path.Combine(extractDir, pair.Value)),
                    StringComparer.OrdinalIgnoreCase
                );
                var libraryNode = JsonNode.Parse(rawLibrary)
                    ?? throw new InvalidDataException("Invalid .prbind package: library data is empty.");
                rawLibrary = RewriteJsonPaths(libraryNode, replacements).ToJsonString();
            }
        }

        using var importedDoc = JsonDocument.Parse(rawLibrary);
        await SendToPanelAsync(socket, new { type = "import_library", data = importedDoc.RootElement, requestId, ok = true });
    }

    private static void RewriteExtractedProjectSnapshots(string extractDir, Dictionary<string, string> manifest)
    {
        var replacements = manifest
            .Where(pair => !pair.Key.EndsWith(".prproj", StringComparison.OrdinalIgnoreCase))
            .Select(pair => (
                Original: NormalizeNativePath(pair.Key),
                Local: Path.GetFullPath(Path.Combine(extractDir, pair.Value))
            ))
            .Where(pair => !string.IsNullOrWhiteSpace(pair.Original) && File.Exists(pair.Local))
            .ToList();

        foreach (var (_, relativeProjectPath) in manifest.Where(pair => pair.Key.EndsWith(".prproj", StringComparison.OrdinalIgnoreCase)))
        {
            var projectPath = Path.GetFullPath(Path.Combine(extractDir, relativeProjectPath));
            if (!File.Exists(projectPath)) continue;

            try
            {
                var bytes = File.ReadAllBytes(projectPath);
                var isGzip = bytes.Length >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b;
                string projectText;

                if (isGzip)
                {
                    using var input = new MemoryStream(bytes);
                    using var gzip = new GZipStream(input, CompressionMode.Decompress);
                    using var reader = new StreamReader(gzip, Encoding.UTF8, true);
                    projectText = reader.ReadToEnd();
                }
                else
                {
                    projectText = Encoding.UTF8.GetString(bytes);
                }

                foreach (var (original, local) in replacements)
                {
                    projectText = ReplaceProjectPathVariants(projectText, original, local);
                }

                if (isGzip)
                {
                    using var output = new MemoryStream();
                    using (var gzip = new GZipStream(output, CompressionLevel.Optimal, true))
                    using (var writer = new StreamWriter(gzip, new UTF8Encoding(false)))
                    {
                        writer.Write(projectText);
                    }
                    File.WriteAllBytes(projectPath, output.ToArray());
                }
                else
                {
                    File.WriteAllText(projectPath, projectText, new UTF8Encoding(false));
                }
            }
            catch (Exception error)
            {
                throw new InvalidDataException($"Could not make the imported Premiere project snapshot portable: {error.Message}", error);
            }
        }
    }

    private static HashSet<string> CollectSavedClipFileNames(string libraryData)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            using var document = JsonDocument.Parse(libraryData);
            CollectClipNames(document.RootElement, names, false);
        }
        catch
        {
        }
        return names;
    }

    private static void CollectClipNames(JsonElement element, HashSet<string> names, bool insideClip)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var isClip = insideClip;
            if (element.TryGetProperty("id", out var idValue)
                && idValue.ValueKind == JsonValueKind.String
                && (idValue.GetString() ?? "").StartsWith("clip-", StringComparison.OrdinalIgnoreCase))
            {
                isClip = true;
            }

            foreach (var property in element.EnumerateObject())
            {
                if (isClip
                    && (property.NameEquals("title") || property.NameEquals("name"))
                    && property.Value.ValueKind == JsonValueKind.String)
                {
                    var value = property.Value.GetString();
                    if (!string.IsNullOrWhiteSpace(value) && Path.HasExtension(value)) names.Add(Path.GetFileName(value));
                }
                CollectClipNames(property.Value, names, isClip);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (var child in element.EnumerateArray()) CollectClipNames(child, names, insideClip);
        }
    }

    private static IEnumerable<string> DiscoverSnapshotMediaPaths(
        IEnumerable<string> requestedPaths,
        HashSet<string> desiredMediaNames)
    {
        if (desiredMediaNames.Count == 0) yield break;
        var discovered = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var projectPath in requestedPaths.Where(path => path.EndsWith(".prproj", StringComparison.OrdinalIgnoreCase)).ToList())
        {
            if (!File.Exists(projectPath)) continue;
            string projectText;
            try
            {
                var bytes = File.ReadAllBytes(projectPath);
                if (bytes.Length >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b)
                {
                    using var input = new MemoryStream(bytes);
                    using var gzip = new GZipStream(input, CompressionMode.Decompress);
                    using var reader = new StreamReader(gzip, Encoding.UTF8, true);
                    projectText = reader.ReadToEnd();
                }
                else
                {
                    projectText = Encoding.UTF8.GetString(bytes);
                }
            }
            catch
            {
                continue;
            }

            var matches = Regex.Matches(
                projectText,
                @"(?i)(?:file:///)?[A-Z]:[\\/][^<\""\r\n]+",
                RegexOptions.CultureInvariant
            );
            foreach (Match match in matches)
            {
                var candidate = WebUtility.HtmlDecode(match.Value).Trim();
                candidate = NormalizeNativePath(candidate);
                if (!File.Exists(candidate)) continue;
                if (!desiredMediaNames.Contains(Path.GetFileName(candidate))) continue;
                if (discovered.Add(candidate)) yield return candidate;
            }
        }
    }

    private static JsonNode RewriteJsonPaths(JsonNode node, Dictionary<string, string> replacements)
    {
        if (node is JsonObject jsonObject)
        {
            foreach (var key in jsonObject.Select(pair => pair.Key).ToList())
            {
                if (jsonObject[key] is not JsonNode child) continue;
                var rewritten = RewriteJsonPaths(child, replacements);
                if (!ReferenceEquals(child, rewritten)) jsonObject[key] = rewritten;
            }
            return jsonObject;
        }

        if (node is JsonArray jsonArray)
        {
            for (var index = 0; index < jsonArray.Count; index++)
            {
                if (jsonArray[index] is not JsonNode child) continue;
                var rewritten = RewriteJsonPaths(child, replacements);
                if (!ReferenceEquals(child, rewritten)) jsonArray[index] = rewritten;
            }
            return jsonArray;
        }

        if (node is JsonValue value && value.TryGetValue<string>(out var stringValue))
        {
            foreach (var (original, local) in replacements)
            {
                if (string.Equals(stringValue, original, StringComparison.OrdinalIgnoreCase)
                    || string.Equals(stringValue.Replace('\\', '/'), original.Replace('\\', '/'), StringComparison.OrdinalIgnoreCase))
                {
                    return JsonValue.Create(local)!;
                }
            }
        }

        return node;
    }

    private static string ReplaceProjectPathVariants(string content, string originalPath, string localPath)
    {
        var originalSlash = originalPath.Replace('\\', '/');
        var localSlash = localPath.Replace('\\', '/');
        var variants = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            [originalPath] = localPath,
            [originalSlash] = localSlash
        };

        try
        {
            variants[new Uri(originalPath).AbsoluteUri] = new Uri(localPath).AbsoluteUri;
        }
        catch
        {
        }

        foreach (var (oldValue, newValue) in variants)
        {
            content = content.Replace(oldValue, newValue, StringComparison.OrdinalIgnoreCase);
        }
        return content;
    }

    private static string NormalizeNativePath(string path)
    {
        if (Uri.TryCreate(path, UriKind.Absolute, out var uri) && uri.IsFile)
        {
            return uri.LocalPath;
        }
        return Uri.UnescapeDataString(path ?? string.Empty);
    }

    private IntPtr KeyboardHookCallback(int code, IntPtr wParam, IntPtr lParam)
    {
        // Synthetic focus/copy/paste events must never trigger or be swallowed by plugin shortcuts.
        // KBDLLHOOKSTRUCT.flags is at byte offset 8; LLKHF_INJECTED = 0x10.
        if (code >= 0 && (Marshal.ReadInt32(lParam, 8) & 0x10) != 0)
            return CallNextHookEx(_hookHandle, code, wParam, lParam);
        var suppress = false;
        if (code >= 0)
        {
            var virtualKey = Marshal.ReadInt32(lParam);
            var key = KeyFromVirtualKey(virtualKey);
            var message = wParam.ToInt32();
            var isDown = message is WmKeyDown or WmSysKeyDown;
            var isUp = message is WmKeyUp or WmSysKeyUp;

            if (!string.IsNullOrEmpty(key))
            {
                string? matchedPresetId = null;
                bool? isInsertAlignmentKeyDown = null;
                lock (_stateLock)
                {
                    if (isUp)
                    {
                        suppress = _suppressedKeys.Remove(key);
                        if (_heldKeys.Remove(key) && IsInsertAlignmentKey(key))
                        {
                            isInsertAlignmentKeyDown = false;
                        }
                    }
                    else if (isDown && _heldKeys.Add(key))
                    {
                        if (IsInsertAlignmentKey(key))
                        {
                            isInsertAlignmentKeyDown = true;
                        }

                        if (!ModifierOrder.Contains(key))
                        {
                            _shortcutMap.TryGetValue(BuildHeldCombo(), out matchedPresetId);
                            if (!string.IsNullOrEmpty(matchedPresetId))
                            {
                                _suppressedKeys.Add(key);
                                suppress = true;
                            }
                        }
                    }
                    else if (isDown && _suppressedKeys.Contains(key))
                    {
                        suppress = true;
                    }
                }

                if (isInsertAlignmentKeyDown.HasValue)
                {
                    _ = SendInsertAlignmentKeyStateAsync(key, isInsertAlignmentKeyDown.Value);
                }

                if (!string.IsNullOrEmpty(matchedPresetId))
                {
                    var combo = BuildComboForNotification();
                    _ = SendShortcutAsync(matchedPresetId, combo);
                }
            }
        }

        return suppress ? new IntPtr(1) : CallNextHookEx(_hookHandle, code, wParam, lParam);
    }

    private string BuildHeldCombo()
    {
        var modifiers = ModifierOrder.Where(_heldKeys.Contains);
        var mainKeys = _heldKeys.Where(key => !ModifierOrder.Contains(key)).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        return mainKeys.Length == 1 ? string.Join('+', modifiers.Append(mainKeys[0])) : string.Empty;
    }

    private string BuildComboForNotification()
    {
        lock (_stateLock) return BuildHeldCombo();
    }

    private async Task SendShortcutAsync(string presetId, string combo)
    {
        WebSocket? socket;
        lock (_stateLock) socket = _panelSocket;
        if (socket is null) return;
        await SendToPanelAsync(socket, new { type = "shortcut", presetId, combo });
    }

    private static bool IsInsertAlignmentKey(string key)
    {
        return key.Equals("S", StringComparison.OrdinalIgnoreCase)
            || key.Equals("A", StringComparison.OrdinalIgnoreCase)
            || key.Equals("E", StringComparison.OrdinalIgnoreCase);
    }

    private async Task SendInsertAlignmentKeyStateAsync(string key, bool isDown)
    {
        WebSocket? socket;
        lock (_stateLock) socket = _panelSocket;
        if (socket is null) return;
        await SendToPanelAsync(socket, new { type = "insertAlignmentKeyState", key, isDown });
    }

    private async Task SendToPanelAsync(WebSocket socket, object payload)
    {
        if (socket.State != WebSocketState.Open) return;
        var data = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload));
        await _sendLock.WaitAsync();
        try
        {
            if (socket.State == WebSocketState.Open)
            {
                await socket.SendAsync(data, WebSocketMessageType.Text, true, _cancellation.Token);
            }
        }
        catch
        {
        }
        finally
        {
            _sendLock.Release();
        }
    }

    private void OnIdleTimer(object? state)
    {
        lock (_stateLock)
        {
            if (_panelSocket is not null || DateTime.UtcNow - _lastPanelDisconnectUtc < TimeSpan.FromMinutes(1)) return;
        }
        Program.PostThreadMessage(_mainThreadId, 0x0012, UIntPtr.Zero, IntPtr.Zero);
    }

    private static string NormalizeCombo(string? shortcut)
    {
        if (string.IsNullOrWhiteSpace(shortcut)) return string.Empty;
        var keys = shortcut.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(NormalizeKey)
            .Where(key => !string.IsNullOrEmpty(key))
            .ToArray();
        var modifiers = ModifierOrder.Where(keys.Contains);
        var mainKeys = keys.Where(key => !ModifierOrder.Contains(key)).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        return mainKeys.Length == 1 ? string.Join('+', modifiers.Append(mainKeys[0])) : string.Empty;
    }

    private static string NormalizeKey(string key)
    {
        var normalized = key.Trim().ToUpperInvariant();
        return KeyAliases.TryGetValue(normalized, out var alias) ? alias : normalized;
    }

    private static string KeyFromVirtualKey(int key)
    {
        if (key is >= 0x30 and <= 0x39 || key is >= 0x41 and <= 0x5A || key is >= 0x70 and <= 0x87)
        {
            return key >= 0x70 ? $"F{key - 0x6F}" : ((char)key).ToString();
        }

        return key switch
        {
            0x10 or 0xA0 or 0xA1 => "SHIFT",
            0x11 or 0xA2 or 0xA3 => "CTRL",
            0x12 or 0xA4 or 0xA5 => "ALT",
            0x5B or 0x5C => "META",
            0x20 => "SPACE",
            0x0D => "ENTER",
            0x1B => "ESC",
            0x08 => "BACKSPACE",
            0x09 => "TAB",
            0x2E => "DELETE",
            0x2D => "INSERT",
            0x24 => "HOME",
            0x23 => "END",
            0x21 => "PAGEUP",
            0x22 => "PAGEDOWN",
            0x25 => "ARROWLEFT",
            0x26 => "ARROWUP",
            0x27 => "ARROWRIGHT",
            0x28 => "ARROWDOWN",
            _ => string.Empty
        };
    }

    public void Dispose()
    {
        _cancellation.Cancel();
        _idleTimer.Dispose();
        if (_hookHandle != IntPtr.Zero) UnhookWindowsHookEx(_hookHandle);
        _listener.Close();
        _panelSocket?.Dispose();
        _sendLock.Dispose();
        _cancellation.Dispose();
    }

    private delegate IntPtr LowLevelKeyboardProc(int code, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int hookId, LowLevelKeyboardProc callback, IntPtr moduleHandle, uint threadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hookHandle);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hookHandle, int code, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);
    private static bool IsPremiereForeground(int processId)
    {
        GetWindowThreadProcessId(GetForegroundWindow(), out var foregroundId);
        return foregroundId == (uint)processId;
    }
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern uint GetClipboardSequenceNumber();

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string? moduleName);
}



