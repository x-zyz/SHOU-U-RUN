using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ShouURun.Desktop;

static void Check(bool value, string name)
{
    if (!value) throw new Exception("FAILED: " + name);
    Console.WriteLine("PASS " + name);
}

static byte[] Gzip(string value)
{
    using var output = new MemoryStream();
    using (var gzip = new GZipStream(output, CompressionLevel.Optimal, leaveOpen: true))
        gzip.Write(Encoding.UTF8.GetBytes(value));
    return output.ToArray();
}

static string Encrypted(string value)
{
    using var aes = Aes.Create();
    aes.Key = Encoding.ASCII.GetBytes("56fe59;82g:d873c");
    var iv = Encoding.ASCII.GetBytes("2346892432920300");
    return Convert.ToBase64String(aes.EncryptCbc(Gzip(value), iv, PaddingMode.PKCS7));
}

const string pointsJson = """
    [{"latitude":30.1,"longitude":121.2,"timestamp":0,"speed":9,"currentTotalDistance":0,"accuracyRadius":0,"isPause":false}]
    """;

var decoded = KeepImporter.DecodeGeoPoints(Encrypted(pointsJson));
using (var document = JsonDocument.Parse(decoded))
    Check(document.RootElement.GetArrayLength() == 1, "decrypts AES-CBC + gzip geoPoints");

var direct = Convert.ToBase64String(Gzip(pointsJson));
using (var document = JsonDocument.Parse(KeepImporter.DecodeGeoPoints(direct)))
    Check(document.RootElement.GetArrayLength() == 1, "accepts unencrypted gzip geoPoints");

using (var list = JsonDocument.Parse("""
    {"records":[{"logs":[{"stats":{"id":"run_1","isDoubtful":false}},{"stats":{"id":"run_2","isDoubtful":true}}]}]}
    """))
{
    var candidates = KeepImporter.Candidates(list.RootElement, 8);
    Check(candidates.Count == 1 && candidates[0] == "run_1", "filters doubtful and keeps ids");
}

using (var detail = JsonDocument.Parse("""
    {"id":"run_1","dataType":"outdoorRunning","startTime":1767225600000,"endTime":1767225660000,
     "duration":60,"distance":150,"timezone":"Asia/Shanghai"}
    """))
using (var points = JsonDocument.Parse(decoded))
{
    string activity = KeepImporter.BuildActivity(detail.RootElement, points.RootElement);
    using var document = JsonDocument.Parse(activity);
    var root = document.RootElement;
    Check(root.GetProperty("source").GetString() == "keep", "build keeps source marker");
    Check(root.GetProperty("dataType").GetString() == "outdoorRunning", "build keeps data type");
    Check(root.GetProperty("points").GetArrayLength() == 1, "build keeps one point");
    Check(root.GetProperty("points")[0].GetProperty("unixTimestamp").ValueKind == JsonValueKind.Null,
        "build preserves missing fields as null");
    Check(!activity.Contains("geoPoints") && !activity.Contains("token"), "build contains no raw fields");
}


using (var run = JsonDocument.Parse("""
    {"vendor":{"genre":"FileImport"},"dataType":"outdoorRunning","startTime":1767225600000,
     "endTime":1767225660000,"duration":60,"distance":150,"privacy":true,
     "geoPoints":[{"latitude":30.1,"longitude":121.2,"unixTimestamp":1767225600000,"timestamp":0},
      {"latitude":30.2,"longitude":121.3,"unixTimestamp":1767225660000,"timestamp":600}],
     "heartRate":{"heartRates":[{"timeAxis":10,"timestamp":17672256001,"beatsPerMinute":144}]}}
    """))
using (var converted = JsonDocument.Parse(KeepFileImports.Rebuild(run.RootElement, "synthetic-user")))
{
    var root = converted.RootElement;
    Check(root.GetProperty("startTime").GetInt64() == 1767225585000 &&
          root.GetProperty("endTime").GetInt64() == 1767225645000, "shifts start and end exactly 15 seconds");
    Check(root.GetProperty("vendor").GetProperty("deviceModel").GetString() == "Keep App", "uses the existing payload source");
    Check(root.GetProperty("distance").GetDouble() == 150 && root.GetProperty("duration").GetInt32() == 60 &&
          root.GetProperty("privacy").GetBoolean(), "preserves original duration, distance and privacy");
    using var geo = JsonDocument.Parse(KeepImporter.DecodeGeoPoints(root.GetProperty("geoPoints").GetString()!));
    Check(geo.RootElement[1].GetProperty("unixTimestamp").GetInt64() == 1767225645000 &&
          geo.RootElement[1].GetProperty("timestamp").GetInt32() == 600 &&
          geo.RootElement[1].GetProperty("longitude").GetDouble() == 121.3, "shifts only absolute GPS time");
    var heart = root.GetProperty("heartRate").GetProperty("heartRates")[0];
    Check(heart.GetProperty("timestamp").GetInt64() == 17672255851 &&
          heart.GetProperty("timeAxis").GetInt32() == 10 && heart.GetProperty("beatsPerMinute").GetInt32() == 144,
          "shifts absolute deciseconds and keeps relative heart-rate samples");
}
using (var nativeRun = JsonDocument.Parse("""{"vendor":{"genre":"App","deviceModel":"Keep App"}}"""))
    Check(!KeepFileImports.IsFileImport(nativeRun.RootElement), "does not select native Keep runs");
using (var page = JsonDocument.Parse("""{"lastTimestamp":12345}"""))
    Check(KeepFileImports.Cursor(page.RootElement) == 12345, "reads the next history cursor");
Console.WriteLine("decoder and conversion tests passed");

namespace ShouURun.Desktop
{
    internal sealed class KeepException(string message) : Exception(message);
    internal static class KeepClient
    {
        internal static JsonElement Property(JsonElement value, string key) =>
            value.ValueKind == JsonValueKind.Object && value.TryGetProperty(key, out var property) ? property : default;
        internal static string Json<T>(T value) => JsonSerializer.Serialize(value);
        internal static byte[] Gzip(string value)
        {
            using var output = new MemoryStream();
            using (var gzip = new GZipStream(output, CompressionLevel.Optimal, leaveOpen: true))
                gzip.Write(Encoding.UTF8.GetBytes(value));
            return output.ToArray();
        }
        internal static string EncryptCbc(byte[] input)
        {
            using var aes = Aes.Create();
            aes.Key = Encoding.ASCII.GetBytes("56fe59;82g:d873c");
            return Convert.ToBase64String(aes.EncryptCbc(input, Encoding.ASCII.GetBytes("2346892432920300"), PaddingMode.PKCS7));
        }
    }
}
