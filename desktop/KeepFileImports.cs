using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ShouURun.Desktop;

internal static class KeepFileImports
{
    private static readonly string[] SourceKeys = ["source", "sourceName", "sourceLabel", "genre", "deviceModel", "trainingSource"];

    internal static bool IsFileImport(JsonElement record)
    {
        foreach (var item in new[] { record, KeepClient.Property(record, "vendor") })
        {
            foreach (string name in SourceKeys)
            {
                var field = KeepClient.Property(item, name);
                if (field.ValueKind != JsonValueKind.String) continue;
                string value = field.GetString()?.Trim() ?? "";
                if (value is "数据文件导入" or "运动数据文件导入") return true;
                string compact = string.Concat(value.Where(char.IsAsciiLetterOrDigit)).ToLowerInvariant();
                if (compact is "fileimport" or "importfile" or "datafileimport" or "sportdatafileimport")
                    return true;
            }
        }
        return false;
    }

    internal static long Cursor(JsonElement page)
    {
        var cursor = KeepClient.Property(page, "lastTimestamp");
        if (cursor.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) return 0;
        if (long.TryParse(cursor.ToString(), NumberStyles.None, CultureInfo.InvariantCulture, out long number))
            return number;
        throw new KeepException("Keep 历史分页游标无效。");
    }

    private static readonly string[] PayloadFields = [
        "distance", "duration", "totalSteps", "averageStepFrequency", "timezone", "privacy",
        "stepPoints", "crossKmPoints", "specialDistancePoints", "distanceSample", "calorieSample",
        "actionSample", "stepLengthAndFrequency", "calorie", "accumulativeUpliftedHeight", "heartRate"
    ];
    private static readonly string[] CompressedFields = [
        "stepPoints", "distanceSample", "calorieSample", "actionSample", "stepLengthAndFrequency", "heartRates"
    ];

    internal static string Rebuild(JsonElement run, string owner)
    {
        if (!IsFileImport(run)) throw new KeepException("记录的文件导入来源无法确认。");
        long start = RequiredTime(run, "startTime"), end = RequiredTime(run, "endTime");
        if (end <= start || end - start > 86_400_000)
            throw new KeepException("记录起止时间无效。");
        foreach (string key in new[] { "distance", "duration" })
        {
            var value = KeepClient.Property(run, key);
            if (value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out var number) ||
                !double.IsFinite(number) || number <= 0)
                throw new KeepException("记录距离或时长无效。");
        }

        var encoded = KeepClient.Property(run, "geoPoints");
        var points = encoded.ValueKind switch
        {
            JsonValueKind.Array => JsonNode.Parse(encoded.GetRawText()) as JsonArray,
            JsonValueKind.String => JsonNode.Parse(KeepImporter.DecodeGeoPoints(encoded.GetString()!)) as JsonArray,
            _ => null
        };
        if (points is null || points.Count is < 2 or > 72_000)
            throw new KeepException("记录缺少可用轨迹。");
        ShiftTimes(points, start, end);

        JsonObject payload = new()
        {
            ["userID"] = owner,
            ["startTime"] = start - 15_000,
            ["endTime"] = end - 15_000,
            ["trainType"] = "run",
            ["type"] = "run",
            ["subtype"] = "normal",
            ["dataType"] = "outdoorRunning",
            ["clientVersion"] = "9.1.80",
            ["trainingSource"] = "RunningHelper",
            ["constantVersion"] = "130.40",
            ["flags"] = JsonSerializer.SerializeToNode(new[] { 421, 95043, 90, 90, 90 }),
            ["vendor"] = JsonSerializer.SerializeToNode(KeepPayload.AppVendor()),
            ["geoPoints"] = KeepClient.EncryptCbc(KeepClient.Gzip(KeepClient.Json(points)))
        };
        foreach (string field in PayloadFields)
        {
            var raw = KeepClient.Property(run, field);
            if (raw.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) continue;
            payload[field] = JsonNode.Parse(raw.GetRawText());
        }
        foreach (string field in PayloadFields)
        {
            if (payload[field] is not { } value) continue;
            if (CompressedFields.Contains(field))
            {
                var shifted = ShiftCompressed(value, start, end);
                if (!ReferenceEquals(shifted, value)) payload[field] = shifted;
            }
            else if (field == "heartRate" && value is JsonObject heart && heart["heartRates"] is { } samples)
            {
                var shifted = ShiftCompressed(samples, start, end);
                if (!ReferenceEquals(shifted, samples)) heart["heartRates"] = shifted;
            }
            else
                ShiftTimes(value, start, end);
        }
        payload["timezone"] ??= "Asia/Shanghai";
        payload["privacy"] ??= true;
        payload["crossKmPoints"] ??= new JsonArray();
        payload["specialDistancePoints"] ??= new JsonArray();
        return KeepClient.Json(payload);
    }

    private static JsonNode ShiftCompressed(JsonNode value, long start, long end)
    {
        if (value is JsonValue scalar && scalar.TryGetValue<string>(out string? text))
        {
            if (string.IsNullOrWhiteSpace(text)) return value;
            var decoded = JsonNode.Parse(KeepImporter.DecodeGeoPoints(text))
                ?? throw new InvalidDataException("无法读取采样字段。");
            ShiftTimes(decoded, start, end);
            return JsonValue.Create(Convert.ToBase64String(KeepClient.Gzip(KeepClient.Json(decoded))));
        }
        ShiftTimes(value, start, end);
        return value;
    }

    private static void ShiftTimes(JsonNode? node, long start, long end)
    {
        if (node is JsonArray array)
        {
            foreach (var item in array) ShiftTimes(item, start, end);
        }
        else if (node is JsonObject obj)
        {
            foreach (string key in obj.Select(item => item.Key).ToArray())
            {
                if ((key is "timestamp" or "unixTimestamp" or "timeAxis" or "time" or "startTime" or "endTime") &&
                    obj[key] is JsonValue value)
                {
                    bool isString = value.TryGetValue<string>(out var text);
                    long stamp;
                    if (isString
                        ? !long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out stamp)
                        : !value.TryGetValue<long>(out stamp))
                        continue;
                    foreach (long scale in new long[] { 1, 100, 1000 })
                    {
                        if (stamp < (start - 86_400_000) / scale || stamp > (end + 86_400_000) / scale) continue;
                        long shifted = stamp - 15_000 / scale;
                        obj[key] = isString ? JsonValue.Create(shifted.ToString(CultureInfo.InvariantCulture)) : JsonValue.Create(shifted);
                        break;
                    }
                }
                else
                {
                    ShiftTimes(obj[key], start, end);
                }
            }
        }
    }

    private static long RequiredTime(JsonElement run, string key)
    {
        if (KeepClient.Property(run, key) is { ValueKind: JsonValueKind.Number } time &&
            time.TryGetInt64(out long value) && value is >= 978307200000 and < 4102444800000) return value;
        throw new KeepException("记录缺少有效的绝对时间。");
    }
}
