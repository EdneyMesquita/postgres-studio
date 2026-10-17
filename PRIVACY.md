# Privacy policy

Effective 2026-10-17. Also published at <https://pgstudio.nilpointer.tech/privacy/>.

Postgres Studio is a desktop app that runs on your computer. It has no account and no telemetry, and the project runs no server that the app talks to. We don't collect, store, sell or share any personal information.

## What stays on your computer

- **Connections:** the connections you save, including names, addresses and settings, are stored on your computer. Passwords and passphrases go to your system's credential store (Windows Credential Manager, macOS Keychain, or Secret Service on Linux), or to an encrypted file where none is available.
- **Your data:** the app connects only to the PostgreSQL servers you set up. It reads and writes their data only when you ask it to: opening a table, running a query, committing an edit.
- **Your files:** scripts and exports are saved only where you choose.
- **Open tabs:** with "Reopen last session's tabs on launch" on (Settings › General), the open tabs, their queries and the SQL in their consoles are kept in the app's own storage on your computer, so they come back at the next launch.
- **psql:** if you run a console through psql, Postgres Studio starts the psql already on your computer and hands it the connection's password through its environment. It never downloads psql.
- **Log file:** the app writes a log of its own activity and errors to your computer, to help diagnose problems: app start and exit, connection names and server hosts, failed or slow operations, and crashes. It never contains passwords, connection strings, SQL or row values. It is never sent anywhere; you can open it from the app (Ctrl+K, "Open logs folder") and delete it at any time.

## The Assistant (optional)

The Assistant is off until you set it up. When it's on, it runs an AI coding agent that is already installed on your computer and signed in with your own account: Claude Code (by Anthropic) or Codex (by OpenAI).

- Your messages, and what the agent reads through the app's read-only tools, are sent to that agent's provider under the terms of your account with them.
- What the agent reads is limited to the connections you allow in the Assistant's settings: schema, table and column names and types, indexes and query plans. It reads row values only if you allow it, each time or always for a connection.
- Postgres Studio itself stores no API key and sends nothing to Anthropic or OpenAI on its own.

## The MCP server (optional)

The MCP server is off until you turn it on in Settings › MCP server, and it only runs while Postgres Studio is open. When it's on, AI clients on your computer that you connect to it (such as Claude Code, Cursor, Codex or VS Code) can work with your saved connections, within what you allow.

- It listens only on your own computer (127.0.0.1), and a client must present the access token kept in your system's credential store.
- You decide what clients may do: each kind of action is off, asks you first in the app, or is allowed, and each connection is closed to them, readable, or readable and writable.
- What a client reads goes to that client, and to whatever AI provider it uses, under your account with them. Postgres Studio itself sends nothing anywhere.
- Clients never get your passwords or full connection strings. A connection a client creates is saved without a password.
- "Add to &lt;client&gt;" writes the server's address and the token into that client's own configuration file on your computer, and keeps a copy of the file as it was.

## Contact

Questions about privacy: email <edneyphp@gmail.com>.
