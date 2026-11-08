using System.Text.Json;
using Windows.Security.Cryptography;
using Windows.Security.Cryptography.DataProtection;

namespace ShouURun.Desktop;

internal sealed record KeepSession(string Token, string DeviceId, string Label);

internal sealed class KeepSessionStore
{
    private readonly string path = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "ShouURun", "keep-session.v1");

    public async Task<KeepSession?> Load()
    {
        if (!File.Exists(path)) return null;
        if (new FileInfo(path).Length > 65536) throw new InvalidDataException();
        var ciphertext = CryptographicBuffer.CreateFromByteArray(await File.ReadAllBytesAsync(path));
        var plaintext = await new DataProtectionProvider().UnprotectAsync(ciphertext);
        CryptographicBuffer.CopyToByteArray(plaintext, out var bytes);
        try { return JsonSerializer.Deserialize<KeepSession>(bytes); }
        finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(bytes); }
    }

    public async Task Save(KeepSession session)
    {
        byte[] plaintext = JsonSerializer.SerializeToUtf8Bytes(session);
        byte[] encrypted;
        try
        {
            var buffer = CryptographicBuffer.CreateFromByteArray(plaintext);
            var ciphertext = await new DataProtectionProvider("LOCAL=user").ProtectAsync(buffer);
            CryptographicBuffer.CopyToByteArray(ciphertext, out encrypted);
        }
        finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(plaintext); }

        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await File.WriteAllBytesAsync(temporary, encrypted);
            File.Move(temporary, path, overwrite: true);
        }
        finally { File.Delete(temporary); }
    }

    public void Clear()
    {
        try { File.Delete(path); }
        catch (DirectoryNotFoundException) {}
    }
}
