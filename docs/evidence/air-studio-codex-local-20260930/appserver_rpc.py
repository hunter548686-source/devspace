#!/usr/bin/env python3
"""Scoped, non-agent Codex Local RPC diagnostics over the existing Air SSH alias.
No direct filesystem writes or credential-file access. RPC mutations require an
explicit JSON request supplied by the caller; default mode is read-only discovery.
"""
import argparse
import base64
from collections import deque
import json
import queue
import shlex
import subprocess
import threading

AIR_HOME = "/Users/liheng/.codex-local"
CODEX = "/Applications/Codex Local Runtime.app/Contents/Resources/codex"

class Client:
    def __init__(self):
        remote = shlex.join(["env", "CODEX_HOME=" + AIR_HOME,
            "CODEX_SQLITE_HOME=" + AIR_HOME + "/sqlite", CODEX,
            "app-server", "--stdio"])
        self.process = subprocess.Popen(["ssh", "-o", "BatchMode=yes", "-o",
            "ConnectTimeout=8", "air", remote], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        self.messages = queue.Queue()
        self.errors = deque(maxlen=12)
        self.next_id = 0
        self.error_reader = threading.Thread(target=self._read_errors, daemon=True)
        self.error_reader.start()
        threading.Thread(target=self._read, daemon=True).start()
        self.call("initialize", {"clientInfo": {"name": "air_studio_repair_probe",
            "title": "Air Studio Local Diagnostics", "version": "1.0"},
            "capabilities": {"experimentalApi": True}})
        self.send({"method": "initialized", "params": {}})

    def _read(self):
        for line in self.process.stdout:
            try:
                self.messages.put(json.loads(line))
            except json.JSONDecodeError:
                pass
        self.messages.put({"_eof": True})

    def _read_errors(self):
        for line in self.process.stderr:
            self.errors.append(line.rstrip()[:500])

    def send(self, message):
        self.process.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        self.process.stdin.flush()

    def call(self, method, params):
        self.next_id += 1
        request_id = self.next_id
        self.send({"id": request_id, "method": method, "params": params})
        while True:
            message = self.messages.get(timeout=40)
            if message.get("_eof"):
                self.error_reader.join(timeout=0.5)
                detail = "\n".join(self.errors)
                raise RuntimeError("Air app-server connection closed before returning the RPC: " + detail)
            if message.get("id") == request_id:
                if "error" in message:
                    raise RuntimeError(json.dumps(message["error"], ensure_ascii=False))
                return message.get("result")

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--method", default="model/list")
    parser.add_argument("--params", default="{}")
    args = parser.parse_args()
    allowed = {"model/list", "config/read", "config/batchWrite", "fs/readFile",
        "fs/getMetadata", "fs/copy", "fs/writeFile"}
    if args.method not in allowed:
        raise SystemExit("Method outside this repair's scope")
    params = json.loads(args.params)
    if args.method.startswith("fs/"):
        for key in ("path", "sourcePath", "destinationPath", "fromPath", "toPath"):
            if key in params and not str(params[key]).startswith(AIR_HOME + "/"):
                raise SystemExit("Filesystem operation is outside Air Codex Local")
    client = Client()
    try:
        result = client.call(args.method, params)
        if args.method == "config/read":
            config = result.get("config", {})
            keys = ("model", "model_provider", "oss_provider", "model_catalog_json",
                "model_context_window", "model_auto_compact_token_limit",
                "developer_instructions", "model_reasoning_effort")
            safe = {key: config.get(key) for key in keys}
            safe["providers"] = {name: {key: value for key, value in provider.items()
                if key in ("name", "base_url", "wire_api", "request_max_retries",
                    "stream_max_retries", "stream_idle_timeout_ms", "requires_openai_auth")}
                for name, provider in config.get("model_providers", {}).items()}
            safe["result_metadata"] = {key: value for key, value in result.items()
                if key not in ("config", "layers", "origins")}
            safe["layer_versions"] = [{key: value for key, value in layer.items()
                if key != "config"} for layer in result.get("layers") or []]
            print(json.dumps(safe, ensure_ascii=False, indent=2))
        elif args.method == "fs/readFile":
            print(base64.b64decode(result["dataBase64"]).decode("utf-8"))
        else:
            print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        client.close()

if __name__ == "__main__":
    main()
