using System.Globalization;
using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ShouURun.Desktop;

internal sealed class KeepException(string message, bool sessionExpired = false) : Exception(message)
{
    public bool SessionExpired { get; } = sessionExpired;
}

internal sealed class KeepClient : IDisposable
{
    private const string Version = "20240725.2";
    private const string UploadPath = "/pd/v5/sportlog";
    private const string LegacySalt = "V1QiLCJhbGciOiJIUzI1NiJ9";
    private static readonly byte[] CbcKey = Encoding.ASCII.GetBytes("56fe59;82g:d873c");
    private static readonly byte[] CbcIv = Encoding.ASCII.GetBytes("2346892432920300");
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    private readonly HttpClient http = new(new SocketsHttpHandler
    {
        AllowAutoRedirect = false,
        UseCookies = false,
        AutomaticDecompression = DecompressionMethods.All,
        ConnectTimeout = TimeSpan.FromSeconds(15)
    });

    private readonly KeepSessionStore store = new();
    private sealed record SmsAttempt(string Phone, string DeviceId, long ExpiresAt);
    private KeepSession? session;
    private SmsAttempt? sms;
    private long nextSmsAt;

    public string AccountLabel => session?.Label ?? "";

    public async Task<string> SendSms(string phone, CancellationToken cancellation)
    {
        if (!Regex.IsMatch(phone, @"\A1[3-9][0-9]{9}\z")) throw new KeepException("请输入 11 位中国大陆手机号。");
        long now = Environment.TickCount64;
        if (now < nextSmsAt) throw new KeepException("请等待 60 秒后重发验证码。");
        nextSmsAt = now + 60_000;
        sms = null;

        string device = DeviceId(phone);
        var data = new
        {
            countryCode = "86",
            mobile = phone,
            countryName = "CHN",
            time = UnixNow().ToString(CultureInfo.InvariantCulture),
            type = "registerLogin"
        };
        string body = Json(new { body = EncryptCbc(Encoding.UTF8.GetBytes(Json(data))) });
        using var reply = await Post("/account/v2/sms", device, body, cancellation).ConfigureAwait(false);
        sms = new SmsAttempt(phone, device, Environment.TickCount64 + 600_000);
        return "验证码已发送，请查看短信。";
    }

    public async Task<string> Login(string phone, string code, CancellationToken cancellation)
    {
        var attempt = sms;
        if (attempt is null || attempt.Phone != phone || attempt.ExpiresAt <= Environment.TickCount64)
            throw new KeepException("请先向该手机号发送新的验证码。");
        if (!Regex.IsMatch(code, @"\A[0-9]{4,8}\z")) throw new KeepException("请输入收到的短信验证码。");
        string body = Json(new { androidId = attempt.DeviceId, captcha = code, countryCode = "86", countryName = "CHN", mobile = phone, type = "login" });
        using var reply = await Post("/account/v3/login/sms", attempt.DeviceId, body, cancellation).ConfigureAwait(false);
        var data = Property(reply.RootElement, "data");
        using var decrypted = data.ValueKind == JsonValueKind.String ? DecryptLogin(data.GetString()!) : null;
        string token = String(decrypted?.RootElement ?? data, "token");
        _ = ReadToken(token);
        var candidate = new KeepSession(token, attempt.DeviceId, phone[..3] + "****" + phone[7..]);
        sms = null;
        session = candidate;
        try { await store.Save(candidate); }
        catch { return "本次已登录，但未能保存凭证，重启后需重新登录。"; }
        return "Keep 登录成功，已加密保存到本机。";
    }

    public async Task<string> RestoreSession()
    {
        try
        {
            var saved = await store.Load();
            if (saved is null) return "登录后会在本机加密保存凭证。";
            _ = ReadToken(saved.Token ?? "");
            if (string.IsNullOrWhiteSpace(saved.Label) || string.IsNullOrWhiteSpace(saved.DeviceId))
                throw new InvalidDataException();
            session = saved;
            return "已恢复本机保存的 Keep 凭证。";
        }
        catch
        {
            ExpireSession();
            return "本机凭证已失效，请重新登录。";
        }
    }

