param([string]$ChatKey = 'ENTER', [switch]$NoSend, [switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
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
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern short VkKeyScanEx(char ch, IntPtr layout);
    [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint thread);
    [DllImport("user32.dll")] static extern uint MapVirtualKeyEx(uint code, uint type, IntPtr layout);
    public static int[] Plan(string text) {
        IntPtr layout = GetKeyboardLayout(0);
        int[] result = new int[text.Length];
        for (int i = 0; i < text.Length; i++) {
            short code = VkKeyScanEx(text[i], layout);
            if (text[i] < 32 || text[i] > 126 || code == -1 || (code & 0xFE00) != 0)
                throw new Exception("Unsupported character for keyboard layout; nothing typed.");
            result[i] = code;
        }
        return result;
    }
    static void Scan(IntPtr target, ushort vk, bool up) {
        if (!up && !IsLMU(target)) throw new Exception("LMU must be the foreground window.");
        ushort scan = (ushort)MapVirtualKeyEx(vk, 0, GetKeyboardLayout(0));
        if (scan == 0) throw new Exception("Unsupported scan code.");
        INPUT input = new INPUT(); input.type = 1;
        input.data.keyboard.scan = scan; input.data.keyboard.flags = 8u | (up ? 2u : 0u);
        if (SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1)
            throw new Exception("Windows rejected typed input.");
    }
    public static void Type(IntPtr target, int code) {
        ushort vk = (ushort)(code & 255);
        bool shift = (code & 256) != 0;
        // Caps Lock reverses the shift needed for alphabetic keys.
        if (vk >= 65 && vk <= 90 && (System.Windows.Forms.Control.IsKeyLocked(System.Windows.Forms.Keys.CapsLock))) shift = !shift;
        try {
            if (shift) Scan(target, 16, false);
            Scan(target, vk, false);
            System.Threading.Thread.Sleep(15);
        } finally {
            Scan(target, vk, true);
            if (shift) Scan(target, 16, true);
        }
        System.Threading.Thread.Sleep(15);
    }
    public static bool IsLMU(IntPtr target) {
        if (target == IntPtr.Zero || GetForegroundWindow() != target) return false;
        uint pid; GetWindowThreadProcessId(target, out pid);
        try { return Process.GetProcessById((int)pid).ProcessName == "Le Mans Ultimate"; }
        catch { return false; }
    }
    public static void Key(IntPtr target, ushort code, bool up) {
        Scan(target, code, up);
    }
    public static void Release(ushort code) {
        Scan(IntPtr.Zero, code, true);
    }
}
'@

# Read expected text privately from stdin; never read arbitrary clipboard text
# into chat. The caller expires and consumes each draft. Chat must start closed.
[Console]::InputEncoding = [Text.Encoding]::UTF8
$expected = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($expected) -or $expected.Length -gt 240) { throw 'Transcript must contain 1-240 characters.' }
$plan = [SottoLMUInput]::Plan($expected)
if ($ValidateOnly) { Write-Output "Validated $($plan.Length) characters; no keys sent."; exit 0 }
$target = [SottoLMUInput]::GetForegroundWindow()
if (-not [SottoLMUInput]::IsLMU($target)) { throw 'LMU must be the foreground window.' }
if ([string]::IsNullOrWhiteSpace($expected) -or [Windows.Forms.Clipboard]::GetText() -cne $expected) {
    throw 'Clipboard changed; paste cancelled.'
}
if ($ChatKey -ne 'NONE' -and $ChatKey -notmatch '^(ENTER|[A-Za-z0-9])$') { throw 'Invalid chat key.' }
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
    $code = if ($ChatKey -eq 'ENTER') { [UInt16]13 } else { [UInt16][char]$ChatKey.ToUpperInvariant() }
    try { [SottoLMUInput]::Key($target, $code, $false); Start-Sleep -Milliseconds 30 }
    finally { [SottoLMUInput]::Release($code) }
    Start-Sleep -Milliseconds 300
}
if ([Windows.Forms.Clipboard]::GetText() -cne $expected) { throw 'Clipboard changed; paste cancelled.' }
foreach ($character in $plan) {
    if ([Windows.Forms.Clipboard]::GetText() -cne $expected) { throw 'Clipboard changed; typing cancelled.' }
    foreach ($modifier in @(17,18)) {
        if (([SottoLMUInput]::GetAsyncKeyState($modifier) -band 0x8000) -ne 0) { throw 'Modifier held; typing cancelled.' }
    }
    [SottoLMUInput]::Type($target, $character)
}
if ($NoSend) { exit 0 }
# Enter sends and closes LMU chat. Never issue a second close/toggle key.
Start-Sleep -Milliseconds 200
if ([Windows.Forms.Clipboard]::GetText() -cne $expected) { throw 'Clipboard changed; send cancelled.' }
try {
    [SottoLMUInput]::Key($target, 13, $false)
    Start-Sleep -Milliseconds 30
} finally {
    [SottoLMUInput]::Release(13)
}