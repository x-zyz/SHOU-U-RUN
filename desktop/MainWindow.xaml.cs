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
    private WebView2? Browser;
    private bool ready;
    private bool saving;
    private bool fitting;
    private bool keepBusy;
    private bool updateBusy;
    private bool closed;

    public MainWindow()
    {
        InitializeComponent();
        AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "app.ico"));
        BrandLogo.Source = new Microsoft.UI.Xaml.Media.Imaging.BitmapImage(
            new Uri(Path.Combine(AppContext.BaseDirectory, "Assets", "icon.png")));
        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
        var scale = GetDpiForWindow(hwnd) / 96.0;
        var workArea = Microsoft.UI.Windowing.DisplayArea.GetFromWindowId(
            AppWindow.Id, Microsoft.UI.Windowing.DisplayAreaFallback.Nearest).WorkArea;
        AppWindow.Resize(new SizeInt32(
            Math.Min((int)Math.Round(1180 * scale), workArea.Width),
            Math.Min((int)Math.Round(860 * scale), workArea.Height)));
        Startup.Loaded += StartMembershipGate;
        Closed += (_, _) =>
        {
            closed = true;
            membershipTimer.Stop();
            lifetime.Cancel();
            CloseWorkbench();
            keep.Dispose();
        };
    }

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);

    private async Task OpenWorkbenchAsync()
    {
        var browser = new WebView2();
        Browser = browser;
        WorkbenchHost.Children.Add(browser);
        try
        {
            string profile = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ShouURun", "WebView2");
            var environment = await CoreWebView2Environment.CreateWithOptionsAsync(null, profile, null);
            if (!HasMemberAccess || Browser != browser) return;
            await browser.EnsureCoreWebView2Async(environment);
            if (!HasMemberAccess || Browser != browser) return;
            var core = browser.CoreWebView2;
            var version = typeof(MainWindow).Assembly.GetName().Version?.ToString(3);
            core.Settings.UserAgent += $" SHOU-U-RUN/{version} (+https://github.com/x-zyz/SHOU-U-RUN)";
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.SetVirtualHostNameToFolderMapping(
                LocalHost, Path.Combine(AppContext.BaseDirectory, "Assets"), CoreWebView2HostResourceAccessKind.Deny);
            core.NavigationStarting += (_, e) => e.Cancel = !HasMemberAccess || Browser != browser ||
                !string.Equals(e.Uri, Workbench, StringComparison.Ordinal);
            core.FrameNavigationStarting += (_, e) => e.Cancel = true;
            core.NewWindowRequested += (_, e) => e.Handled = true;
            core.WebMessageReceived += (_, e) =>
            {
                if (Browser == browser) ReceiveMessage(e);
            };
            core.WebResourceResponseReceived += (_, e) =>
            {
                if (Browser != browser || e.Response.StatusCode < 400 ||
                    !Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out var uri)) return;
                if (uri.Host is "tile.openstreetmap.org" or "server.arcgisonline.com")
                    Post(new { kind = "mapError", error = new { url = e.Request.Uri, kind = "http", code = e.Response.StatusCode } });
            };
            core.NavigationCompleted += (_, e) =>
            {
                if (!HasMemberAccess || Browser != browser) return;
                if (e.IsSuccess)
                {
                    ready = true;
                    SelectWorkspace("route");
                    WorkbenchHost.Visibility = Visibility.Visible;
                    Startup.Visibility = Visibility.Collapsed;
                    NavigationButtons.Visibility = Visibility.Visible;
                    AccountButton.Visibility = Visibility.Visible;
                }
                else
                {
                    ShowStartupError("路线工作台加载失败，请重试。");
                }
            };
            var bridge = await File.ReadAllTextAsync(Path.Combine(AppContext.BaseDirectory, "desktop-bridge.js"));
            await core.AddScriptToExecuteOnDocumentCreatedAsync($"const desktopVersion = {JsonSerializer.Serialize(version)};\n{bridge}");
            if (HasMemberAccess && Browser == browser) core.Navigate(Workbench);
        }
        catch (COMException ex) when (ex.HResult == unchecked((int)0x80070002))
        {
            if (Browser == browser)
                ShowStartupError("找不到 Microsoft Edge WebView2 Runtime。安装后请重试。");
        }
        catch (Exception)
        {
            if (Browser == browser)
                ShowStartupError("无法打开路线工作台。请检查 WebView2 Runtime 和应用安装。");
        }
    }

    private void ShowStartupError(string message)
    {
        CloseWorkbench();
        ShowGate("无法打开路线工作台", message, retry: true, changeAccount: true);
    }

    private void CloseWorkbench()
    {
        ready = false;
        authorizedUntil = default;
        workbenchLifetime?.Cancel();
        workbenchLifetime?.Dispose();
        workbenchLifetime = null;
        WorkbenchHost.Visibility = Visibility.Collapsed;
        NavigationButtons.Visibility = Visibility.Collapsed;
        AccountButton.Visibility = Visibility.Collapsed;
        var browser = Browser;
        Browser = null;
        if (browser is not null)
        {
            WorkbenchHost.Children.Remove(browser);
            browser.Close();
        }
    }

    private void OnNavigate(object sender, RoutedEventArgs args)
    {
        if (sender is ToggleButton { Tag: string workspace } && ready && HasMemberAccess)
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

    private async Task InstallUpdate(string tag, string hash, CancellationToken cancellationToken)
    {
        if (updateBusy) return;
        updateBusy = true;
        try
        {
            await AppUpdate.InstallAsync(tag, hash, cancellationToken);
            Post(new { kind = "update", message = "已校验下载，请在 Windows 安装向导中继续。" });
        }
        catch (Exception)
        {
            Post(new { kind = "update", message = "下载、校验或启动安装失败，请重试。" });
        }
        finally { updateBusy = false; }
    }

    private async void ReceiveMessage(CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (!HasMemberAccess || !string.Equals(args.Source, Workbench, StringComparison.Ordinal)) return;
        var cancellationToken = workbenchLifetime!.Token;
        string json = args.WebMessageAsJson;
        if (json.Length > 25_000_000) return;
        try
        {
            using var doc = JsonDocument.Parse(json);
            var message = doc.RootElement;
            string action = ReadString(message, "action");
            if (action == "installUpdate")
            {
                await InstallUpdate(ReadString(message, "tag"), ReadString(message, "hash"), cancellationToken);
                return;
            }
            if (action == "save")
            {
                await SaveFile(ReadString(message, "name"), ReadString(message, "base64"), cancellationToken);
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
                await FitPersonalPace(cancellationToken);
                return;
            }
            if (action == "keepRun")
            {
                await ImportKeepRun(cancellationToken);
                return;
            }
            if (action == "keepScanFiles")
            {
                await ScanKeepFiles(cancellationToken);
                return;
            }
            if (action == "keepConvertFiles")
            {
                await ConvertKeepFiles(cancellationToken);
                return;
            }
            if (action == "keepHistory")
            {
                await ImportKeepHistory(cancellationToken);
                return;
            }
            if (action == "keepArtifacts")
            {
                await SaveKeepArtifacts(ReadString(message, "report"), ReadString(message, "sample"), cancellationToken);
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
                    "sms" => await keep.SendSms(ReadString(message, "phone"), cancellationToken),
                    "login" => await keep.Login(ReadString(message, "phone"), ReadString(message, "code"), cancellationToken),
                    "logout" => keep.Logout(),
                    "upload" => await keep.Upload(ReadString(message, "activity"), ReadString(message, "token"), cancellationToken),
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
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) {}
        catch (JsonException)
        {
            // Ignore malformed messages from the local page.
        }
    }

    private async Task FitPersonalPace(CancellationToken cancellationToken)
    {
        if (fitting) return;
        fitting = true;
        try
        {
            var picker = new FileOpenPicker { SuggestedStartLocation = PickerLocationId.DocumentsLibrary };
            picker.FileTypeFilter.Add(".jsonl");
            WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this));
            var files = await picker.PickMultipleFilesAsync().AsTask(cancellationToken);
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
            var runs = await Task.Run(() => RunPaceSamples.Read(paths, cancellationToken), cancellationToken);
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

    private async Task ImportKeepRun(CancellationToken cancellationToken)
    {
        if (keepBusy)
        {
            Post(new { kind = "keepRun", ok = false, message = "请先完成当前的 Keep 请求。" });
            return;
        }
        keepBusy = true;
        try
        {
            string activity = await keep.ImportLatestOutdoorRun(cancellationToken);
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

    private async Task ScanKeepFiles(CancellationToken cancellationToken)
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
            var result = await keep.ScanFileImports(progress, cancellationToken);
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

    private async Task ConvertKeepFiles(CancellationToken cancellationToken)
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
            var result = await keep.ConvertFileImports(progress, cancellationToken);
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

    private async Task ImportKeepHistory(CancellationToken cancellationToken)
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
            var activities = await keep.ImportOutdoorHistory(progress, cancellationToken);
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

    private async Task SaveKeepArtifacts(string report, string sample, CancellationToken cancellationToken)
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
            await WriteAtomic(Path.Combine(directory, "report.json"), report, cancellationToken);
            await WriteAtomic(Path.Combine(directory, "sample.sanitized.json"), sample, cancellationToken);
        }
        catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException)
        {
            // Diagnostics are optional; a failed local artifact must not affect the import result.
        }
    }

    private static async Task WriteAtomic(string path, string content, CancellationToken cancellationToken)
    {
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await File.WriteAllTextAsync(temporary, content, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            File.Move(temporary, path, overwrite: true);
        }
        finally
        {
            try { File.Delete(temporary); }
            catch (IOException) {}
            catch (UnauthorizedAccessException) {}
        }
    }

    private async Task SaveFile(string name, string base64, CancellationToken cancellationToken)
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
            var file = await picker.PickSaveFileAsync().AsTask(cancellationToken);
            if (file is null)
            {
                Post(new { kind = "save", ok = true, message = "已取消保存。" });
                return;
            }
            await File.WriteAllBytesAsync(file.Path, Convert.FromBase64String(base64), cancellationToken);
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
        if (HasMemberAccess) Browser?.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(message));
    }

    private static string ReadString(JsonElement message, string key) =>
        message.ValueKind == JsonValueKind.Object && message.TryGetProperty(key, out var value) &&
        value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";
}
