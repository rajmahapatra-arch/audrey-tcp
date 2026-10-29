# Granola Filer

Granola Filer saves each new Granola meeting as a plain `.txt` file in the right client or matter folder, under:

`C:\Users\rajma\OneDrive\Documents\_XEQtor\Client\`

- A meeting about a matter goes to `<Client>\<Matter>\Meetings\`.
- A general client meeting goes to `<Client>\Meetings\`.
- If the tool is not sure, the meeting goes to `_Meetings to file\` for you to move by hand. The tool learns from the moves you make.

Everything runs on this laptop:

- Your Granola sign-in is encrypted with Windows (DPAPI), so only your Windows account can read it.
- The settings, the learned rules and the plan file are kept in `%LOCALAPPDATA%\granola-filer\`. Nothing is stored in this repo or in OneDrive except the meeting files themselves.
- The tool only reads from Granola. It never changes your folders, notes or workspace there.

All commands are run from this folder:

```
cd C:\dev\audrey-tcp\tools\granola-filer
```

## 1. Connect to Granola (once)

```
node src/cli.js connect
```

1. Your browser opens at Granola's sign-in page.
2. Approve access. The tab will then say "Granola Filer is connected".
3. The command prints your Granola e-mail and workspace. Check that they are right.

The window waits for up to 10 minutes. If the browser does not open, copy the URL that is printed into your browser.

**Fallback:** if the browser hand-off fails, run `node src/cli.js connect --device` and type in the code it shows.

The workspace is recorded at connect time. If Granola is later switched to a different workspace, the tool **pauses** and shows a notification. It does not file anything until you switch back in Granola, or run `connect` again to accept the new workspace.

## 2. Try a dry run first

```
node src/cli.js dry-run
```

This looks at the last 30 days of meetings and decides where each one would go. **It does not write any meeting files.** It saves its plan to:

`%LOCALAPPDATA%\granola-filer\dry-run-plan.txt`

Paste that path into the Windows Run box (Win+R) to open the plan. For each meeting it shows the date, the title, the folder chosen, which rule chose it and how confident it is.

To look further back or less far, use for example `--days 7`.

## 3. File for real

```
node src/cli.js run
```

When it finishes, a Windows notification appears, for example "3 meetings filed, 1 waiting to be filed".

**Tip for the first run:** most meetings will go to the inbox at first, because the tool has not learned anything yet. If you would rather not have 30 days of meetings land at once, start with `node src/cli.js run --days 3`.

Each file is named like `2026-10-28 – Board prep call.txt`. If a file with that name already exists, ` (2)` is added to the name.

Each file contains, in this order:

1. The title, date and time.
2. The Granola meeting ID.
3. The attendees.
4. The Granola link.
5. The **SUMMARY**, **MY NOTES** and **TRANSCRIPT** sections.

The files are UTF-8 with a BOM, so Notepad and Word open them correctly.

A meeting is only filed once Granola's summary exists and the note has been quiet for 20 minutes. Until then it waits for the next run.

Each meeting is filed **once**. If you delete a file, the tool will not write it again. To force a meeting to be written again, run `node src/cli.js run --refile <Granola meeting ID>`. The ID is printed inside every file.

## 4. Run it automatically every 15 minutes

```
node src/cli.js install-schedule
```

This adds a Windows Task Scheduler task called **Granola Filer**:

- It runs `run` every 15 minutes, but only while you are logged on.
- It runs without opening a window.

To remove it:

```
node src/cli.js uninstall-schedule
```

`node src/cli.js status` shows how many meetings have been processed and how many domains have been learned.

## How it decides where a meeting goes

The rules are tried in order. The first rule that is sure wins.

| Rule | What it checks |
|---|---|
| **a. Granola folder** | The meeting is in a Granola folder whose name matches a client or matter folder. Case, punctuation and spacing are ignored. A matter name contained in the Granola folder name also counts, for example a Granola folder "Acme – Lease renewal" matches the matter "Lease renewal". If your Granola folders are named differently from your disk folders, list them in `config.json` (see below). |
| **b. Who attended** | The e-mail domains of the attendees. A domain seen only in one client's filed meetings means that client. If all those meetings are in one matter, that matter. Your own domain (xeqtor.com) and webmail domains (gmail, outlook, hotmail, icloud, yahoo, …) are ignored. |
| **c. Title** | The meeting title contains a matter folder name or a distinctive client name. Generic matter names such as "NDA", "Brand" or "Employment" only count when the client is already known. |
| **d. AI model** | Off for now. See below. |
| **e. Inbox** | None of the rules above was sure. The meeting goes to `_Meetings to file\`, and a line is added to `_Meetings to file\_filing-log.txt` saying why, plus any suggestion. |

## How it learns

The tool learns from where your meeting files end up, so all you need to do is move them in File Explorer. On every run it checks where each file it wrote now is:

- **Moved from the inbox into a client or matter folder:** the attendees' domains now point to that client or matter. Future meetings with those people are filed there automatically (rule b).
- **Moved between matters, or back to the inbox:** the learning is corrected to match.
- **Deleted:** the meeting is never written again, and it no longer counts as evidence.

Files are found again by name anywhere under the Client folder. The tool checks the Granola meeting ID inside the file to make sure it has the right one.

## Settings: `%LOCALAPPDATA%\granola-filer\config.json`

The file is created with the defaults on first use. Edit it in Notepad.

| Setting | Meaning |
|---|---|
| `clientRoot` | The Client folder. |
| `inbox` | The folder for meetings that are not filed automatically. |
| `intervalMinutes` | How often the schedule runs (default 15). |
| `lookbackDays` | How far back to look (default 30). |
| `readyAfterMinutes` | How long the note must be quiet before it is filed (default 20). |
| `folderMap` | Granola folder name to disk folder. For example: `{ "Acme deals": "Acme Ltd\\Lease renewal", "Beta": "Beta Corp" }`. |
| `clientAliases` | Other ways a client is named in titles. For example: `{ "Acme Holdings": ["AH"] }`. |
| `genericNames` | Extra names that are too generic to trust in a title on their own. |
| `ownDomains`, `genericDomains` | Domains that are never used for learning. |
| `model.provider` | `"none"` (off) or `"ollama"`. |

## Turning on the AI model later (needs proper Wi-Fi)

The model runs **locally** through Ollama, so meeting text never leaves the laptop. The tool refuses to send it anywhere other than 127.0.0.1.

1. Install Ollama from https://ollama.com and let it start.
2. Download a model. This is several GB, so do it on proper Wi-Fi, not the phone hotspot:

   ```
   ollama pull qwen2.5:7b-instruct
   ```

3. In `config.json`, set `"provider": "ollama"` under `model`. Check that `model.ollama.model` matches the model you pulled.
4. Run `node src/cli.js dry-run` and read the plan. Model decisions are marked **rule d**.

The model is only asked when rules a, b and c are not sure, and it only files a meeting when its confidence is at least 0.8 (`model.minConfidence`). Below that, the meeting goes to the inbox with the model's suggestion in `_filing-log.txt`. The model may propose a **new matter folder** inside an existing client. It can never create a client folder.

## Troubleshooting

| Problem | What to do |
|---|---|
| "Granola sign-in needed" notification | Run `node src/cli.js connect`. |
| "Paused: workspace changed" | Switch Granola back to your workspace, or run `connect` to accept the new one. |
| You want to see what happened | The log is `%LOCALAPPDATA%\granola-filer\granola-filer.log`. It records meeting IDs, dates, folders and rules only, never meeting content. |
| Something parses oddly | `node src/cli.js discover` prints the *structure* of Granola's replies without any content. |
