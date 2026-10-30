"""Inject release version and OTA verifier without committing deployment secrets."""

import os

Import("env")  # type: ignore[name-defined]  # PlatformIO/SCons global.


def quoted(value: str) -> str:
    # PlatformIO hands a CPPDEFINES value to the compiler through a shell, and the shell eats one
    # level of quoting. The value has to survive that and still be a complete C string literal when
    # the compiler sees it.
    #
    # Escape once for C, then once more for the shell:
    #   value        agent-controller.dev-key
    #   C literal    "agent-controller.dev-key"
    #   shell-safe   "\"agent-controller.dev-key\""
    # A value that already contains quotes (a secret written as "quoted" in .env) keeps them, which
    # is what the gateway signs with.
    c_literal = '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return '"' + c_literal.replace("\\", "\\\\").replace('"', '\\"') + '"'


definitions = []
qualification = os.environ.get("NEXT_CODER_QUALIFICATION_BENCH")
if qualification not in (None, "0", "1"):
    raise ValueError("NEXT_CODER_QUALIFICATION_BENCH must be 0 or 1")
if qualification == "1":
    if env.get("PIOENV") != "hosyond-es3c28p-bench":
        raise ValueError("Qualification is allowed only in hosyond-es3c28p-bench, never release")
    definitions.extend([("HOSYOND_QUALIFICATION", 1), ("HOSYOND_QUALIFICATION_ALLOWED", 1),
                        ("TLS_SESSION_DIAGNOSTICS", 1)])

# The NEXT_CODER_* names are current. The AGENT_CONTROLLER_* names are the previous product's
# spelling and stay accepted so an existing release pipeline keeps working unchanged.
firmware_version = os.environ.get("NEXT_CODER_FIRMWARE_VERSION") or os.environ.get(
    "AGENT_CONTROLLER_FIRMWARE_VERSION")
verify_key = os.environ.get("NEXT_CODER_OTA_VERIFY_KEY") or os.environ.get(
    "AGENT_CONTROLLER_OTA_VERIFY_KEY")
if firmware_version:
    definitions.append(("BUILD_FIRMWARE_VERSION", quoted(firmware_version)))
if verify_key:
    definitions.append(("BUILD_OTA_MANIFEST_VERIFY_KEY", quoted(verify_key)))
if definitions:
    env.Append(CPPDEFINES=definitions)  # type: ignore[name-defined]
