using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace ShouURun.Desktop;

public sealed partial class MainWindow
{
    private static readonly TimeSpan MembershipDuration = TimeSpan.FromMinutes(5);
    private readonly DispatcherTimer membershipTimer = new() { Interval = TimeSpan.FromSeconds(10) };
    private AppHubAccount.Session? memberSession;
    private CancellationTokenSource? browserSignIn;
    private CancellationTokenSource? workbenchLifetime;
    private DateTime authorizedUntil;
    private bool membershipBusy;
    private bool promptForAccount;

    private bool HasMemberAccess => !closed && workbenchLifetime is not null && DateTime.UtcNow < authorizedUntil;

    private async void StartMembershipGate(object sender, RoutedEventArgs args)
    {
        Startup.Loaded -= StartMembershipGate;
        membershipTimer.Tick += OnMembershipTick;
        membershipTimer.Start();
        Activated += (_, activation) =>
        {
            if (activation.WindowActivationState != WindowActivationState.Deactivated)
                OnMembershipTick(this, EventArgs.Empty);
        };
        await VerifyMembershipAsync();
    }

    private async void OnMembershipTick(object? sender, object args)
    {
        if (closed || workbenchLifetime is null) return;
        if (!HasMemberAccess)
        {
            CloseWorkbench();
            ShowGate("正在验证会员资格", "正在向 App Hub 确认应用权限…", busy: true);
        }
        if (DateTime.UtcNow.AddSeconds(20) >= authorizedUntil)
            await VerifyMembershipAsync();
    }

    private async void OnRetryMembership(object sender, RoutedEventArgs args) => await VerifyMembershipAsync();

    private async void OnSignIn(object sender, RoutedEventArgs args) => await SignInForMembershipAsync(false);

    private async void OnSwitchAccount(object sender, RoutedEventArgs args) => await SignInForMembershipAsync(true);

    private void OnCancelSignIn(object sender, RoutedEventArgs args) => browserSignIn?.Cancel();

    private async Task SignInForMembershipAsync(bool switchAccount)
    {
        if (closed || membershipBusy) return;
        membershipBusy = true;
        bool signedIn = false;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        timeout.CancelAfter(TimeSpan.FromMinutes(5));
        browserSignIn = timeout;
        try
        {
            CloseWorkbench();
            if (switchAccount)
            {
                memberSession = null;
                ShowGate("正在更换账号", "正在清除当前应用的登录会话…", busy: true);
                await AppHubAccount.SignOutAsync(timeout.Token);
            }
            ShowGate("请在浏览器完成登录", "登录完成后，应用会自动验证会员资格并继续。", busy: true, cancel: true);
            memberSession = await AppHubAccount.SignInAsync(switchAccount || promptForAccount, timeout.Token);
            promptForAccount = false;
            signedIn = true;
        }
        catch (OperationCanceledException)
        {
            ShowGate("登录已结束", "请重新发起 App Hub 登录。", signIn: true);
        }
        catch (Exception)
        {
            ShowGate("无法完成 App Hub 登录", "请检查网络连接后重试。", signIn: true);
        }
        finally
        {
            browserSignIn = null;
            membershipBusy = false;
        }
        if (signedIn) await VerifyMembershipAsync();
    }

