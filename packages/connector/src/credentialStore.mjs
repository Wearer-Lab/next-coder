import { spawn } from "node:child_process";
import * as nodeFs from "node:fs/promises";
import { createHash } from "node:crypto";
import { platform as currentPlatform } from "node:os";
import { join, resolve } from "node:path";

// The native store namespace. A credential written before the rename lives under the legacy
// service, so reads fall back to it and deletes clean both; writes only ever use the current one.
export const CREDENTIAL_SERVICE = "com.next-coder.connector";
export const LEGACY_CREDENTIAL_SERVICE = "com.agent-controller.connector";
export const CREDENTIAL_STORE_VERSION = 1;

const COMMAND_TIMEOUT_MS = 5_000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const MAX_SECRET_BYTES = 2_560;

export async function createCredentialStore({
  platform = currentPlatform(),
  env = process.env,
  fs = nodeFs,
  run = runCredentialCommand,
  findExecutable = null,
} = {}) {
  if (platform === "darwin") {
    const executable = "/usr/bin/security";
    if (!(await executableExists(executable, fs))) return fileFallback("macOS Keychain command is unavailable");
    return nativeStore({ backend: "macos-keychain", platform, executable, env, run });
  }
  if (platform === "linux") {
    // Credential-bearing stdin is sent only to a fixed system installation,
    // never to an executable selected through a user-controlled PATH.
    const executable = findExecutable ? await findExecutable("secret-tool", { fs, env }) : await findLinuxSecretTool(fs);
    if (!executable) return fileFallback("Secret Service client is unavailable");
    if (!hasSecretServiceSession(env)) return fileFallback("Secret Service session is unavailable");
    return nativeStore({ backend: "linux-secret-service", platform, executable, env, run });
  }
  if (platform === "win32") {
    const root = env.SystemRoot || env.WINDIR || "C:\\Windows";
    const executable = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (!(await executableExists(executable, fs))) return fileFallback("Windows PowerShell credential adapter is unavailable");
    return nativeStore({ backend: "windows-credential-manager", platform, executable, env, run });
  }
  return fileFallback(`no native credential store adapter exists for ${platform}`);
}

export function credentialAccounts(stateDir, connectorId, rotationId = null) {
  const installation = createHash("sha256").update(resolve(stateDir)).digest("hex").slice(0, 32);
  const connector = createHash("sha256").update(String(connectorId)).digest("hex").slice(0, 32);
  const prefix = `installation:${installation}:connector:${connector}`;
  return {
    primaryA: `${prefix}:standing:a`,
    primaryB: `${prefix}:standing:b`,
    pending: rotationId == null ? null : `${prefix}:rotation:${createHash("sha256").update(String(rotationId)).digest("hex").slice(0, 32)}`,
  };
}

export async function runCredentialCommand(file, args, {
  input = "",
  env = process.env,
  timeoutMs = COMMAND_TIMEOUT_MS,
  maxOutputBytes = MAX_COMMAND_OUTPUT_BYTES,
  allowFailure = false,
} = {}) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) throw credentialError("Credential command arguments are invalid.", "CREDENTIAL_COMMAND_INVALID");
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(file, args, { env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(result);
    };
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill();
        finish(credentialError("Credential command exceeded its output limit.", "CREDENTIAL_COMMAND_OUTPUT"));
      } else target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", () => finish(credentialError("Credential command could not be started.", "CREDENTIAL_COMMAND_START")));
    child.once("close", (code) => {
      const result = { code: Number(code), stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === 0 || allowFailure) finish(null, result);
      else finish(credentialError("Native credential store operation failed.", "CREDENTIAL_STORE_OPERATION"));
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(credentialError("Native credential store operation timed out.", "CREDENTIAL_STORE_TIMEOUT"));
    }, timeoutMs);
    timer.unref?.();
    child.stdin.once("error", () => {});
    child.stdin.end(input);
  });
}

