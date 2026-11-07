#!/usr/bin/env python3
"""Checked Air-only configuration repair using native Codex Local settings/FS RPC.
No shell file editing, credential access, service deployment, or model downloads.
Default execution is a read-only regression check; --apply explicitly applies.
"""
import argparse
import ast
import base64
import copy
import hashlib
import json
import re
from appserver_rpc import Client, AIR_HOME

MODEL = "qwen3.8:27b-mlx"
PROVIDER = "studio-ollama"
BASE_URL = "http://100.77.217.28:11434/v1/"
CONFIG = AIR_HOME + "/config.toml"
SCRIPT = AIR_HOME + "/sync-ollama-catalog-context.py"
OLD_CATALOG = AIR_HOME + "/ollama-launch-models.json"
NEW_CATALOG = AIR_HOME + "/studio-models.json"
BACKUP_SUFFIX = ".bak-studio-20260930T1606"
EXPECTED_CONFIG_VERSION = "sha256:b575a765002fa186bafcb79884f18573f90409d1039e251e12bb7b45caa8461d"
IDENTITY = (
    "你是运行在李恒 MacBook Air 上的 Codex Local，不是官方 Codex，也不是 Studio 上的程序。"
    "你的配置目录是 /Users/liheng/.codex-local；/Users/liheng/.codex 属于官方客户端，不是你的配置。"
    "你的推理由远程 Mac Studio 的 qwen3.8:27b-mlx 提供，已连接 http://100.77.217.28:11434/v1/。"
    "这里的 Studio 指 Mac Studio 电脑，不是 LM Studio。默认用中文回复。"
    "文件与终端工具在 Air 上执行；需要操作 Studio 文件时必须使用已授权的远程连接。"
    "不要为了寻找已经明确的模型接口而扫描用户主目录或搜索密钥。"
    "真实调用工具并报告结果，不要把计划或模拟输出说成已经完成。"
)
OLD_MAIN = "def main() -> int:\n    context = valid_context(context_from_ollama_logs() or context_from_ollama_ps())"
NEW_MAIN = '''def main() -> int:
    # The local Ollama catalog must not reset a selected remote/custom provider.
    config_text = CONFIG_PATH.read_text()
    provider = re.search(r'^model_provider\\s*=\\s*"([^\"]+)"', config_text, flags=re.MULTILINE)
    if provider and provider.group(1) != "ollama-local":
        print("codex-local remote/custom provider selected; local Ollama catalog sync skipped")
        return 0
    context = valid_context(context_from_ollama_logs() or context_from_ollama_ps())'''


def read_text(client, path):
    if not path.startswith(AIR_HOME + "/"):
        raise RuntimeError("Out-of-scope read")
    return base64.b64decode(client.call("fs/readFile", {"path": path})["dataBase64"]).decode("utf-8")


def write_text(client, path, text):
    if path not in (SCRIPT, NEW_CATALOG):
        raise RuntimeError("Out-of-scope runtime settings write")
    return client.call("fs/writeFile", {"path": path,
        "dataBase64": base64.b64encode(text.encode("utf-8")).decode("ascii")})


class FakePath:
    def __init__(self, text):
        self.text = text
        self.writes = []
    def read_text(self):
        return self.text
    def write_text(self, text):
        self.writes.append(text)
        self.text = text


def regression(old_script, new_script, old_catalog):
    requested = 'model = "' + MODEL + '"\nmodel_provider = "' + PROVIDER + '"\n'
    namespace = {"__name__": "startup_regression"}
    exec(compile(old_script, SCRIPT, "exec"), namespace)
    fake_config = FakePath(requested)
    namespace["CONFIG_PATH"] = fake_config
    namespace["CATALOG_PATH"] = FakePath(json.dumps(old_catalog))
    old_reset = namespace["sync_config_model"]()
    assert old_reset and 'model = "gemma4:12b"' in fake_config.text, "Original reset not reproduced"
    patched = {"__name__": "startup_regression"}
    exec(compile(new_script, SCRIPT, "exec"), patched)
    patched_config = FakePath(requested)
    patched["CONFIG_PATH"] = patched_config
    def unexpected_local_sync(*args):
        raise AssertionError("Remote provider entered local Ollama sync")
    patched["context_from_ollama_logs"] = unexpected_local_sync
    patched["context_from_ollama_ps"] = unexpected_local_sync
    assert patched["main"]() == 0
    assert patched_config.text == requested and not patched_config.writes
    return {"original_startup_reset_reproduced": True,
        "patched_startup_preserves_studio": True}


