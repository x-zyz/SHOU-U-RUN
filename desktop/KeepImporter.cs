using System.Globalization;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace ShouURun.Desktop;

/// <summary>Decodes Keep's read-only geoPoints and strips the response to the fields the pace adapter needs.</summary>
internal static class KeepImporter
{
    private const int MaxDecodedBytes = 16 * 1024 * 1024;
    private static readonly byte[] CbcKey = Encoding.ASCII.GetBytes("56fe59;82g:d873c");
    private static readonly byte[] CbcIv = Encoding.ASCII.GetBytes("2346892432920300");

    internal static IReadOnlyList<string> Candidates(JsonElement data, int limit = 8, bool includeDoubtful = false)
    {
        List<string> ids = [];
        if (data.ValueKind != JsonValueKind.Object ||
            !data.TryGetProperty("records", out var records) ||
            records.ValueKind != JsonValueKind.Array) return ids;

        foreach (var record in records.EnumerateArray())
        {
            if (record.ValueKind != JsonValueKind.Object ||
                !record.TryGetProperty("logs", out var logs) ||
                logs.ValueKind != JsonValueKind.Array) continue;
            foreach (var log in logs.EnumerateArray())
            {
                if (log.ValueKind != JsonValueKind.Object ||
                    !log.TryGetProperty("stats", out var stats) ||
                    stats.ValueKind != JsonValueKind.Object) continue;
                if (!includeDoubtful && stats.TryGetProperty("isDoubtful", out var doubtful) &&
                    doubtful.ValueKind == JsonValueKind.True) continue;
                string id = Text(stats, "id");
                if (id.Length == 0 || ids.Contains(id, StringComparer.Ordinal)) continue;
                ids.Add(id);
                if (ids.Count >= limit) return ids;
            }
        }
        return ids;
    }

    internal static string DecodeGeoPoints(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 24_000_000)
            throw new InvalidDataException("Keep 轨迹无法解码");

        byte[] input;
        try { input = Convert.FromBase64String(value); }
        catch (FormatException) { throw new InvalidDataException("Keep 轨迹无法解码"); }

        foreach (var candidate in Variants(input))
        {
            try
            {
                string json = Encoding.UTF8.GetString(Decompress(candidate));
                using var document = JsonDocument.Parse(json);
                if (document.RootElement.ValueKind != JsonValueKind.Array) continue;
                return json;
            }
            catch (Exception error) when (error is InvalidDataException or IOException or JsonException or
                                              CryptographicException or ArgumentException)
            {
                // Try the next encoding variant; never surface the raw payload.
            }
        }
        throw new InvalidDataException("Keep 轨迹无法解码");
    }

    internal static string BuildActivity(JsonElement data, JsonElement points)
    {
        List<object> normalized = [];
        if (points.ValueKind == JsonValueKind.Array)
        {
            foreach (var point in points.EnumerateArray())
            {
                if (point.ValueKind != JsonValueKind.Object) continue;
                normalized.Add(new
                {
                    timestamp = Number(point, "timestamp"),
                    unixTimestamp = Number(point, "unixTimestamp"),
                    speed = Number(point, "speed"),
                    latitude = Number(point, "latitude"),
                    longitude = Number(point, "longitude"),
                    accuracyRadius = Number(point, "accuracyRadius"),
                    currentTotalDistance = Number(point, "currentTotalDistance"),
                    isPause = Bool(point, "isPause") || Bool(point, "pause")
                });
            }
        }

        return JsonSerializer.Serialize(new
        {
            source = "keep",
            activityId = Text(data, "id"),
            dataType = Text(data, "dataType"),
            startTime = Number(data, "startTime"),
            endTime = Number(data, "endTime"),
            durationS = Number(data, "duration"),
            distanceM = Number(data, "distance"),
            timezone = Text(data, "timezone"),
            points = normalized
        });
    }

    private static IEnumerable<byte[]> Variants(byte[] input)
    {
        byte[]? decrypted = null;
        try
        {
            using var aes = Aes.Create();
            aes.Key = CbcKey;
            decrypted = aes.DecryptCbc(input, CbcIv, PaddingMode.PKCS7);
        }
        catch (CryptographicException) {}
        if (decrypted is not null) yield return decrypted;
        yield return input;
    }

    private static byte[] Decompress(byte[] input)
    {
        using var output = new MemoryStream();
        try
        {
            using var gzip = new GZipStream(new MemoryStream(input), CompressionMode.Decompress);
            CopyLimited(gzip, output);
            return output.ToArray();
        }
        catch (InvalidDataException)
        {
            output.SetLength(0);
        }

        using var zlib = new ZLibStream(new MemoryStream(input), CompressionMode.Decompress);
        CopyLimited(zlib, output);
        return output.ToArray();
    }

    private static void CopyLimited(Stream input, Stream output)
    {
        byte[] buffer = new byte[8192];
        int read;
        while ((read = input.Read(buffer, 0, buffer.Length)) != 0)
        {
            if (output.Length + read > MaxDecodedBytes) throw new InvalidDataException("Keep 轨迹无法解码");
            output.Write(buffer, 0, read);
        }
    }

    private static double? Number(JsonElement value, string name)
    {
        if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty(name, out var field)) return null;
        if (field.ValueKind == JsonValueKind.Number && field.TryGetDouble(out double number)) return number;
        if (field.ValueKind == JsonValueKind.String &&
            double.TryParse(field.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out number)) return number;
        return null;
    }

    private static string Text(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var field) &&
        field.ValueKind == JsonValueKind.String ? field.GetString() ?? "" : "";

    private static bool Bool(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var field) &&
        field.ValueKind == JsonValueKind.True;
}
