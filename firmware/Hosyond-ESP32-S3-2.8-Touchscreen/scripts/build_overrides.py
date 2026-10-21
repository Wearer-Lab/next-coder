"""Inject release version and OTA verifier without committing deployment secrets."""

import os

Import("env")  # type: ignore[name-defined]  # PlatformIO/SCons global.


def quoted(value: str) -> str:
    return '\\"' + value.replace("\\", "\\\\").replace('"', '\\"') + '\\"'


definitions = []
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