    public async Task<string> SaveToken(string rawToken)
    {
        string token = NormalizeToken(rawToken);
        _ = ReadToken(token);
        var candidate = new KeepSession(token, DeviceId(token), "手动凭证");
        try { await store.Save(candidate); }
        catch { throw new KeepException("无法在本机保存凭证。"); }
        session = candidate;
        sms = null;
        return "已加密保存到本机，上传时由 Keep 验证凭证。";
    }

    public string Logout()
    {
        try { store.Clear(); }
        catch { throw new KeepException("未能清除本机凭证，请重试退出。"); }
        session = null;
        sms = null;
        return "已退出 Keep，并清除本机凭证。";
    }

    public void ExpireSession()
    {
        session = null;
        sms = null;
        try { store.Clear(); }
        catch (IOException) {}
        catch (UnauthorizedAccessException) {}
    }

    private static string NormalizeToken(string token) =>
        Regex.Replace(token.Trim(), @"\ABearer\s+", "", RegexOptions.IgnoreCase);

    public async Task<string> Upload(string activity, string fallbackToken, CancellationToken cancellation)
    {
        string token = session?.Token ?? NormalizeToken(fallbackToken);
        var (uid, jwtSignature) = ReadToken(token);
        string device = session?.DeviceId ?? DeviceId(token);
        if (activity.Length is 0 or > 16_000_000) throw new KeepException("轨迹记录为空或过大。");
        string body = await Task.Run(() =>
        {
            using var doc = JsonDocument.Parse(activity);
            return UploadBody(KeepPayload.Build(doc.RootElement, uid), uid, jwtSignature);
        }, cancellation).ConfigureAwait(false);
        using var reply = await Post(UploadPath, device, body, cancellation, token, UploadSignature(uid, body)).ConfigureAwait(false);
        return "Keep 已接受记录，请在 Keep 中核对结果。";
    }

    /// <summary>Reads one Keep outdoor run with the saved session. Never writes to Keep.</summary>
    public async Task<string> ImportLatestOutdoorRun(CancellationToken cancellation)
    {
        if (session is null) await RestoreSession().ConfigureAwait(false);
        if (session is null) throw new KeepException("请先在页面下方登录 Keep，再导入跑步。");

        using var list = await Get("/pd/v3/stats/detail?dateUnit=all&type=running&lastDate=0", cancellation)
            .ConfigureAwait(false);
        var candidates = KeepImporter.Candidates(Property(list.RootElement, "data"), 8);
        if (candidates.Count == 0) throw new KeepException("没有找到 Keep 跑步记录。");

        string? summaryOnly = null;
        foreach (string id in candidates)
        {
            cancellation.ThrowIfCancellationRequested();
            try
            {
                using var detail = await Get("/pd/v3/runninglog/" + Uri.EscapeDataString(id), cancellation)
                    .ConfigureAwait(false);
                var run = Property(detail.RootElement, "data");
                if (run.ValueKind != JsonValueKind.Object || String(run, "dataType") != "outdoorRunning") continue;

                string geoPoints = String(run, "geoPoints");
                if (geoPoints.Length == 0)
                {
                    summaryOnly ??= KeepImporter.BuildActivity(run, default);
                    continue;
                }

                string pointsJson = KeepImporter.DecodeGeoPoints(geoPoints);
                using var points = JsonDocument.Parse(pointsJson);
                return KeepImporter.BuildActivity(run, points.RootElement);
            }
            catch (Exception error) when (error is InvalidDataException or JsonException)
            {
                // A malformed record must not hide a later readable outdoor run.
            }
        }
        return summaryOnly ?? throw new KeepException("没有找到可读取的 Keep 户外跑步。");
    }

    internal sealed record FileImportScan(int Scanned, int Matched, int Unavailable);
    private readonly List<string> fileImportIds = [];
    private string? fileImportOwner;

