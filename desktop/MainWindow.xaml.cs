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