function nativeStore({ backend, platform, executable, env, run }) {
  return {
    version: CREDENTIAL_STORE_VERSION,
    backend,
    native: true,
    fallbackReason: null,
    async write(account, secret) {
      validateAccount(account);
      validateSecret(secret);
      if (platform === "darwin") {
        // A bare -w prompts through the controlling terminal; piped stdin can silently store an
        // empty password. Feed security's own interactive command parser instead, using hex data
        // so credential characters cannot become commands. Nothing sensitive enters process argv.
        const quotedAccount = `"${account.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
        const input = `add-generic-password -a ${quotedAccount} -s ${CREDENTIAL_SERVICE} -U -X ${Buffer.from(secret, "utf8").toString("hex")}\n`;
        await run(executable, ["-i"], { input, env });
      } else if (platform === "linux") {
        await run(executable, ["store", `--label=Next Coder connector (${account})`, "service", CREDENTIAL_SERVICE, "account", account], { input: secret, env });
      } else {
        await runWindows(executable, env, run, "write", account, secret);
      }
    },
    async read(account) {
      validateAccount(account);
      for (const service of [CREDENTIAL_SERVICE, LEGACY_CREDENTIAL_SERVICE]) {
        let result;
        if (platform === "darwin") result = await run(executable, ["find-generic-password", "-a", account, "-s", service, "-w"], { env, allowFailure: true });
        else if (platform === "linux") result = await run(executable, ["lookup", "service", service, "account", account], { env, allowFailure: true });
        else {
          const value = await runWindows(executable, env, run, "read", account, "", `${service}/${account}`);
          if (value != null) return value;
          continue;
        }
        if (result.code === 0) {
          const secret = stripOneLineEnding(result.stdout);
          validateSecret(secret);
          return secret;
        }
        // A miss is the only reason to try the next service name; anything else is a real failure.
        if (platform === "darwin" ? macosNotFound(result) : secretServiceNotFound(result)) continue;
        throw credentialError("Native credential store lookup failed.", "CREDENTIAL_STORE_OPERATION");
      }
      return null;
    },
    async delete(account) {
      validateAccount(account);
      for (const service of [CREDENTIAL_SERVICE, LEGACY_CREDENTIAL_SERVICE]) {
        if (platform === "darwin") {
          const result = await run(executable, ["delete-generic-password", "-a", account, "-s", service], { env, allowFailure: true });
          if (result.code !== 0 && !macosNotFound(result)) throw credentialError("Native credential store deletion failed.", "CREDENTIAL_STORE_OPERATION");
        } else if (platform === "linux") {
          const result = await run(executable, ["clear", "service", service, "account", account], { env, allowFailure: true });
          if (result.code !== 0 && !secretServiceNotFound(result)) throw credentialError("Native credential store deletion failed.", "CREDENTIAL_STORE_OPERATION");
        }
        else await runWindows(executable, env, run, "delete", account, "", `${service}/${account}`);
      }
    },
  };
}

function fileFallback(reason) {
  return { version: CREDENTIAL_STORE_VERSION, backend: "private-file", native: false, fallbackReason: reason };
}

async function runWindows(executable, env, run, operation, account, secret = "", target = `${CREDENTIAL_SERVICE}/${account}`) {
  const encoded = Buffer.from(WINDOWS_CREDENTIAL_SCRIPT, "utf16le").toString("base64");
  const result = await run(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    input: secret,
    // The adapter reads the current names first and falls back to the legacy ones, so a script
    // written before the rename still resolves the operation it was given.
    env: { ...env, NEXT_CODER_CREDENTIAL_OPERATION: operation, NEXT_CODER_CREDENTIAL_TARGET: target, NEXT_CODER_CREDENTIAL_ACCOUNT: account },
    allowFailure: operation !== "write",
  });
  if (result.code !== 0) {
    if (result.code === 1 && !String(result.stderr).trim()) return operation === "read" ? null : undefined;
    throw credentialError("Windows Credential Manager operation failed.", "CREDENTIAL_STORE_OPERATION");
  }
  if (operation === "delete" || operation === "write") return undefined;
  const encodedValue = stripOneLineEnding(result.stdout);
  if (!strictBase64(encodedValue)) throw credentialError("Windows Credential Manager returned an invalid value.", "CREDENTIAL_STORE_RESPONSE");
  const decodedSecret = Buffer.from(encodedValue, "base64").toString("utf8");
  validateSecret(decodedSecret);
  return decodedSecret;
}

function validateAccount(account) {
  if (typeof account !== "string" || account.length < 1 || account.length > 512 || /[\r\n\0]/.test(account)) throw credentialError("Credential account is invalid.", "CREDENTIAL_ACCOUNT_INVALID");
}

function validateSecret(secret) {
  if (typeof secret !== "string" || secret.length === 0 || Buffer.byteLength(secret) > MAX_SECRET_BYTES || Buffer.byteLength(secret, "utf16le") > MAX_SECRET_BYTES || /[\r\n\0]/.test(secret)) throw credentialError("Connector credential is invalid.", "CREDENTIAL_VALUE_INVALID");
}

function hasSecretServiceSession(env) {
  return typeof env.DBUS_SESSION_BUS_ADDRESS === "string" && env.DBUS_SESSION_BUS_ADDRESS.length > 0;
}

async function executableExists(path, fs) {
  try { await fs.access(path); return true; }
  catch { return false; }
}

async function findLinuxSecretTool(fs) {
  for (const path of ["/usr/bin/secret-tool", "/bin/secret-tool"]) if (await executableExists(path, fs)) return path;
  return null;
}

function macosNotFound({ code, stderr }) { return code === 44 || /could not be found/i.test(String(stderr)); }
function secretServiceNotFound({ code, stderr }) { return code === 1 && String(stderr).trim() === ""; }

function stripOneLineEnding(value) { return String(value).replace(/\r?\n$/, ""); }
function strictBase64(value) { return typeof value === "string" && value.length > 0 && value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value); }
function credentialError(message, code) { return Object.assign(new Error(message), { code }); }

const WINDOWS_CREDENTIAL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NextCoderCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL { public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr credential);
}
'@
$op = $env:NEXT_CODER_CREDENTIAL_OPERATION
if (-not $op) { $op = $env:AGENT_CONTROLLER_CREDENTIAL_OPERATION }
$target = $env:NEXT_CODER_CREDENTIAL_TARGET
if (-not $target) { $target = $env:AGENT_CONTROLLER_CREDENTIAL_TARGET }
$account = $env:NEXT_CODER_CREDENTIAL_ACCOUNT
if (-not $account) { $account = $env:AGENT_CONTROLLER_CREDENTIAL_ACCOUNT }
if ($op -eq 'write') {
  $secret = [Console]::In.ReadToEnd()
  $bytes = [Text.Encoding]::Unicode.GetBytes($secret)
  if ($bytes.Length -eq 0 -or $bytes.Length -gt 2560) { throw 'Credential value has an invalid size.' }
  $blob = [Runtime.InteropServices.Marshal]::AllocCoTaskMem($bytes.Length)
  try {
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
    $credential = New-Object NextCoderCredential+CREDENTIAL
    $credential.Type = 1; $credential.TargetName = $target; $credential.UserName = $account
    $credential.CredentialBlobSize = $bytes.Length; $credential.CredentialBlob = $blob; $credential.Persist = 2
    if (-not [NextCoderCredential]::CredWrite([ref]$credential, 0)) { throw "CredWrite failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  } finally { $zero = New-Object byte[] $bytes.Length; [Runtime.InteropServices.Marshal]::Copy($zero, 0, $blob, $zero.Length); [Runtime.InteropServices.Marshal]::FreeCoTaskMem($blob) }
  exit 0
}
$pointer = [IntPtr]::Zero
if ($op -eq 'read') {
  if (-not [NextCoderCredential]::CredRead($target, 1, 0, [ref]$pointer)) { if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { exit 1 }; throw 'CredRead failed.' }
  try { $value = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][NextCoderCredential+CREDENTIAL]); $secret = [Runtime.InteropServices.Marshal]::PtrToStringUni($value.CredentialBlob, [int]($value.CredentialBlobSize / 2)); [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($secret))) }
  finally { [NextCoderCredential]::CredFree($pointer) }
  exit 0
}
if ($op -eq 'delete') { if (-not [NextCoderCredential]::CredDelete($target, 1, 0)) { if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { exit 1 }; throw 'CredDelete failed.' }; exit 0 }
throw 'Unsupported credential operation.'
`;
