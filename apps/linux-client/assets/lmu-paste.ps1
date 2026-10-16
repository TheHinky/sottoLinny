param([string]$ChatKey = 'NONE')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class SottoLMUInput {
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION data; }
    [StructLayout(LayoutKind.Explicit)] public struct UNION {
        [FieldOffset(0)] public KEYBDINPUT keyboard;
        [FieldOffset(0)] public MOUSEINPUT mouse;
    }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
        public ushort vk, scan; public uint flags, time; public UIntPtr extra;
    }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
        public int x, y; public uint data, flags, time; public UIntPtr extra;
    }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    public static bool IsLMU(IntPtr target) {
        if (target == IntPtr.Zero || GetForegroundWindow() != target) return false;
        uint pid; GetWindowThreadProcessId(target, out pid);
        try { return Process.GetProcessById((int)pid).ProcessName == "Le Mans Ultimate"; }
        catch { return false; }
    }
    public static void Key(IntPtr target, ushort code, bool up) {
        if (!IsLMU(target)) throw new Exception("LMU must be the foreground window.");
        INPUT input = new INPUT(); input.type = 1;
        input.data.keyboard.vk = code; input.data.keyboard.flags = up ? 2u : 0u;
        if (SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1)
            throw new Exception("Windows rejected keyboard input.");
    }
    public static void Release(ushort code) {
        INPUT input = new INPUT(); input.type = 1;
        input.data.keyboard.vk = code; input.data.keyboard.flags = 2;
        SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT)));
    }
}
'@

# Read expected text privately from stdin; never read arbitrary clipboard text
# into chat, and never press Enter. The caller expires and consumes each draft.
[Console]::InputEncoding = [Text.Encoding]::UTF8
$expected = [Console]::In.ReadToEnd()
$target = [SottoLMUInput]::GetForegroundWindow()
if (-not [SottoLMUInput]::IsLMU($target)) { throw 'LMU must be the foreground window.' }
if ([string]::IsNullOrWhiteSpace($expected) -or [Windows.Forms.Clipboard]::GetText() -cne $expected) {
    throw 'Clipboard changed; paste cancelled.'
}
if ($ChatKey -ne 'NONE' -and $ChatKey -notmatch '^[A-Za-z0-9]$') { throw 'Invalid chat key.' }
# Wait for the trigger chord to be released; never release user-held controls.
$deadline = [DateTime]::UtcNow.AddSeconds(2)
do {
    $held = $false
    foreach ($key in @(16,17,18,122)) {
        if (([SottoLMUInput]::GetAsyncKeyState($key) -band 0x8000) -ne 0) { $held = $true }
    }
    if ($held) { Start-Sleep -Milliseconds 20 }
} while ($held -and [DateTime]::UtcNow -lt $deadline)
if ($held) { throw 'Release the shortcut keys before pasting.' }
if ($ChatKey -ne 'NONE') {
    $code = [ushort][char]$ChatKey.ToUpperInvariant()
    try { [SottoLMUInput]::Key($target, $code, $false) }
    finally { [SottoLMUInput]::Release($code) }
    Start-Sleep -Milliseconds 300
}
if ([Windows.Forms.Clipboard]::GetText() -cne $expected) { throw 'Clipboard changed; paste cancelled.' }
try {
    [SottoLMUInput]::Key($target, 17, $false)
    [SottoLMUInput]::Key($target, 86, $false)
} finally {
    [SottoLMUInput]::Release(86)
    [SottoLMUInput]::Release(17)
}