    private async Task VerifyMembershipAsync()
    {
        if (closed || membershipBusy) return;
        membershipBusy = true;
        if (!HasMemberAccess) ShowGate("正在验证会员资格", "正在向 App Hub 确认应用权限…", busy: true);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        timeout.CancelAfter(TimeSpan.FromSeconds(25));
        try
        {
            var token = timeout.Token;
            bool refreshed = false;
            if (memberSession is null || memberSession.ExpiresAt <= DateTime.UtcNow.AddSeconds(30) ||
                !await AppHubAccount.HasStoredAccountAsync(memberSession.Subject, token))
            {
                memberSession = await AppHubAccount.RefreshAsync(token);
                refreshed = true;
            }
            if (memberSession is null)
            {
                CloseWorkbench();
                ShowGate("App Hub 会员验证", "请登录 App Hub。只有已验证的会员可以使用 SHOU U RUN。", signIn: true);
                return;
            }

            var membership = await AppHubAccount.CheckMembershipAsync(memberSession, token);
            if (membership.Status == AppHubAccount.Membership.Expired && !refreshed)
            {
                memberSession = await AppHubAccount.RefreshAsync(token);
                if (memberSession is not null)
                    membership = await AppHubAccount.CheckMembershipAsync(memberSession, token);
            }
            token.ThrowIfCancellationRequested();
            if (membership.Status == AppHubAccount.Membership.Active && memberSession is not null &&
                memberSession.ExpiresAt > DateTime.UtcNow)
            {
                var nextCheck = DateTime.UtcNow + MembershipDuration;
                if (membership.ExpiresAt is DateTime membershipEnd && membershipEnd < nextCheck) nextCheck = membershipEnd;
                authorizedUntil = memberSession.ExpiresAt < nextCheck ? memberSession.ExpiresAt : nextCheck;
                if (Browser is null)
                {
                    workbenchLifetime = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                    ShowGate("正在打开路线工作台", "会员资格已验证。", busy: true);
                    await OpenWorkbenchAsync();
                }
                return;
            }

            CloseWorkbench();
            switch (membership.Status)
            {
                case AppHubAccount.Membership.Denied:
                    ShowGate("该账号没有会员权限", "请使用已验证的 App Hub 会员账号。获得权限后，您可重新验证。", retry: true, changeAccount: true);
                    break;
                case AppHubAccount.Membership.Expired:
                case AppHubAccount.Membership.Active:
                    memberSession = null;
                    promptForAccount = true;
                    ShowGate("App Hub 登录已失效", "请重新登录以验证会员资格。", signIn: true);
                    break;
                default:
                    ShowMembershipUnavailable();
                    break;
            }
        }
        catch (Exception)
        {
            if (!closed)
            {
                CloseWorkbench();
                ShowMembershipUnavailable();
            }
        }
        finally { membershipBusy = false; }
    }

    private void ShowMembershipUnavailable() =>
        ShowGate("暂时无法验证会员资格", "请检查网络连接后重试。", retry: true, changeAccount: true);

    private void ShowGate(string title, string message, bool busy = false, bool signIn = false,
        bool retry = false, bool changeAccount = false, bool cancel = false)
    {
        if (closed) return;
        Startup.Visibility = Visibility.Visible;
        StartupTitle.Text = title;
        StartupMessage.Text = message;
        Loading.IsActive = busy;
        Loading.Visibility = busy ? Visibility.Visible : Visibility.Collapsed;
        SignInButton.Visibility = signIn ? Visibility.Visible : Visibility.Collapsed;
        RetryButton.Visibility = retry ? Visibility.Visible : Visibility.Collapsed;
        SwitchButton.Visibility = changeAccount ? Visibility.Visible : Visibility.Collapsed;
        CancelButton.Visibility = cancel ? Visibility.Visible : Visibility.Collapsed;
    }

    private async void OnAppHubAccount(object sender, RoutedEventArgs args)
    {
        if (!HasMemberAccess || membershipBusy || memberSession is null) return;
        AccountButton.IsEnabled = false;
        bool ownsMembership = false;
        try
        {
            var dialog = new ContentDialog
            {
                XamlRoot = AccountShell.XamlRoot,
                Title = "App Hub 账号",
                Content = memberSession.Name,
                PrimaryButtonText = "退出此应用",
                CloseButtonText = "关闭",
            };
            if (await dialog.ShowAsync() != ContentDialogResult.Primary || closed || membershipBusy) return;
            membershipBusy = true;
            ownsMembership = true;
            CloseWorkbench();
            memberSession = null;
            promptForAccount = true;
            ShowGate("正在退出登录", "正在清除本机的 App Hub 登录会话…", busy: true);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
            timeout.CancelAfter(TimeSpan.FromSeconds(15));
            await AppHubAccount.SignOutAsync(timeout.Token);
            ShowGate("已退出 App Hub", "请登录并验证会员资格后继续使用。", signIn: true);
        }
        catch (Exception)
        {
            if (!HasMemberAccess)
                ShowGate("账号操作未完成", "请重试 App Hub 登录。", signIn: true);
        }
        finally
        {
            AccountButton.IsEnabled = true;
            if (ownsMembership) membershipBusy = false;
        }
    }
}
