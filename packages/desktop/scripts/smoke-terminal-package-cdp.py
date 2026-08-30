#!/usr/bin/env python3
"""Drive one PTY echo through a packaged app's preload bridge."""

import json
import os
import sys
import time
import urllib.request
from typing import Dict, List, Optional, Tuple

import websocket


DEBUG_TARGETS_URL = "http://127.0.0.1:9222/json/list"
MARKER = "OK_PACKAGED_PTY_ECHO"
MAX_OBSERVED_TARGETS = 8
MAX_TARGET_FIELD_LENGTH = 160


def summarize_target(target: Dict[str, object]) -> Tuple[str, str, str]:
    def bounded(field: str) -> str:
        return str(target.get(field, ""))[:MAX_TARGET_FIELD_LENGTH]

    return (bounded("type"), bounded("url"), bounded("title"))


def record_observed_target(
    observed_targets: List[Tuple[str, str, str]], target: Dict[str, object]
) -> None:
    summary = summarize_target(target)
    if summary in observed_targets:
        observed_targets.remove(summary)
    observed_targets.append(summary)
    del observed_targets[:-MAX_OBSERVED_TARGETS]


def evaluate_value(socket_url: str, expression: str, timeout: float = 5) -> object:
    connection = websocket.create_connection(
        socket_url, timeout=timeout, origin="http://localhost"
    )
    request = {
        "id": 1,
        "method": "Runtime.evaluate",
        "params": {
            "expression": expression,
            "awaitPromise": True,
            "returnByValue": True,
        },
    }
    connection.send(json.dumps(request))
    try:
        while True:
            message = json.loads(connection.recv())
            if message.get("id") != 1:
                continue
            if "error" in message:
                raise RuntimeError(f"CDP evaluation failed: {message['error']}")
            result = message.get("result", {})
            if result.get("exceptionDetails"):
                detail = result["exceptionDetails"]
                exception = detail.get("exception", {}).get("description")
                raise RuntimeError(
                    exception or detail.get("text", "renderer evaluation threw")
                )
            return result.get("result", {}).get("value")
    finally:
        connection.close()


def find_editor_websocket() -> str:
    deadline = time.monotonic() + 20
    last_error: Optional[Exception] = None
    observed_targets: List[Tuple[str, str, str]] = []
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(DEBUG_TARGETS_URL, timeout=2) as response:
                targets = json.load(response)
            for target in targets:
                socket_url = target.get("webSocketDebuggerUrl")
                if target.get("type") != "page" or not socket_url:
                    continue
                record_observed_target(observed_targets, target)
                try:
                    is_project_editor = evaluate_value(
                        str(socket_url),
                        "window.okDesktop?.config?.mode === 'editor'"
                        " && window.okDesktop.config.projectPath.length > 0",
                        timeout=2,
                    )
                    if is_project_editor is True:
                        return str(socket_url)
                except Exception as error:
                    # A renderer can disappear or still be loading while the
                    # project deep link replaces the initial Navigator window.
                    last_error = error
        except Exception as error:  # The app may still be creating its first page.
            last_error = error
        time.sleep(0.25)
    raise RuntimeError(
        "no project editor debug target appeared; "
        f"last_error={last_error!r}; observed_targets={observed_targets!r}"
    )


def evaluate_pty_echo(socket_url: str) -> Dict[str, object]:
    expression = f"""
      (async () => {{
        const bridge = window.okDesktop;
        if (!bridge?.config?.ptyAvailable) {{
          throw new Error('packaged renderer did not expose PTY capability');
        }}
        if (typeof bridge.platform !== 'string') {{
          throw new Error('packaged renderer did not expose its platform');
        }}
        const marker = {json.dumps(MARKER)};
        return await new Promise(async (resolve, reject) => {{
          let output = '';
          let ptyId = null;
          let settled = false;
          const pendingData = [];
          let unsubscribe = () => {{}};
          const finish = async (error) => {{
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            unsubscribe();
            if (ptyId !== null) await bridge.terminal.kill(ptyId).catch(() => {{}});
            if (error) reject(error);
            else resolve({{ output, platform: bridge.platform }});
          }};
          const consume = (data) => {{
            output += data;
            const plainOutput = output
              .replace(
                /\\u001b\\](?:[^\\u0007\\u001b]|\\u001b(?!\\\\))*(?:\\u0007|\\u001b\\\\)/g,
                '',
              )
              .replace(/\\u001b\\[[0-?]*[ -/]*[@-~]/g, '');
            // Windows bakes the marker command into shell startup. POSIX types
            // it only after creation, where the echoed input includes `echo `.
            // Requiring a marker-only output line rejects that input echo on
            // both paths and rejects partial writes.
            const markerReachedOutput =
              plainOutput
                .match(/[^\\r\\n]*(?:\\r\\n|\\r|\\n)/g)
                ?.some((line) => line.trim() === marker) ?? false;
            if (markerReachedOutput) void finish(null);
          }};
          const timeout = setTimeout(
            () => void finish(new Error(`PTY echo timed out; output=${{JSON.stringify(output)}}`)),
            20000,
          );
          unsubscribe = bridge.terminal.onData((message) => {{
            if (ptyId === null) {{
              pendingData.push(message);
              return;
            }}
            if (message.ptyId !== ptyId) return;
            consume(message.data);
          }});
          const isWindows = bridge.platform === 'win32';
          const created = await bridge.terminal.create({{
            cols: 80,
            rows: 24,
            ...(isWindows
              ? {{
                  launchCommand: {{
                    executable: 'cmd.exe',
                    args: ['/d', '/c', 'echo', marker],
                  }},
                }}
              : {{}}),
          }});
          if (!created.ok) {{
            await finish(new Error(`PTY create failed: ${{created.reason}}`));
            return;
          }}
          ptyId = created.ptyId;
          for (const message of pendingData) {{
            if (message.ptyId === ptyId) consume(message.data);
          }}
          if (!isWindows) bridge.terminal.input(ptyId, `echo ${{marker}}\\r`);
        }});
      }})()
    """
    value = evaluate_value(socket_url, expression, timeout=30)
    if not isinstance(value, dict):
        raise RuntimeError(f"renderer returned no PTY smoke result: {value}")
    return value


def main() -> int:
    try:
        result = evaluate_pty_echo(find_editor_websocket())
    except Exception as error:
        print(f"ERROR: packaged PTY echo failed: {error}", file=sys.stderr)
        return 1
    # A driver tunneled to a packaged app on another OS pins the target via the
    # environment; a local driver defaults to its own platform.
    expected_platform = os.environ.get("OK_SMOKE_EXPECT_PLATFORM") or sys.platform
    if result.get("platform") != expected_platform:
        print(
            "ERROR: packaged PTY driver exercised "
            f"{result.get('platform')!r}, expected {expected_platform!r}; result={result!r}",
            file=sys.stderr,
        )
        return 1
    print(f"PTY echo marker observed: {MARKER}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
