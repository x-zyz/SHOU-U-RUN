using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Duende.IdentityModel.Client;
using Duende.IdentityModel.OidcClient;
using Duende.IdentityModel.OidcClient.Results;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using Windows.Security.Cryptography;
using Windows.Security.Cryptography.DataProtection;
using JsonWebKey = Duende.IdentityModel.Jwk.JsonWebKey;
using JsonWebKeySet = Duende.IdentityModel.Jwk.JsonWebKeySet;

namespace ShouURun.Desktop;

internal static class AppHubAccount
{
    private const string Issuer = "https://id.0979019203.top";
    private const string ClientId = "29cf08acabfffe949825c57841a54998";
    private const string Scope = "openid profile email";
    private const string Callback = "/oauth/callback";
    private const string MembershipEndpoint = "https://api.0979019203.top/v1/apps/campus-run/membership";
    private static readonly string Store = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SHOU U RUN", "apphub-session");
    private static readonly HttpClient Backchannel = new(new HttpClientHandler
    {
        AllowAutoRedirect = false,
        UseCookies = false,
    })
    {
        Timeout = TimeSpan.FromSeconds(10),
        MaxResponseContentBufferSize = 256 * 1024,
    };

    private sealed record Profile(string Subject, string Refresh);
    internal sealed record Session(string Subject, string Name, string IdentityToken, DateTime ExpiresAt);
    internal enum Membership { Active, Denied, Expired, Unavailable }
    internal readonly record struct MembershipCheck(Membership Status, DateTime? ExpiresAt = null);

    private static async Task<Profile?> ReadAsync(CancellationToken cancellationToken)
    {
        if (!File.Exists(Store)) return null;
        var protectedBytes = CryptographicBuffer.CreateFromByteArray(await File.ReadAllBytesAsync(Store, cancellationToken));
        var plaintext = await new DataProtectionProvider().UnprotectAsync(protectedBytes);
        CryptographicBuffer.CopyToByteArray(plaintext, out var data);
        try
        {
            var profile = JsonSerializer.Deserialize<Profile>(data);
            return string.IsNullOrEmpty(profile?.Subject) || string.IsNullOrEmpty(profile.Refresh) ? null : profile;
        }
        finally { CryptographicOperations.ZeroMemory(data); }
    }

    internal static async Task<bool> HasStoredAccountAsync(string subject, CancellationToken cancellationToken)
    {
        using var lease = await LockStoreAsync(cancellationToken);
        return (await ReadAsync(cancellationToken))?.Subject == subject;
    }

