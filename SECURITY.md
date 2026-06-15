# Security Policy

## The access this server has

horizon-mcp has **unrestricted access to the local Windows desktop**. Through it a
connected MCP client can:

- capture any pixel on any monitor (`screenshot`, `screenshot_region`, `get_pixel_color`, `ocr`),
- move the mouse and click/drag anywhere (`click`, `double_click`, `move_mouse`, `mouse_drag`, `scroll`),
- type text and send any key chord — including the Windows key and `Ctrl+Alt+Del`-class
  combinations — into whatever window has focus (`type_text`, `press_key`, `key_combo`, `paste_text`),
- read and write the clipboard (`get_clipboard`, `set_clipboard`), and
- enumerate and focus windows (`list_windows`, `focus_window`, `get_foreground_window`).

There is no sandbox. The server cannot tell a benign instruction from a harmful one;
it executes whatever the connected client asks.

## Operating it safely

- **Connect it only to trusted MCP clients.** Treat it with the same caution as giving
  someone remote control of the machine.
- **Never expose it over a network transport.** The server speaks stdio and is meant to
  be spawned as a local child process by the client. Do not place it behind a socket,
  HTTP bridge, or any remote-accessible transport.
- **Mind credentials in transit.** `paste_text` leaves its value on the clipboard; clear
  it afterward with `set_clipboard ""`. Avoid having the client echo secrets back into
  the conversation.
- **Run with least privilege.** Do not run the host process elevated unless a specific
  task requires it.

## What the server does *not* do

- It makes **no outbound network calls** and contains **no telemetry** — it never
  collects, stores, or transmits screen contents, keystrokes, or usage data.
- It reads **no secrets, environment variables, or credential files**.
- It does **not persist** anything it captures; every tool call is stateless.

## Reporting a vulnerability

Please report security issues privately to **hello@sensaiworks.com** rather than opening
a public issue. Include a description, reproduction steps, and the potential impact. We
will acknowledge the report and work with you on a fix and coordinated disclosure.