def config_version(result):
    matches = [layer["version"] for layer in result.get("layers", [])
        if layer.get("name", {}).get("file") == CONFIG]
    if len(matches) != 1:
        raise RuntimeError("Cannot resolve exact Air config version")
    return matches[0]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    client = Client()
    try:
        current = client.call("config/read", {"includeLayers": True})
        if config_version(current) != EXPECTED_CONFIG_VERSION:
            raise RuntimeError("Air config changed; inspect and reconcile before applying")
        script = read_text(client, SCRIPT)
        if script.count(OLD_MAIN) != 1:
            raise RuntimeError("Startup script no longer matches reviewed baseline")
        patched_script = script.replace(OLD_MAIN, NEW_MAIN, 1)
        ast.parse(patched_script)
        original_catalog = json.loads(read_text(client, OLD_CATALOG))
        templates = [model for model in original_catalog["models"]
            if model.get("slug") == "gemma4:12b"]
        if len(templates) != 1:
            raise RuntimeError("Cannot resolve installed metadata schema template")
        model = copy.deepcopy(templates[0])
        model.update(slug=MODEL, display_name="Qwen3.8 27B · Mac Studio",
            description="Mac Studio 本地推理；文件和终端工具在 MacBook Air 执行",
            context_window=32768, max_context_window=32768,
            auto_compact_token_limit=24576, priority=0,
            input_modalities=["text"], visibility="list", supported_in_api=True)
        if isinstance(model.get("base_instructions"), str):
            model["base_instructions"] = model["base_instructions"].replace(
                "You are Codex, a coding agent based on GPT-5.",
                "You are Codex Local on the user's MacBook Air, powered by their Mac Studio's local Qwen model.", 1)
        new_catalog = {key: value for key, value in original_catalog.items() if key != "models"}
        new_catalog["models"] = [model]
        catalog_text = json.dumps(new_catalog, ensure_ascii=False, indent=2) + "\n"
        checks = regression(script, patched_script, original_catalog)
        changes = {
            "model": MODEL,
            "model_provider": PROVIDER,
            "model_catalog_json": NEW_CATALOG,
            "model_context_window": 32768,
            "model_auto_compact_token_limit": 24576,
            "developer_instructions": IDENTITY,
            "model_providers." + PROVIDER: {
                "name": "Mac Studio Ollama",
                "base_url": BASE_URL,
                "wire_api": "responses",
                "requires_openai_auth": False,
                "request_max_retries": 1,
                "stream_max_retries": 0,
                "stream_idle_timeout_ms": 60000,
            },
        }
        print(json.dumps({"checks": checks, "mode": "apply" if args.apply else "check",
            "model": MODEL, "provider": PROVIDER, "context": 32768,
            "old_config_version": EXPECTED_CONFIG_VERSION,
            "original_catalog_preserved": OLD_CATALOG,
            "new_catalog": NEW_CATALOG,
            "script_sha256_before": hashlib.sha256(script.encode()).hexdigest(),
            "script_sha256_after": hashlib.sha256(patched_script.encode()).hexdigest()},
            ensure_ascii=False, indent=2))
        if not args.apply:
            return
        # The original config backup was already made with fs/copy. Verify it
        # matches the exact reviewed config without printing its contents.
        backup = client.call("fs/readFile", {"path": CONFIG + BACKUP_SUFFIX})
        backup_hash = "sha256:" + hashlib.sha256(base64.b64decode(backup["dataBase64"])).hexdigest()
        if backup_hash != EXPECTED_CONFIG_VERSION:
            # Config layer versions can be hashes of normalized TOML rather than
            # raw bytes. Compare local backup/current bytes instead.
            now = client.call("fs/readFile", {"path": CONFIG})
            if backup["dataBase64"] != now["dataBase64"]:
                raise RuntimeError("Existing config backup differs from current config")
        client.call("fs/copy", {"sourcePath": SCRIPT,
            "destinationPath": SCRIPT + BACKUP_SUFFIX, "recursive": False})
        backup_script = read_text(client, SCRIPT + BACKUP_SUFFIX)
        if backup_script != script:
            raise RuntimeError("Startup backup verification failed")
        # Refuse to overwrite an existing independently created Studio catalog.
        try:
            client.call("fs/getMetadata", {"path": NEW_CATALOG})
        except RuntimeError as error:
            if not any(word in str(error).lower() for word in ("not found", "no such file", "does not exist")):
                raise
        else:
            raise RuntimeError("Studio catalog already exists; inspect before overwriting")
        write_text(client, NEW_CATALOG, catalog_text)
        if read_text(client, NEW_CATALOG) != catalog_text:
            raise RuntimeError("New catalog readback failed")
        if read_text(client, SCRIPT) != script:
            raise RuntimeError("Startup script changed concurrently; stopping before patch")
        write_text(client, SCRIPT, patched_script)
        if read_text(client, SCRIPT) != patched_script:
            raise RuntimeError("Startup patch readback failed")
        result = client.call("config/batchWrite", {
            "edits": [{"keyPath": key, "value": value, "mergeStrategy": "replace"}
                for key, value in changes.items()],
            "filePath": CONFIG,
            "expectedVersion": EXPECTED_CONFIG_VERSION,
            "reloadUserConfig": False,
        })
        print("CONFIG_WRITE", json.dumps(result, ensure_ascii=False))
        applied = client.call("config/read", {"includeLayers": True})
        actual = applied["config"]
        assert actual["model"] == MODEL and actual["model_provider"] == PROVIDER
        assert actual["model_catalog_json"] == NEW_CATALOG
        assert actual["model_providers"][PROVIDER]["base_url"] == BASE_URL
        print("APPLIED_VERIFIED", json.dumps({"config_version": config_version(applied),
            "backup_config": CONFIG + BACKUP_SUFFIX,
            "backup_startup": SCRIPT + BACKUP_SUFFIX}, ensure_ascii=False))
    finally:
        client.close()

if __name__ == "__main__":
    main()