    internal static async Task<Session> SignInAsync(bool chooseAccount, CancellationToken cancellationToken)
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.ExclusiveAddressUse = true;
        listener.Start(8);
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var redirect = $"http://127.0.0.1:{port}{Callback}";
        var nonce = Base64UrlEncoder.Encode(RandomNumberGenerator.GetBytes(32));
        var client = new OidcClient(new OidcClientOptions
        {
            Authority = Issuer,
            ClientId = ClientId,
            Scope = Scope,
            RedirectUri = redirect,
            FilterClaims = false,
            LoadProfile = false,
            DisablePushedAuthorization = true,
            IdentityTokenValidator = new SignedIdentityToken(nonce),
            Policy = new Policy { RequireIdentityTokenSignature = true },
            BackchannelHandler = new HttpClientHandler { AllowAutoRedirect = false },
        });
        var parameters = new Parameters { { "nonce", nonce } };
        if (chooseAccount) parameters.Add("prompt", "login");
        var flow = await client.PrepareLoginAsync(parameters, cancellationToken);
        var authorize = new Uri(flow.StartUrl);
        if (!string.Equals(authorize.GetLeftPart(UriPartial.Authority), Issuer, StringComparison.Ordinal) ||
            authorize.UserInfo.Length != 0)
            throw new InvalidOperationException("Untrusted authorization endpoint.");
        var state = Parameter(authorize, "state") ?? throw new InvalidOperationException("Missing authorization state.");
        Process.Start(new ProcessStartInfo(flow.StartUrl) { UseShellExecute = true });
        var callback = await WaitForCallbackAsync(listener, port, state, cancellationToken);
        var result = await client.ProcessResponseAsync(callback.AbsoluteUri, flow, cancellationToken: cancellationToken);
        if (result.IsError || result.User is null || string.IsNullOrEmpty(result.RefreshToken) ||
            string.IsNullOrEmpty(result.IdentityToken))
            throw new InvalidOperationException("App Hub sign-in did not complete.");
        var session = CreateSession(result.User, result.IdentityToken);
        using var lease = await LockStoreAsync(cancellationToken);
        await SaveAsync(new Profile(session.Subject, result.RefreshToken), cancellationToken);
        return session;
    }

    internal static async Task<Session?> RefreshAsync(CancellationToken cancellationToken)
    {
        using var lease = await LockStoreAsync(cancellationToken);
        var profile = await ReadAsync(cancellationToken);
        if (profile is null) return null;
        var keys = new JsonWebKeySet(await Backchannel.GetStringAsync(Issuer + "/.well-known/jwks", cancellationToken));
        using var form = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "refresh_token",
            ["client_id"] = ClientId,
            ["refresh_token"] = profile.Refresh,
        });
        using var response = await Backchannel.PostAsync(Issuer + "/api/login/oauth/access_token", form, cancellationToken);
        using var document = JsonDocument.Parse(await response.Content.ReadAsByteArrayAsync(cancellationToken));
        var payload = document.RootElement;
        if (StringProperty(payload, "error") == "invalid_grant" && (int)response.StatusCode < 500)
        {
            File.Delete(Store);
            return null;
        }
        response.EnsureSuccessStatusCode();
        var identityToken = StringProperty(payload, "id_token");
        if (string.IsNullOrEmpty(identityToken)) throw new InvalidOperationException("Missing refreshed App Hub ID token.");
        var validation = await ValidateIdentityTokenAsync(identityToken, keys.Keys, expectedSubject: profile.Subject);
        if (validation.IsError || validation.User is null)
            throw new InvalidOperationException("Invalid refreshed App Hub ID token.");
        var session = CreateSession(validation.User, identityToken);
        var nextRefresh = StringProperty(payload, "refresh_token");
        await SaveAsync(new Profile(session.Subject, string.IsNullOrEmpty(nextRefresh) ? profile.Refresh : nextRefresh), cancellationToken);
        return session;
    }

    internal static async Task<MembershipCheck> CheckMembershipAsync(Session session, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, MembershipEndpoint);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", session.IdentityToken);
        request.Headers.CacheControl = new CacheControlHeaderValue { NoCache = true, NoStore = true };
        using var response = await Backchannel.SendAsync(request, cancellationToken);
        if (response.StatusCode == HttpStatusCode.Unauthorized) return new(Membership.Expired);
        if (response.StatusCode == HttpStatusCode.Forbidden) return new(Membership.Denied);
        if (response.StatusCode != HttpStatusCode.OK) return new(Membership.Unavailable);
        using var document = JsonDocument.Parse(await response.Content.ReadAsByteArrayAsync(cancellationToken));
        var payload = document.RootElement;
        if (payload.ValueKind != JsonValueKind.Object ||
            !payload.TryGetProperty("active", out var active) || active.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            return new(Membership.Unavailable);
        if (active.ValueKind != JsonValueKind.True || StringProperty(payload, "tier") != "member")
            return new(Membership.Denied);
        if (!payload.TryGetProperty("expires_at", out var expiry)) return new(Membership.Active);
        if (expiry.ValueKind != JsonValueKind.String || !expiry.TryGetDateTimeOffset(out var end))
            return new(Membership.Unavailable);
        return end > DateTimeOffset.UtcNow ? new(Membership.Active, end.UtcDateTime) : new(Membership.Denied);
    }

    private static Session CreateSession(ClaimsPrincipal user, string identityToken)
    {
        var subject = user.FindFirst("sub")?.Value;
        if (string.IsNullOrEmpty(subject)) throw new InvalidOperationException("Missing App Hub account subject.");
        return new Session(subject, user.FindFirst("name")?.Value ?? subject, identityToken,
            new JsonWebToken(identityToken).ValidTo);
    }

    private static string? StringProperty(JsonElement payload, string name) =>
        payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty(name, out var value) &&
        value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static async Task SaveAsync(Profile profile, CancellationToken cancellationToken)
    {
        var plaintext = JsonSerializer.SerializeToUtf8Bytes(profile);
        Windows.Storage.Streams.IBuffer ciphertext;
        try
        {
            var source = CryptographicBuffer.CreateFromByteArray(plaintext);
            ciphertext = await new DataProtectionProvider("LOCAL=user").ProtectAsync(source);
        }
        finally { CryptographicOperations.ZeroMemory(plaintext); }
        CryptographicBuffer.CopyToByteArray(ciphertext, out var data);
        var temporary = Store + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await File.WriteAllBytesAsync(temporary, data, cancellationToken);
            File.Move(temporary, Store, true);
        }
        finally { File.Delete(temporary); }
    }

    private static async Task<FileStream> LockStoreAsync(CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Store)!);
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try { return new FileStream(Store + ".lock", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException error) when ((error.HResult & 0xffff) is 32 or 33)
            {
                await Task.Delay(150, cancellationToken);
            }
        }
    }

    internal static async Task SignOutAsync(CancellationToken cancellationToken)
    {
        Profile? profile;
        using (await LockStoreAsync(cancellationToken))
        {
            try { profile = await ReadAsync(cancellationToken); }
            catch (Exception error) when (error is JsonException or CryptographicException or System.Runtime.InteropServices.COMException)
            {
                profile = null;
            }
            File.Delete(Store);
        }
        if (profile is null) return;
        using var request = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["client_id"] = ClientId, ["token"] = profile.Refresh, ["token_type_hint"] = "refresh_token",
        });
        try
        {
            using var response = await Backchannel.PostAsync(Issuer + "/api/login/oauth/revoke", request, cancellationToken);
        }
        catch (HttpRequestException) {}
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested) {}
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

    private sealed class SignedIdentityToken(string nonce) : IIdentityTokenValidator
    {
        public Task<IdentityTokenValidationResult> ValidateAsync(string identityToken, OidcClientOptions options,
            CancellationToken cancellationToken = default) =>
            ValidateIdentityTokenAsync(identityToken, options.ProviderInformation.KeySet.Keys, nonce);
    }

    private static async Task<IdentityTokenValidationResult> ValidateIdentityTokenAsync(string identityToken,
        IEnumerable<JsonWebKey> providerKeys, string? nonce = null, string? expectedSubject = null)
    {
        var keys = providerKeys
            .Where(key => key.Kty == "RSA" && !string.IsNullOrEmpty(key.Kid) &&
                (string.IsNullOrEmpty(key.Use) || key.Use == "sig") &&
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
            IgnoreTrailingSlashWhenValidatingAudience = false,
            RequireSignedTokens = true, ValidateIssuerSigningKey = true, IssuerSigningKeys = keys,
            ValidAlgorithms = new[] { "RS256" }, TryAllIssuerSigningKeys = false,
            ValidateLifetime = true, RequireExpirationTime = true, ClockSkew = TimeSpan.FromSeconds(60),
        });
        if (!result.IsValid || result.ClaimsIdentity is null)
            return new IdentityTokenValidationResult { Error = "Invalid App Hub token." };
        var identity = result.ClaimsIdentity;
        var subjects = identity.FindAll("sub").ToArray();
        var nonces = identity.FindAll("nonce").ToArray();
        var audience = identity.FindAll("aud").Select(claim => claim.Value).ToArray();
        var authorizedParty = identity.FindAll("azp").ToArray();
        var tokenTypes = identity.FindAll("tokenType").ToArray();
        if (subjects.Length != 1 || string.IsNullOrEmpty(subjects[0].Value) ||
            (expectedSubject is not null && subjects[0].Value != expectedSubject) ||
            (nonce is not null && (nonces.Length != 1 || !CryptographicOperations.FixedTimeEquals(
                Encoding.UTF8.GetBytes(nonces[0].Value), Encoding.UTF8.GetBytes(nonce)))) ||
            audience.Length != 1 || audience[0] != ClientId ||
            tokenTypes.Length != 1 || tokenTypes[0].Value != "id-token" ||
            (authorizedParty.Length > 0 && (authorizedParty.Length != 1 || authorizedParty[0].Value != ClientId)))
            return new IdentityTokenValidationResult { Error = "Invalid App Hub authorization claims." };
        return new IdentityTokenValidationResult
        {
            User = new ClaimsPrincipal(identity), SignatureAlgorithm = "RS256",
        };
    }
}
