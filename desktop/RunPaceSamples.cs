using System.Text.Json;

namespace ShouURun.Desktop;

/// <summary>Extracts the same five-second GPS speed windows as the Android recorder.</summary>
internal static class RunPaceSamples
{
    private const int MaxWindows = 2160;
    internal const int MaxFiles = 20;

    public static List<List<List<double>>> Read(IEnumerable<string> paths, CancellationToken cancellation)
    {
        List<List<List<double>>> runs = [];
        int remaining = MaxWindows;
        foreach (string path in paths.Distinct(StringComparer.OrdinalIgnoreCase).Take(MaxFiles))
        {
            cancellation.ThrowIfCancellationRequested();
            if (remaining < 3) break;
            try
            {
                using var file = File.OpenRead(path);
                if (file.Length is 0 or > 4 * 1024 * 1024) continue;
                using var reader = new StreamReader(file);
                var segments = ReadRun(reader, remaining, cancellation);
                int count = segments?.Sum(segment => segment.Count) ?? 0;
                if (segments is null || count < 3) continue;
                runs.Add(segments);
                remaining -= count;
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
            {
                // A malformed or unreadable file does not discard the other selected runs.
            }
        }
        return runs;
    }

    private static List<List<double>>? ReadRun(StreamReader reader, int limit, CancellationToken cancellation)
    {
        string? line = reader.ReadLine();
        if (line is null) return null;
        using var first = JsonDocument.Parse(line);
        var header = first.RootElement;
        if (Text(header, "type") != "session" || Text(header, "schema") != "shou.real-gps.v1" ||
            Text(header, "source") != "android_gps" || Property(header, "synthetic").ValueKind != JsonValueKind.False) return null;

        List<List<double>> segments = [];
        List<double> segment = [];
        double lastTime = -1, lastSpeed = 0, seconds = 0, distance = 0;
        int count = 0;
        bool paused = false;
        void Split()
        {
            if (segment.Count > 0)
            {
                segments.Add(segment);
                segment = [];
            }
            seconds = distance = 0;
        }
        while ((line = reader.ReadLine()) is not null)
        {
            cancellation.ThrowIfCancellationRequested();
            using var document = JsonDocument.Parse(line);
            var point = document.RootElement;
            string type = Text(point, "type");
            if (type == "completed")
            {
                Split();
                return segments;
            }
            if (type is "interrupted" or "error") return null;
            if (type == "pause") paused = true;
            if (type == "resume") paused = false;
            if (count >= limit) continue;
            double time = Number(point, "elapsed_ns") / 1e9;
            double speed = Number(point, "speed_mps"), accuracy = Number(point, "accuracy_m");
            double speedAccuracy = Number(point, "speed_accuracy_mps");
            bool valid = !paused && type == "fix" && Property(point, "mock").ValueKind == JsonValueKind.False &&
                Text(point, "provider") == "gps" && double.IsFinite(time) && time > 0 &&
                speed is >= 1 and <= 6.5 && accuracy is > 0 and <= 35 &&
                (double.IsNaN(speedAccuracy) || speedAccuracy is >= 0 and <= 1);
            double dt = time - lastTime;
            if (!valid || lastTime < 0 || dt <= 0 || dt > 3) Split();
            else
            {
                double average = (speed + lastSpeed) / 2, used = Math.Min(dt, 5 - seconds);
                seconds += used;
                distance += used * average;
                if (seconds >= 5)
                {
                    segment.Add(Math.Round(distance / 5, 3, MidpointRounding.AwayFromZero));
                    count++;
                    seconds = dt - used;
                    distance = seconds * average;
                }
            }
            lastTime = valid ? time : -1;
            lastSpeed = speed;
        }
        return null;
    }

    private static JsonElement Property(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var result) ? result : default;
    private static string Text(JsonElement value, string name) =>
        Property(value, name) is { ValueKind: JsonValueKind.String } text ? text.GetString() ?? "" : "";
    private static double Number(JsonElement value, string name) =>
        Property(value, name) is { ValueKind: JsonValueKind.Number } number && number.TryGetDouble(out var result) ? result : double.NaN;
}
