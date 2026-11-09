using System.Diagnostics;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace ShouURun.Desktop;

internal static class AppUpdate
{
    private const string Root = "https://github.com/x-zyz/SHOU-U-RUN/releases/download/";
    private static readonly HttpClient Client = new();

    public static async Task InstallAsync(string tag, string hash, CancellationToken cancellation)
    {
        if (!Regex.IsMatch(tag, @"\Av[0-9]{1,8}\.[0-9]{1,8}\.[0-9]{1,8}\z") ||
            !Regex.IsMatch(hash, @"\A[0-9a-f]{64}\z"))
            throw new ArgumentException("Invalid update metadata");

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(TimeSpan.FromMinutes(5));
        var token = timeout.Token;
        string name = $"SHOU-U-RUN-{tag}-Windows-x64-Setup.exe";
        string folder = Directory.CreateTempSubdirectory("shou-u-run-").FullName;
        string installer = Path.Combine(folder, name);
        try
        {
            using var response = await Client.GetAsync(Root + tag + "/" + name, HttpCompletionOption.ResponseHeadersRead, token);
            response.EnsureSuccessStatusCode();
            await using (var file = File.Create(installer))
            {
                await response.Content.CopyToAsync(file, token);
                file.Position = 0;
                var digest = await SHA256.HashDataAsync(file, token);
                if (!Convert.ToHexString(digest).Equals(hash, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Update checksum mismatch");
            }
            token.ThrowIfCancellationRequested();
            using var process = Process.Start(new ProcessStartInfo(installer) { UseShellExecute = true });
        }
        catch
        {
            File.Delete(installer);
            Directory.Delete(folder);
            throw;
        }
    }
}