    private async IAsyncEnumerable<string> RunHistoryIds(
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellation, bool includeDoubtful = false)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var cursors = new HashSet<long>();
        long cursor = 0;
        do
        {
            if (!cursors.Add(cursor)) throw new KeepException("Keep 重复返回同一分页，扫描已停止。");
            using var page = await Get("/pd/v3/stats/detail?dateUnit=all&type=running&lastDate=" +
                cursor.ToString(CultureInfo.InvariantCulture), cancellation).ConfigureAwait(false);
            var data = Property(page.RootElement, "data");
            if (Property(data, "records").ValueKind != JsonValueKind.Array)
                throw new KeepException("Keep 历史列表格式已变化。");
            foreach (string id in KeepImporter.Candidates(data, int.MaxValue, includeDoubtful))
            {
                if (!seen.Add(id)) continue;
                cancellation.ThrowIfCancellationRequested();
                yield return id;
                await Task.Delay(250, cancellation).ConfigureAwait(false);
            }
            cursor = KeepFileImports.Cursor(data);
        } while (cursor != 0);
    }

    public async Task<FileImportScan> ScanFileImports(IProgress<int> progress, CancellationToken cancellation)
    {
        fileImportIds.Clear();
        fileImportOwner = null;
        if (session is null) throw new KeepException("请先登录 Keep，再扫描历史跑步。");
        var (owner, _) = ReadToken(session.Token);
        var matches = new List<string>();
        int scanned = 0, unavailable = 0;
        await foreach (string id in RunHistoryIds(cancellation, includeDoubtful: true).ConfigureAwait(false))
        {
            try
            {
                using var detail = await Get("/pd/v3/runninglog/" + Uri.EscapeDataString(id), cancellation)
                    .ConfigureAwait(false);
                var run = Property(detail.RootElement, "data");
                if (run.ValueKind != JsonValueKind.Object) unavailable++;
                else if (String(run, "dataType") == "outdoorRunning" && KeepFileImports.IsFileImport(run)) matches.Add(id);
            }
            catch (KeepException error) when (error.Message.StartsWith("Keep 返回 HTTP 404", StringComparison.Ordinal))
            {
                unavailable++;
            }
            progress.Report(++scanned);
        }
        fileImportIds.AddRange(matches);
        fileImportOwner = owner;
        return new FileImportScan(scanned, matches.Count, unavailable);
    }

    public async Task<List<JsonElement>> ImportOutdoorHistory(IProgress<int> progress, CancellationToken cancellation)
    {
        if (session is null) throw new KeepException("请先在「导出与登录」登录 Keep。");
        _ = ReadToken(session.Token);
        var activities = new List<JsonElement>();
        int bytes = 0, scanned = 0;
        await foreach (string id in RunHistoryIds(cancellation).ConfigureAwait(false))
        {
            progress.Report(++scanned);
            try
            {
                using var detail = await Get("/pd/v3/runninglog/" + Uri.EscapeDataString(id), cancellation)
                    .ConfigureAwait(false);
                var run = Property(detail.RootElement, "data");
                if (String(run, "dataType") != "outdoorRunning") continue;
                var raw = Property(run, "geoPoints");
                using var decoded = raw.ValueKind == JsonValueKind.String
                    ? JsonDocument.Parse(KeepImporter.DecodeGeoPoints(raw.GetString()!))
                    : null;
                var points = decoded?.RootElement ?? raw;
                if (points.ValueKind != JsonValueKind.Array || points.GetArrayLength() < 2) continue;
                string activity = KeepImporter.BuildActivity(run, points);
                int size = Encoding.UTF8.GetByteCount(activity);
                if (size > 8_000_000 - bytes)
                {
                    if (activities.Count > 0) break;
                    continue;
                }
                activities.Add(JsonSerializer.Deserialize<JsonElement>(activity));
                bytes += size;
                if (activities.Count == 20) break;
            }
            catch (Exception error) when (error is InvalidDataException or JsonException ||
                error is KeepException keepError && keepError.Message.StartsWith("Keep 返回 HTTP 404", StringComparison.Ordinal))
            {
                // A missing or malformed activity does not prevent reading the next one.
            }
        }
        return activities;
    }

    internal sealed record FileBatchResult(int Completed, int Held, int Skipped, int Total, string? Failure);

    public async Task<FileBatchResult> ConvertFileImports(IProgress<FileBatchResult> progress, CancellationToken cancellation)
    {
        var current = session ?? throw new KeepException("请先登录 Keep。");
        var (uid, jwtSignature) = ReadToken(current.Token);
        if (fileImportOwner != uid || fileImportIds.Count == 0)
            throw new KeepException("请先扫描当前账号的文件导入记录。");

        var ids = fileImportIds.ToArray();
        fileImportIds.Clear();
        fileImportOwner = null;
        int completed = 0, held = 0, skipped = 0;
        string? failure = null;
        foreach (string id in ids)
        {
            cancellation.ThrowIfCancellationRequested();
            var marker = FileImportMarker(uid, id);
            if (File.Exists(marker))
            {
                held++;
                progress.Report(new(completed, held, skipped, ids.Length, null));
                continue;
            }

            string body;
            try
            {
                using var detail = await Get("/pd/v3/runninglog/" + Uri.EscapeDataString(id), cancellation)
                    .ConfigureAwait(false);
                var run = Property(detail.RootElement, "data");
                if (String(run, "dataType") != "outdoorRunning")
                    throw new InvalidDataException("Unsupported activity type.");
                body = UploadBody(KeepFileImports.Rebuild(run, uid), uid, jwtSignature);
            }
            catch (Exception error) when (error is InvalidDataException or JsonException ||
                error is KeepException keepError && !keepError.SessionExpired &&
                (!keepError.Message.StartsWith("Keep 返回 HTTP", StringComparison.Ordinal) ||
                  keepError.Message.StartsWith("Keep 返回 HTTP 404", StringComparison.Ordinal)))
            {
                skipped++;
                progress.Report(new(completed, held, skipped, ids.Length, null));
                continue;
            }

            Directory.CreateDirectory(Path.GetDirectoryName(marker)!);
            try
            {
                using var reservation = new FileStream(marker, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
                reservation.WriteByte(0);
                reservation.Flush(flushToDisk: true);
            }
            catch (IOException) when (File.Exists(marker))
            {
                held++;
                progress.Report(new(completed, held, skipped, ids.Length, null));
                continue;
            }

            try
            {
                using var reply = await Post(UploadPath, current.DeviceId, body, cancellation,
                    current.Token, UploadSignature(uid, body)).ConfigureAwait(false);
                completed++;
                try { await File.WriteAllTextAsync(marker, "done", CancellationToken.None).ConfigureAwait(false); }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException) {}
            }
            catch (Exception error) when (error is not OperationCanceledException || !cancellation.IsCancellationRequested)
            {
                held++;
                failure = error is KeepException keepError ? keepError.Message : "请求结果无法确认，请在 Keep 核对。";
                if (error is KeepException { SessionExpired: true }) ExpireSession();
                break;
            }
            progress.Report(new(completed, held, skipped, ids.Length, null));
            await Task.Delay(500, cancellation).ConfigureAwait(false);
        }
        return new(completed, held, skipped, ids.Length, failure);
    }

    private static string FileImportMarker(string owner, string recordId)
    {
        string key = Sha256Hex(owner + ":" + recordId);
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ShouURun", "keep-conversion", key);
    }

    private async Task<JsonDocument> Get(string path, CancellationToken cancellation)
    {
        string token = session?.Token ?? "";
        if (token.Length == 0) throw new KeepException("请先在页面下方登录 Keep，再导入跑步。");
        string device = session?.DeviceId ?? "";
        if (string.IsNullOrWhiteSpace(device)) device = DeviceId(token);

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        using var request = new HttpRequestMessage(HttpMethod.Get, "https://api.gotokeep.com" + path);
        var headers = request.Headers;
        headers.TryAddWithoutValidation("User-Agent", "Keep/9.1.80 (RunningHelper Desktop)");
        headers.Add("x-version-name", "9.1.80");
        headers.Add("x-version-code", "50178");
        headers.Add("x-os", "Android");
        headers.Add("x-app-platform", "keepapp");
        headers.Add("x-locale", "zh-Hans-CN");
        headers.Add("x-keep-timezone", "Asia/Shanghai");
        headers.Add("x-is-guest", "N");
        headers.Add("x-encrypt-code", Version);
        headers.Add("x-device-id", device);
        headers.Add("x-timestamp", UnixNow().ToString(CultureInfo.InvariantCulture));
        headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token)
            .ConfigureAwait(false);
        await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token).ConfigureAwait(false);
        using var buffer = new MemoryStream();
        byte[] block = new byte[8192];
        int read;
        while ((read = await stream.ReadAsync(block, timeout.Token).ConfigureAwait(false)) != 0)
        {
            if (buffer.Length + read > 8_000_000) throw new KeepException("Keep 响应过大。");
            buffer.Write(block, 0, read);
        }

        JsonDocument? reply = null;
        try { reply = JsonDocument.Parse(buffer.ToArray()); }
        catch (JsonException) { /* Keep may return a plain HTTP error. */ }

        if (response.StatusCode == HttpStatusCode.Unauthorized)
        {
            using (reply) { ExpireSession(); }
            throw new KeepException("Keep 登录已过期，请重新登录。", sessionExpired: true);
        }
        if (response.IsSuccessStatusCode && reply is not null &&
            Property(reply.RootElement, "ok").ValueKind == JsonValueKind.True) return reply;

        using (reply)
        {
            var root = reply?.RootElement ?? default;
            string error = Property(root, "errorCode").ToString();
            if (error.Length == 0) error = Property(root, "code").ToString();
            string suffix = Regex.IsMatch(error, @"\A[1-9][0-9]{0,9}\z") ? $"（Keep 错误码 {error}）" : "";
            string message = response.IsSuccessStatusCode ? "Keep 拒绝了请求" : $"Keep 返回 HTTP {(int)response.StatusCode}";
            throw new KeepException(message + suffix, response.StatusCode == HttpStatusCode.Unauthorized);
        }
    }

    private static string UploadBody(string payload, string uid, string jwtSignature)
    {
        byte[] key = UploadKey(uid);
        byte[] iv = RandomNumberGenerator.GetBytes(12);
        byte[] input = Encoding.UTF8.GetBytes(payload);
        byte[] encrypted = new byte[input.Length + 16];
        using var gcm = new AesGcm(key, 16);
        gcm.Encrypt(iv, input, encrypted.AsSpan(0, input.Length), encrypted.AsSpan(input.Length));
        string iv64 = Url64(iv);
        string envelope = $"{iv64}.{Url64(encrypted)}.{Sign(key, iv64 + "cNARa" + jwtSignature)}";
        return Json(new { enkzip = envelope });
    }

    internal static string UploadSignature(string uid, string body) => Sign(UploadKey(uid), body + UploadPath + Version);
    private static byte[] UploadKey(string uid) => Encoding.ASCII.GetBytes(Md5Hex(uid[13..] + uid[..13]));

    internal static string LegacySignature(string path, string body)
    {
        string hash = Md5Hex(body + path + LegacySalt);
        ulong checksum = 929UL * 286331153UL;
        for (int i = 0; i < hash.Length; i += 8)
            checksum += uint.Parse(hash.AsSpan(i, 8), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        return hash + unchecked((uint)checksum).ToString("x8", CultureInfo.InvariantCulture);
    }

    private async Task<JsonDocument> Post(string path, string device, string body, CancellationToken cancellation,
        string? token = null, string? signature = null)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        using var request = new HttpRequestMessage(HttpMethod.Post, "https://api.gotokeep.com" + path)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json")
        };
        var headers = request.Headers;
        headers.TryAddWithoutValidation("User-Agent", "Keep/9.1.80 (RunningHelper Desktop)");
        headers.Add("x-version-name", "9.1.80");
        headers.Add("x-version-code", "50178");
        headers.Add("x-os", "Android");
        headers.Add("x-app-platform", "keepapp");
        headers.Add("x-locale", "zh-Hans-CN");
        headers.Add("x-keep-timezone", "Asia/Shanghai");
        headers.Add("x-is-guest", "N");
        headers.Add("x-encrypt-code", Version);
        headers.Add("x-device-id", device);
        headers.Add("x-timestamp", UnixNow().ToString(CultureInfo.InvariantCulture));
        if (token is null) headers.Add("sign", LegacySignature(path, body));
        else
        {
            headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            headers.Add("x-sign", signature!);
        }

        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token).ConfigureAwait(false);
        await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token).ConfigureAwait(false);
        using var buffer = new MemoryStream();
        byte[] block = new byte[8192];
        int n;
        while ((n = await stream.ReadAsync(block, timeout.Token).ConfigureAwait(false)) != 0)
        {
            if (buffer.Length + n > 256_000) throw new KeepException("Keep 响应过大。");
            buffer.Write(block, 0, n);
        }
        JsonDocument? reply = null;
        try { reply = JsonDocument.Parse(buffer.ToArray()); }
        catch (JsonException) { /* Keep may return a plain HTTP error. */ }
        if (response.IsSuccessStatusCode && reply is not null && Property(reply.RootElement, "ok").ValueKind == JsonValueKind.True)
            return reply;

        using (reply)
        {
            var root = reply?.RootElement ?? default;
            string error = Property(root, "errorCode").ToString();
            if (error.Length == 0) error = Property(root, "code").ToString();
            string suffix = Regex.IsMatch(error, @"\A[1-9][0-9]{0,9}\z") ? $"（Keep 错误码 {error}）" : "";
            string message = response.IsSuccessStatusCode ? "Keep 拒绝了请求" : $"Keep 返回 HTTP {(int)response.StatusCode}";
            throw new KeepException(message + suffix, response.StatusCode == HttpStatusCode.Unauthorized);
        }
    }

    private static (string UserId, string Signature) ReadToken(string token)
    {
        string[] segments = token.Split('.');
        if (token.Length > 8192 || segments.Length != 3 || !segments.All(s => Regex.IsMatch(s, @"\A[A-Za-z0-9_-]+\z")))
            throw new KeepException("Keep 登录凭证格式无效。");
        try
        {
            string payload = segments[1].Replace('-', '+').Replace('_', '/');
            payload = payload.PadRight((payload.Length + 3) / 4 * 4, '=');
            using var claims = JsonDocument.Parse(Convert.FromBase64String(payload));
            string uid = String(claims.RootElement, "_id");
            if (!Regex.IsMatch(uid, @"\A[a-fA-F0-9]{24}\z"))
                throw new KeepException("Keep 登录凭证缺少用户 ID。");
            var expiration = Property(claims.RootElement, "exp");
            if (!long.TryParse(expiration.ToString(), CultureInfo.InvariantCulture, out long exp) || exp <= UnixNow() / 1000 + 60)
                throw new KeepException("Keep 登录凭证已经过期。", sessionExpired: true);
            return (uid, segments[2]);
        }
        catch (Exception ex) when (ex is JsonException or FormatException)
        {
            throw new KeepException("Keep 登录凭证格式无效。");
        }
    }

    private static JsonDocument DecryptLogin(string value)
    {
        using var aes = Aes.Create();
        aes.Key = CbcKey;
        return JsonDocument.Parse(aes.DecryptCbc(Convert.FromBase64String(value), CbcIv, PaddingMode.PKCS7));
    }

    private static string Sign(byte[] key, string value)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData(key);
        hash.AppendData(Encoding.UTF8.GetBytes(value));
        return Url64(hash.GetHashAndReset()) + "A";
    }

    private static string DeviceId(string input) => Sha256Hex("keep:" + Sha256Hex(input.ToLowerInvariant()))[..16];
    private static string Md5Hex(string value) => Convert.ToHexString(MD5.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    private static string Sha256Hex(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    private static string Url64(byte[] value) => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static long UnixNow() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    internal static string Json<T>(T value) => JsonSerializer.Serialize(value, JsonOptions);
    internal static JsonElement Property(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var result) ? result : default;
    private static string String(JsonElement value, string name) =>
        Property(value, name) is { ValueKind: JsonValueKind.String } item ? item.GetString() ?? "" : "";

    internal static byte[] Gzip(string value)
    {
        using var bytes = new MemoryStream();
        using (var gzip = new GZipStream(bytes, CompressionLevel.Optimal, leaveOpen: true)) gzip.Write(Encoding.UTF8.GetBytes(value));
        return bytes.ToArray();
    }

    internal static string EncryptCbc(byte[] input)
    {
        using var aes = Aes.Create();
        aes.Key = CbcKey;
        return Convert.ToBase64String(aes.EncryptCbc(input, CbcIv, PaddingMode.PKCS7));
    }

    public void Dispose()
    {
        session = null;
        sms = null;
        http.Dispose();
    }
}
