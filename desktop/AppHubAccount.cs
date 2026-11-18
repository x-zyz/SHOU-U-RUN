using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Duende.IdentityModel.OidcClient;
using Duende.IdentityModel.OidcClient.Results;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using Windows.Security.Cryptography;
using Windows.Security.Cryptography.DataProtection;

namespace ShouURun.Desktop;

internal static class AppHubAccount
{
    private const string Issuer = "https://id.0979019203.top";
    private const string ClientId = "29cf08acabfffe949825c57841a54998";
    private const string Callback = "/oauth/callback";
    private static readonly string Store = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SHOU U RUN", "apphub-session");

    internal sealed record Profile(string Name, string Email, string Subject, string Refresh);

    internal static async Task<Profile?> ReadAsync()
    {
        if (!File.Exists(Store)) return null;
        var protectedBytes = CryptographicBuffer.CreateFromByteArray(await File.ReadAllBytesAsync(Store));
        var plaintext = await new DataProtectionProvider().UnprotectAsync(protectedBytes);
        CryptographicBuffer.CopyToByteArray(plaintext, out var data);
        return JsonSerializer.Deserialize<Profile>(data);
    }

    internal static async Task<Profile> SignInAsync(CancellationToken cancellationToken)
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.ExclusiveAddressUse = true;
        listener.Start(8);
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var redirect = $"http://127.0.0.1:{port}{Callback}";
        var client = new OidcClient(new OidcClientOptions
        {
            Authority = Issuer,
            ClientId = ClientId,
            Scope = "openid profile email",
            RedirectUri = redirect,
            FilterClaims = false,
            DisablePushedAuthorization = true,
            IdentityTokenValidator = new SignedIdentityToken(),
            Policy = new Policy { RequireIdentityTokenSignature = true },
            BackchannelHandler = new HttpClientHandler { AllowAutoRedirect = false },
        });
        var flow = await client.PrepareLoginAsync(cancellationToken: cancellationToken);
        var authorize = new Uri(flow.StartUrl);
        if (!string.Equals(authorize.GetLeftPart(UriPartial.Authority), Issuer, StringComparison.Ordinal) ||
            authorize.UserInfo.Length != 0)
            throw new InvalidOperationException("Untrusted authorization endpoint.");
        var state = Parameter(authorize, "state") ?? throw new InvalidOperationException("Missing authorization state.");
        Process.Start(new ProcessStartInfo(flow.StartUrl) { UseShellExecute = true });
        var callback = await WaitForCallbackAsync(listener, port, state, cancellationToken);
        var result = await client.ProcessResponseAsync(callback.PathAndQuery, flow, cancellationToken: cancellationToken);
        if (result.IsError || result.User is null || string.IsNullOrEmpty(result.RefreshToken))
            throw new InvalidOperationException("App Hub sign-in did not complete.");
        var subject = result.User.FindFirst("sub")?.Value;
        if (string.IsNullOrEmpty(subject)) throw new InvalidOperationException("Missing account subject.");
        var profile = new Profile(result.User.FindFirst("name")?.Value ?? subject,
            result.User.FindFirst("email")?.Value ?? "", subject, result.RefreshToken);
        var source = CryptographicBuffer.CreateFromByteArray(JsonSerializer.SerializeToUtf8Bytes(profile));
        var ciphertext = await new DataProtectionProvider("LOCAL=user").ProtectAsync(source);
        CryptographicBuffer.CopyToByteArray(ciphertext, out var data);
        Directory.CreateDirectory(Path.GetDirectoryName(Store)!);
        var temporary = Store + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await File.WriteAllBytesAsync(temporary, data, cancellationToken);
            File.Move(temporary, Store, true);
        }
        finally { File.Delete(temporary); }
        return profile;
    }

    internal static async Task<bool> SignOutAsync(Profile profile)
    {
        File.Delete(Store);
        using var client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false })
        {
            Timeout = TimeSpan.FromSeconds(8),
        };
        using var request = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["client_id"] = ClientId, ["token"] = profile.Refresh, ["token_type_hint"] = "refresh_token",
        });
        try
        {
            using var response = await client.PostAsync(Issuer + "/api/login/oauth/revoke", request);
            return response.IsSuccessStatusCode;
        }
        catch (HttpRequestException) { return false; }
        catch (TaskCanceledException) { return false; }
    }

    private static async Task<Uri> WaitForCallbackAsync(TcpListener listener, int port, string state,
        CancellationToken cancellationToken)
    {
        while (true)
        {
            using var connection = await listener.AcceptTcpClientAsync(cancellationToken);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(3));
            try
            {
                using var stream = connection.GetStream();
                var request = await ReadRequestAsync(stream, timeout.Token);
                var destination = ValidateRequest(request, port, state);
                var body = destination is null ? "Invalid callback." : "Sign-in response received. You can return to the app.";
                var status = destination is null ? "400 Bad Request" : "200 OK";
                var response = $"HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\n" +
                    $"Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\nContent-Length: {body.Length}\r\n\r\n{body}";
                await stream.WriteAsync(Encoding.ASCII.GetBytes(response), timeout.Token);
                if (destination is not null) return destination;
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) {}
            catch (IOException) when (!cancellationToken.IsCancellationRequested) {}
        }
    }

    private static async Task<string> ReadRequestAsync(NetworkStream stream, CancellationToken cancellationToken)
    {
        var buffer = new byte[8192];
        int length = 0;
        while (length < buffer.Length)
        {
            int read = await stream.ReadAsync(buffer.AsMemory(length), cancellationToken);
            if (read == 0) break;
            length += read;
            int end = buffer.AsSpan(0, length).IndexOf("\r\n\r\n"u8);
            if (end >= 0) return Encoding.ASCII.GetString(buffer, 0, end);
        }
        return "";
    }

    private static Uri? ValidateRequest(string request, int port, string state)
    {
        string authority = $"127.0.0.1:{port}";
        var lines = request.Split("\r\n");
        var hosts = lines.Skip(1).Where(line => line.StartsWith("Host:", StringComparison.OrdinalIgnoreCase)).ToArray();
        if (hosts.Length != 1 || hosts[0][5..].Trim() != authority) return null;
        var start = lines[0].Split(' ');
        if (start.Length != 3 || start[0] != "GET" || start[2] != "HTTP/1.1" ||
            !start[1].StartsWith(Callback + "?", StringComparison.Ordinal) ||
            !Uri.TryCreate("http://" + authority + start[1], UriKind.Absolute, out var uri) ||
            uri.AbsolutePath != Callback || uri.Fragment.Length != 0)
            return null;
        var responseState = Parameter(uri, "state");
        return responseState is not null && CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(responseState), Encoding.UTF8.GetBytes(state)) ? uri : null;
    }

    private static string? Parameter(Uri uri, string key)
    {
        var values = uri.Query.TrimStart('?').Split('&').Select(pair => pair.Split('=', 2))
            .Where(pair => pair.Length == 2 && WebUtility.UrlDecode(pair[0]) == key).ToArray();
        return values.Length == 1 ? WebUtility.UrlDecode(values[0][1]) : null;
    }

    private sealed class SignedIdentityToken : IIdentityTokenValidator
    {
        public async Task<IdentityTokenValidationResult> ValidateAsync(string identityToken, OidcClientOptions options,
            CancellationToken cancellationToken = default)
        {
            var keys = options.ProviderInformation.KeySet.Keys
                .Where(key => key.Kty == "RSA" && (string.IsNullOrEmpty(key.Use) || key.Use == "sig") &&
                    (string.IsNullOrEmpty(key.Alg) || key.Alg == "RS256"))
                .Select(key => new RsaSecurityKey(new RSAParameters
                {
                    Modulus = Base64UrlEncoder.DecodeBytes(key.N),
                    Exponent = Base64UrlEncoder.DecodeBytes(key.E),
                }) { KeyId = key.Kid }).Where(key => key.KeySize >= 2048).ToArray();
            var handler = new JsonWebTokenHandler { MapInboundClaims = false };
            var result = await handler.ValidateTokenAsync(identityToken, new TokenValidationParameters
            {
                ValidateIssuer = true, ValidIssuer = Issuer, ValidateAudience = true, ValidAudience = ClientId,
                RequireSignedTokens = true, ValidateIssuerSigningKey = true, IssuerSigningKeys = keys,
                ValidAlgorithms = new[] { "RS256" }, TryAllIssuerSigningKeys = false,
                ValidateLifetime = true, RequireExpirationTime = true, ClockSkew = TimeSpan.FromSeconds(60),
            });
            if (!result.IsValid || result.ClaimsIdentity is null)
                return new IdentityTokenValidationResult { Error = "Invalid App Hub token." };
            return new IdentityTokenValidationResult
            {
                User = new ClaimsPrincipal(result.ClaimsIdentity), SignatureAlgorithm = "RS256",
            };
        }
    }
}
