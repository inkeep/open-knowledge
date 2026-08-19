#!/usr/bin/env python3
"""Drive one PTY echo through the installed app's smoke-only preload bridge."""

import json
import sys
import time
import urllib.request
from typing import Dict, Optional

import websocket


DEBUG_TARGETS_URL = "http://127.0.0.1:9222/json/list"
MARKER = "OK_PACKAGED_LINUX_PTY_ECHO"


def find_page_websocket() -> str:
    deadline = time.monotonic() + 20
    last_error: Optional[Exception] = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(DEBUG_TARGETS_URL, timeout=2) as response:
                targets = json.load(response)
            for target in targets:
                if target.get("type") == "page" and target.get("webSocketDebuggerUrl"):
                    return str(target["webSocketDebuggerUrl"])
        except Exception as error:  # The app may still be creating its first page.
            last_error = error
        time.sleep(0.25)
    raise RuntimeError(f"no renderer debug target appeared: {last_error}")


def evaluate_pty_echo(socket_url: str) -> Dict[str, object]:
    connection = websocket.create_connection(socket_url, timeout=30, origin="http://localhost")
    expression = f"""
      (async () => {{
        const bridge = window.okDesktop;
        if (!bridge?.config?.ptyAvailable) {{
          throw new Error('packaged renderer did not expose Linux PTY capability');
        }}
        const marker = {json.dumps(MARKER)};
        return await new Promise(async (resolve, reject) => {{
          let output = '';
          let ptyId = null;
          let unsubscribe = () => {{}};
          const finish = async (error) => {{
            clearTimeout(timeout);
            unsubscribe();
            if (ptyId !== null) await bridge.terminal.kill(ptyId).catch(() => {{}});
            if (error) reject(error);
            else resolve({{ marker, output }});
          }};
          const timeout = setTimeout(
            () => void finish(new Error(`PTY echo timed out; output=${{JSON.stringify(output)}}`)),
            20000,
          );
          unsubscribe = bridge.terminal.onData((message) => {{
            if (message.ptyId !== ptyId) return;
            output += message.data;
            if (output.includes(marker)) void finish(null);
          }});
          const created = await bridge.terminal.create({{ cols: 80, rows: 24 }});
          if (!created.ok) {{
            await finish(new Error(`PTY create failed: ${{created.reason}}`));
            return;
          }}
          ptyId = created.ptyId;
          bridge.terminal.input(ptyId, `printf '${{marker}}\\n'\r`);
        }});
      }})()
    """
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
                raise RuntimeError(exception or detail.get("text", "renderer evaluation threw"))
            value = result.get("result", {}).get("value")
            if not isinstance(value, dict):
                raise RuntimeError(f"renderer returned no PTY smoke result: {result}")
            return value
    finally:
        connection.close()


def main() -> int:
    try:
        result = evaluate_pty_echo(find_page_websocket())
    except Exception as error:
        print(f"ERROR: packaged PTY echo failed: {error}", file=sys.stderr)
        return 1
    output = str(result.get("output", ""))
    if MARKER not in output:
        print(f"ERROR: PTY output omitted marker; output={output!r}", file=sys.stderr)
        return 1
    print(f"PTY echo marker observed: {MARKER}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
