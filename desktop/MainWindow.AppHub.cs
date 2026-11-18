using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace ShouURun.Desktop;

public sealed partial class MainWindow
{
    private async void OnAppHubAccount(object sender, RoutedEventArgs args)
    {
        if (sender is not Button button) return;
        button.IsEnabled = false;
        try
        {
            var profile = await AppHubAccount.ReadAsync();
            var dialog = new ContentDialog
            {
                XamlRoot = AccountShell.XamlRoot,
                Title = "App Hub 账号",
                Content = profile is null ? "使用系统浏览器登录。本机跑步记录可离线使用。" :
                    $"{profile.Name}\n{profile.Email}",
                PrimaryButtonText = profile is null ? "在浏览器登录" : "退出此应用",
                CloseButtonText = "关闭",
            };
            if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
            if (profile is null)
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(5));
                button.Content = "等待浏览器登录…";
                var signedIn = await AppHubAccount.SignInAsync(timeout.Token);
                await ShowAppHubMessageAsync("已登录", signedIn.Name);
            }
            else
            {
                bool revoked = await AppHubAccount.SignOutAsync(profile);
                await ShowAppHubMessageAsync("已退出",
                    revoked ? "已退出此应用。" : "已清除本机登录。暂未能撤销服务器会话。");
            }
        }
        catch (Exception)
        {
            await ShowAppHubMessageAsync("账号操作未完成", "请检查网络或重新发起登录。");
        }
        finally
        {
            button.Content = "App Hub 账号";
            button.IsEnabled = true;
        }
    }

    private async Task ShowAppHubMessageAsync(string title, string message)
    {
        var dialog = new ContentDialog
        {
            XamlRoot = AccountShell.XamlRoot,
            Title = title,
            Content = message,
            CloseButtonText = "关闭",
        };
        await dialog.ShowAsync();
    }
}
