using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.Web.WebView2.Core;
using Windows.Graphics;
using Windows.Storage.Pickers;

namespace ShouURun.Desktop;

public sealed partial class MainWindow : Window
{
    private const string LocalHost = "app.runlab.local";
    private const string Workbench = "https://app.runlab.local/index.html";
    private readonly KeepClient keep = new();
    private readonly CancellationTokenSource lifetime = new();
    private bool ready;
    private bool saving;
    private bool fitting;
    private bool keepBusy;
    private bool closed;

    public MainWindow()
    {
        InitializeComponent();
        AppWindow.Resize(new SizeInt32(1180, 860));
        Startup.Loaded += OpenWorkbench;
        Closed += (_, _) =>
        {
            closed = true;
            lifetime.Cancel();
            keep.Dispose();
        };
    }

    private async void OpenWorkbench(object sender, RoutedEventArgs args)
    {
        Startup.Loaded -= OpenWorkbench;
        try
        {
            string profile = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ShouURun", "WebView2");
            var environment = await CoreWebView2Environment.CreateWithOptionsAsync(null, profile, null);
            if (closed) return;
            await Browser.EnsureCoreWebView2Async(environment);
            if (closed) return;
            var core = Browser.CoreWebView2;
            core.Settings.UserAgent += " SHOU-U-RUN/1.2.0 (+https://github.com/x-zyz/SHOU-U-RUN)";
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.SetVirtualHostNameToFolderMapping(
                LocalHost, Path.Combine(AppContext.BaseDirectory, "Assets"), CoreWebView2HostResourceAccessKind.Deny);
            core.NavigationStarting += (_, e) => e.Cancel = !string.Equals(e.Uri, Workbench, StringComparison.Ordinal);
            core.FrameNavigationStarting += (_, e) => e.Cancel = true;
            core.NewWindowRequested += (_, e) => e.Handled = true;
            core.WebMessageReceived += ReceiveMessage;
            core.WebResourceResponseReceived += (_, e) =>
            {
                if (e.Response.StatusCode < 400 || !Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out var uri)) return;
                if (uri.Host is "tile.openstreetmap.org" or "server.arcgisonline.com")
                    Post(new { kind = "mapError", error = new { url = e.Request.Uri, kind = "http", code = e.Response.StatusCode } });
            };
            core.NavigationCompleted += (_, e) =>
            {
                if (e.IsSuccess)
                {
                    ready = true;
                    Browser.Visibility = Visibility.Visible;
                    Startup.Visibility = Visibility.Collapsed;
                    NavigationButtons.IsHitTestVisible = true;
                }
                else
                {
                    ShowStartupError("路线工作台加载失败，请重启应用。");
                }
            };
            var bridge = await File.ReadAllTextAsync(Path.Combine(AppContext.BaseDirectory, "desktop-bridge.js"));
            await core.AddScriptToExecuteOnDocumentCreatedAsync(bridge);
            if (!closed) core.Navigate(Workbench);
        }
        catch (COMException ex) when (ex.HResult == unchecked((int)0x80070002))
        {
            ShowStartupError("找不到 Microsoft Edge WebView2 Runtime。安装后请重新打开 SHOU U RUN。");
        }
        catch (Exception)
        {
            ShowStartupError("无法打开路线工作台。请检查 WebView2 Runtime 是否安装，并从完整解压的文件夹启动。");
        }
    }

    private void ShowStartupError(string message)
    {
        if (closed) return;
        Loading.IsActive = false;
        Loading.Visibility = Visibility.Collapsed;
        StartupMessage.Text = message;
    }

    private void OnNavigate(object sender, RoutedEventArgs args)
    {
        if (sender is ToggleButton { Tag: string workspace } && ready)
        {
            SelectWorkspace(workspace);
            Post(new { kind = "navigate", workspace });
        }
    }

    private void SelectWorkspace(string workspace)
    {
        foreach (var button in NavigationButtons.Children.OfType<ToggleButton>())
            button.IsChecked = Equals(button.Tag, workspace);
    }

    private async void ReceiveMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (closed || !string.Equals(args.Source, Workbench, StringComparison.Ordinal)) return;
        string json = args.WebMessageAsJson;
        if (json.Length > 25_000_000) return;
        try
        {
            using var doc = JsonDocument.Parse(json);
            var message = doc.RootElement;
            string action = ReadString(message, "action");
            if (action == "save")
            {
                await SaveFile(ReadString(message, "name"), ReadString(message, "base64"));
                return;
            }
            if (action == "workspace")
            {
                string workspace = ReadString(message, "workspace");
                if (workspace is "route" or "parameters" or "real" or "output") SelectWorkspace(workspace);
                return;
            }
            if (action == "fitPace")
            {
                await FitPersonalPace();
                return;
            }
            if (action == "keepRun")
            {
                await ImportKeepRun();
                return;
            }
            if (action == "keepScanFiles")
            {
                await ScanKeepFiles();
                return;
            }
            if (action == "keepConvertFiles")
            {
                await ConvertKeepFiles();
                return;
            }
            if (action == "keepHistory")
            {
                await ImportKeepHistory();
                return;
            }
            if (action == "keepArtifacts")
            {
                await SaveKeepArtifacts(ReadString(message, "report"), ReadString(message, "sample"));
                return;
            }
            if (keepBusy || action is not ("restore" or "sms" or "login" or "manual" or "logout" or "upload")) return;

            keepBusy = true;
            try
            {
                string result = action switch
                {
                    "restore" => await keep.RestoreSession(),
                    "manual" => await keep.SaveToken(ReadString(message, "token")),
                    "sms" => await keep.SendSms(ReadString(message, "phone"), lifetime.Token),
                    "login" => await keep.Login(ReadString(message, "phone"), ReadString(message, "code"), lifetime.Token),
                    "logout" => keep.Logout(),
                    "upload" => await keep.Upload(ReadString(message, "activity"), ReadString(message, "token"), lifetime.Token),
                    _ => throw new InvalidOperationException()
                };
                Reply(action, true, result);
            }
            catch (KeepException ex)
            {
                if (action == "upload" && ex.SessionExpired && keep.AccountLabel.Length > 0)
                {
                    keep.ExpireSession();
                    Reply("expired", false, "Keep 登录已过期，请重新登录。");
                }
                Reply(action, false, ex.Message);
            }
            catch (Exception)
            {
                Reply(action, false, "无法完成 Keep 请求，请检查网络后重试。");
            }
            finally
            {
                keepBusy = false;
            }
        }
        catch (JsonException)
        {
            // Ignore malformed messages from the local page.
        }
    }

    private async Task FitPersonalPace()
    {
        if (fitting) return;
        fitting = true;
        try
        {
            var picker = new FileOpenPicker { SuggestedStartLocation = PickerLocationId.DocumentsLibrary };
            picker.FileTypeFilter.Add(".jsonl");
            WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this));
            var files = await picker.PickMultipleFilesAsync();
            if (files.Count == 0)
            {
                Post(new { kind = "pace", message = "已取消导入。" });
                return;
            }
            if (files.Count > RunPaceSamples.MaxFiles)
            {
                Post(new { kind = "pace", message = "每次最多选择 20 条 JSONL 记录。" });
                return;
            }
            var paths = files.Select(file => file.Path).ToArray();
            var runs = await Task.Run(() => RunPaceSamples.Read(paths, lifetime.Token), lifetime.Token);
            Post(new { kind = "pace", runs });
        }
        catch (Exception)
        {
            Post(new { kind = "pace", message = "无法读取跑步记录，请选择安卓版导出的 JSONL 文件。" });
        }
        finally
        {
            fitting = false;
        }
    }

    private async Task ImportKeepRun()
    {
        if (keepBusy)
        {
            Post(new { kind = "keepRun", ok = false, message = "请先完成当前的 Keep 请求。" });
            return;
        }
        keepBusy = true;
        try
        {
            string activity = await keep.ImportLatestOutdoorRun(lifetime.Token);
            Post(new { kind = "keepRun", ok = true, activity = JsonSerializer.Deserialize<JsonElement>(activity), account = keep.AccountLabel });
        }
        catch (KeepException ex)
        {
            if (ex.SessionExpired)
            {
                keep.ExpireSession();
                Post(new { kind = "auth", phase = "expired", ok = false, message = ex.Message, account = "" });
            }
            Post(new { kind = "keepRun", ok = false, message = ex.Message, account = keep.AccountLabel });
        }
        catch (Exception)
        {
            Post(new
            {
                kind = "keepRun", ok = false,
                message = "无法读取 Keep 跑步，请检查网络后重试。", account = keep.AccountLabel
            });
        }
        finally
        {
            keepBusy = false;
        }
    }

    private async Task ScanKeepFiles()
    {
        if (keepBusy)
        {
            Post(new { kind = "keepBatch", phase = "error", message = "请先完成当前的 Keep 请求。" });
            return;
        }
        keepBusy = true;
        try
        {
            var progress = new Progress<int>(count => Post(new { kind = "keepBatch", phase = "scanProgress", count }));
            var result = await keep.ScanFileImports(progress, lifetime.Token);
            Post(new { kind = "keepBatch", phase = "scanDone", scanned = result.Scanned, matched = result.Matched,
                unavailable = result.Unavailable });
        }
        catch (KeepException error)
        {
            if (error.SessionExpired) Reply("expired", false, error.Message);
            Post(new { kind = "keepBatch", phase = "error", message = error.Message });
        }
        catch (Exception)
        {
            Post(new { kind = "keepBatch", phase = "error", message = "读取 Keep 历史失败，请重试。" });
        }
        finally { keepBusy = false; }
    }

    private async Task ConvertKeepFiles()
    {
        if (keepBusy)
        {
            Post(new { kind = "keepBatch", phase = "error", message = "请先完成当前的 Keep 请求。" });
            return;
        }
        keepBusy = true;
        try
        {
            var progress = new Progress<KeepClient.FileBatchResult>(result =>
                Post(new { kind = "keepBatch", phase = "convertProgress", result }));
            var result = await keep.ConvertFileImports(progress, lifetime.Token);
            if (keep.AccountLabel.Length == 0) Reply("expired", false, "Keep 登录已失效，请重新登录。");
            Post(new { kind = "keepBatch", phase = "convertDone", result });
        }
        catch (KeepException error)
        {
            if (error.SessionExpired) Reply("expired", false, error.Message);
            Post(new { kind = "keepBatch", phase = "error", message = error.Message });
        }
        catch (Exception)
        {
            Post(new { kind = "keepBatch", phase = "error", message = "批量转换已停止，请重新扫描并核对已处理记录。" });
        }
        finally { keepBusy = false; }
    }

    private async Task ImportKeepHistory()
    {
        if (keepBusy)
        {
            Post(new { kind = "keepHistory", phase = "error", message = "请先完成当前的 Keep 请求。" });
            return;
        }
        keepBusy = true;
        try
        {
            var progress = new Progress<int>(count => Post(new { kind = "keepHistory", phase = "progress", count }));
            var activities = await keep.ImportOutdoorHistory(progress, lifetime.Token);
            Post(new { kind = "keepHistory", phase = "done", activities });
        }
        catch (KeepException error)
        {
            if (error.SessionExpired)
            {
                keep.ExpireSession();
                Reply("expired", false, error.Message);
            }
            Post(new { kind = "keepHistory", phase = "error", message = error.Message });
        }
        catch (Exception)
        {
            Post(new { kind = "keepHistory", phase = "error", message = "Keep 历史读取失败，请检查网络后重试。" });
        }
        finally { keepBusy = false; }
    }

    private async Task SaveKeepArtifacts(string report, string sample)
    {
        if (report.Length is 0 or > 8_000_000 || sample.Length is 0 or > 8_000_000) return;
        try
        {
            using var reportDocument = JsonDocument.Parse(report);
            using var sampleDocument = JsonDocument.Parse(sample);
            string directory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "ShouURun", "keep-import");
            Directory.CreateDirectory(directory);
            await WriteAtomic(Path.Combine(directory, "report.json"), report);
            await WriteAtomic(Path.Combine(directory, "sample.sanitized.json"), sample);
        }
        catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException)
        {
            // Diagnostics are optional; a failed local artifact must not affect the import result.
        }
    }

    private static async Task WriteAtomic(string path, string content)
    {
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await File.WriteAllTextAsync(temporary, content);
            File.Move(temporary, path, overwrite: true);
        }
        finally
        {
            try { File.Delete(temporary); }
            catch (IOException) {}
            catch (UnauthorizedAccessException) {}
        }
    }

    private async Task SaveFile(string name, string base64)
    {
        if (saving)
        {
            Post(new { kind = "save", ok = false, message = "请先完成当前保存。" });
            return;
        }

        saving = true;
        try
        {
            string extension = Path.GetExtension(name);
            if (extension is not (".gpx" or ".fit") || base64.Length > 24_000_000)
            {
                Post(new { kind = "save", ok = false, message = "文件类型不支持或文件过大。" });
                return;
            }
            var picker = new FileSavePicker
            {
                SuggestedFileName = Path.GetFileNameWithoutExtension(name),
                SuggestedStartLocation = PickerLocationId.DocumentsLibrary
            };
            picker.FileTypeChoices.Add(extension == ".gpx" ? "GPX 路线文件" : "FIT 运动文件", new[] { extension });
            WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this));
            var file = await picker.PickSaveFileAsync();
            if (file is null)
            {
                Post(new { kind = "save", ok = true, message = "已取消保存。" });
                return;
            }
            await File.WriteAllBytesAsync(file.Path, Convert.FromBase64String(base64), lifetime.Token);
            Post(new { kind = "save", ok = true, message = "文件已保存。" });
        }
        catch (Exception)
        {
            Post(new { kind = "save", ok = false, message = "无法保存文件，请检查目标文件夹后重试。" });
        }
        finally
        {
            saving = false;
        }
    }

    private void Reply(string phase, bool ok, string message)
    {
        if (phase == "upload") Post(new { kind = "upload", ok, message });
        else Post(new { kind = "auth", phase, ok, message, account = keep.AccountLabel });
    }

    private void Post<T>(T message)
    {
        if (!closed) Browser.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(message));
    }

    private static string ReadString(JsonElement message, string key) =>
        message.ValueKind == JsonValueKind.Object && message.TryGetProperty(key, out var value) &&
        value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";
}
