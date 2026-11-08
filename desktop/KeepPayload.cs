using System.Text.Json;

namespace ShouURun.Desktop;

internal static class KeepPayload
{
    internal static object AppVendor() => new { source = "keep", manufacturer = "keep", genre = "App", deviceModel = "Keep App", vendorRecordId = (string?)null };

    public static string Build(JsonElement activity, string uid)
    {
        var points = KeepClient.Property(activity, "points");
        if (points.ValueKind != JsonValueKind.Array || points.GetArrayLength() is < 2 or > 72_000)
            throw new KeepException("轨迹点数量无效或记录过大。");

        long start = Timestamp(points[0]), end = Timestamp(points[points.GetArrayLength() - 1]);
        double distance = Number(activity, "distance");
        double duration = Number(activity, "duration");
        if (!(distance > 0 && distance < 200_000 && duration > 0 && duration < 86_400 && end > start))
            throw new KeepException("运动距离或时间无效。");

        var geo = new List<Dictionary<string, object?>>();
        var steps = new List<Dictionary<string, object?>>();
        var hearts = new List<object>();
        int calories = Math.Max(1, (int)Round(distance * 0.072));
        double cumulativeSteps = 0, previousElapsed = 0, previousAltitude = 0;
        long ascent = 0;
        foreach (var point in points.EnumerateArray())
        {
            bool first = geo.Count == 0;
            long time = Timestamp(point);
            double elapsed = (time - start) / 1000.0;
            double lat = Number(point, "lat"), lon = Number(point, "lon");
            if (!double.IsFinite(lat) || !double.IsFinite(lon) || Math.Abs(lat) > 90 || Math.Abs(lon) > 180 || elapsed < previousElapsed)
                throw new KeepException("轨迹坐标或时间无效。");
            double cadence = Number(point, "cadence", 160), speed = Number(point, "speed", 2.2);
            double altitude = Number(point, "altitude", 0), traveled = Number(point, "distance", 0);
            if (!first)
            {
                cumulativeSteps += Math.Max(0, cadence) * (elapsed - previousElapsed) / 60;
                ascent += Math.Max(0, Round(altitude - previousAltitude));
            }
            previousElapsed = elapsed;
            previousAltitude = altitude;

            long ticks = Round(elapsed * 10);
            var common = new Dictionary<string, object?>
            {
                ["timestamp"] = ticks,
                ["unixTimestamp"] = time,
                ["currentTotalDuration"] = Round(elapsed),
                ["currentTotalDistance"] = Round(traveled * 100) / 100.0,
                ["currentTotalSteps"] = Round(cumulativeSteps),
                ["currentTotalCalories"] = Round(calories * Math.Max(0, traveled) / distance),
                ["isPause"] = false
            };
            steps.Add(common);

            (lat, lon) = Gcj02(lat, lon);
            geo.Add(new Dictionary<string, object?>(common)
            {
                ["latitude"] = lat,
                ["longitude"] = lon,
                ["altitude"] = altitude,
                ["pressure"] = 0,
                ["accuracyRadius"] = 0,
                ["crossKmMark"] = 0,
                ["currentPace"] = first || speed <= 0 ? 0 : Round(1000 / speed),
                ["locationType"] = 1,
                ["speed"] = first ? 0 : Round(speed * 36_000) / 10_000.0,
                ["flags"] = null,
                ["isStepPoint"] = false,
                ["verticalAccuracy"] = 0,
                ["processLabel"] = 0,
                ["bearing"] = 0,
                ["ctuh"] = 250,
                ["ctud"] = 250,
                ["ctdh"] = 250,
                ["ctdd"] = 250,
                ["sr"] = Round(cadence),
                ["sa"] = first ? null : Round(speed * 6000 / Math.Max(1, cadence)) / 100.0,
                ["hs"] = null,
                ["gctd"] = 250,
                ["gctt"] = 100,
                ["ss"] = null,
                ["stepPoint"] = false,
                ["pause"] = false
            });
            long bpm = Round(Number(point, "hr", 120));
            hearts.Add(first ? (object)new { beatsPerMinute = bpm } : new { timestamp = ticks, timeAxis = ticks, beatsPerMinute = bpm });
        }

        long totalSteps = Round(cumulativeSteps);
        string empty = Compress(Array.Empty<object>());
        return KeepClient.Json(new
        {
            userID = uid,
            startTime = start,
            endTime = end,
            distance = Round(distance * 100) / 100.0,
            duration = Round(duration),
            totalSteps,
            averageStepFrequency = totalSteps * 60 / duration,
            trainType = "run",
            type = "run",
            subtype = "normal",
            dataType = "outdoorRunning",
            timezone = "Asia/Shanghai",
            clientVersion = "9.1.80",
            trainingSource = "RunningHelper",
            privacy = false,
            geoPoints = KeepClient.EncryptCbc(KeepClient.Gzip(KeepClient.Json(geo))),
            stepPoints = Compress(steps),
            crossKmPoints = Array.Empty<object>(),
            specialDistancePoints = Array.Empty<object>(),
            flags = new[] { 421, 95043, 90, 90, 90 },
            constantVersion = "130.40",
            vendor = AppVendor(),
            distanceSample = empty,
            calorieSample = empty,
            actionSample = empty,
            stepLengthAndFrequency = empty,
            calorie = calories,
            accumulativeUpliftedHeight = ascent,
            heartRate = new { heartRates = Compress(hearts) }
        });
    }

    private static string Compress<T>(T value) => Convert.ToBase64String(KeepClient.Gzip(KeepClient.Json(value)));
    private static long Round(double value) => (long)Math.Floor(value + 0.5);
    private static double Number(JsonElement item, string key, double fallback = double.NaN) =>
        KeepClient.Property(item, key) is { ValueKind: JsonValueKind.Number } number &&
        number.TryGetDouble(out double value) && double.IsFinite(value) ? value : fallback;

    private static long Timestamp(JsonElement point) =>
        KeepClient.Property(point, "time") is { ValueKind: JsonValueKind.Number } time && time.TryGetInt64(out long value)
        ? value : throw new KeepException("轨迹时间无效。");

    private static (double Latitude, double Longitude) Gcj02(double lat, double lon)
    {
        if (lon is < 72.004 or > 137.8347 || lat is < 0.8293 or > 55.8271) return (lat, lon);
        double x = lon - 105, y = lat - 35, pi = Math.PI;
        double baseWave = (20 * Math.Sin(6 * x * pi) + 20 * Math.Sin(2 * x * pi)) * 2 / 3;
        double dLat = -100 + 2*x + 3*y + .2*y*y + .1*x*y + .2*Math.Sqrt(Math.Abs(x)) + baseWave;
        dLat += (20*Math.Sin(y*pi) + 40*Math.Sin(y*pi/3) + 160*Math.Sin(y*pi/12) + 320*Math.Sin(y*pi/30)) * 2 / 3;
        double dLon = 300 + x + 2*y + .1*x*x + .1*x*y + .1*Math.Sqrt(Math.Abs(x)) + baseWave;
        dLon += (20*Math.Sin(x*pi) + 40*Math.Sin(x*pi/3) + 150*Math.Sin(x*pi/12) + 300*Math.Sin(x*pi/30)) * 2 / 3;
        double rad = lat / 180 * pi;
        double magic = 1 - .00669342162296594323 * Math.Sin(rad) * Math.Sin(rad);
        double sqrt = Math.Sqrt(magic);
        return (
            lat + dLat * 180 / (6335552.717000426 / (magic * sqrt) * pi),
            lon + dLon * 180 / (6378245.0 / sqrt * Math.Cos(rad) * pi)
        );
    }
}
