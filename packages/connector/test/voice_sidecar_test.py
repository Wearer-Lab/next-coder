"""Transport/inference slot regression; no model or real recording required."""
import importlib.util
import http.client
import pathlib
import subprocess
import sys
import time
import threading
import unittest
from http.server import ThreadingHTTPServer
from types import SimpleNamespace

asset = pathlib.Path(__file__).resolve().parents[1] / "src/voice-assets/parakeet-sidecar.py"
spec = importlib.util.spec_from_file_location("bundled_voice_sidecar", asset)
sidecar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sidecar)


class VoiceSidecarConcurrencyTest(unittest.TestCase):
    def test_managed_parent_pipe_eof_exits_without_loading_real_model(self):
        code = """
import importlib.util, sys, time
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location('voice_test', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.require_dependencies = lambda: None
module.require_model = lambda *_: None
module.Recognizer = lambda *_: SimpleNamespace(load_seconds=0, warm_up=lambda: 0)
module.ThreadingHTTPServer = lambda *_: SimpleNamespace(serve_forever=lambda: time.sleep(20), server_close=lambda: None)
sys.argv = ['voice_test', '--watch-stdin']
module.main()
"""
        child = subprocess.Popen([sys.executable, "-B", "-c", code, str(asset)], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            time.sleep(0.1)
            self.assertIsNone(child.poll())
            child.stdin.close()
            self.assertEqual(child.wait(timeout=2), 0)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()

    def test_cancelled_client_does_not_release_native_inference_slot(self):
        started = threading.Event()
        finish = threading.Event()
        calls = []
        original_parse = sidecar.parse_multipart
        original_handle = sidecar.handle_transcribe
        sidecar.parse_multipart = lambda *_: {}

        def transcribe(*_):
            calls.append(1)
            started.set()
            finish.wait(3)
            return {"text": "fixture"}

        sidecar.handle_transcribe = transcribe
        server = ThreadingHTTPServer(("127.0.0.1", 0), sidecar.build_handler(SimpleNamespace(), "/v1/transcribe", None, "en"))
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            first = http.client.HTTPConnection(*server.server_address, timeout=2)
            first.request("POST", "/v1/transcribe", b"fixture", {"content-type": "multipart/form-data"})
            self.assertTrue(started.wait(2))
            first.close()
            second = http.client.HTTPConnection(*server.server_address, timeout=2)
            second.request("POST", "/v1/transcribe", b"fixture", {"content-type": "multipart/form-data"})
            reply = second.getresponse()
            self.assertEqual(reply.status, 503)
            self.assertEqual(reply.getheader("connection"), "close")
            reply.read()
            second.close()
            self.assertEqual(len(calls), 1)
        finally:
            finish.set()
            server.shutdown()
            server.server_close()
            thread.join(2)
            sidecar.parse_multipart = original_parse
            sidecar.handle_transcribe = original_handle


if __name__ == "__main__":
    unittest.main()
