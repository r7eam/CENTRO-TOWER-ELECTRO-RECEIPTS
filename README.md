# CENTRO TOWER — electricity receipts

A small web app that runs on one Windows PC and works with no internet. Phones on the same Wi-Fi can use it too.
Everything is stored in one SQLite database file: `data\centro.db`.

## 1. Install and run

1. Install **Node.js 22 or newer** (LTS) from https://nodejs.org. This PC already has Node 22.19, so this step is done here.
   Nothing else is needed: no `npm install`, no internet.
2. Double-click **`Start Centro Tower.bat`**. A black window opens and the browser opens at `http://localhost:3000`.
   **Keep the black window open** while you work. Closing it stops the system.
3. On the first start, a setup screen asks for:
   - your name (the person who collects the money; it's recorded in the edit history)
   - the book prefix (`01-`) and the **first receipt number**. Example: 21 makes the first receipt `01-021`.
   - an **admin password** (needed for Settings: prefix, numbers, import, backup, texts)
4. **Phones:** connect to the same Wi-Fi and open the address shown in the black window, for example `http://192.168.1.20:3000`.
   The same address is in Settings → Book. The first time, Windows may ask whether Node.js may use the network. Choose **Private networks → Allow**.
5. **Start automatically with Windows (optional):** double-click `tools\install-autostart.bat`.

Printing: choose **A5 / A4** in the print preview. In the browser's print dialog, turn **off** "Headers and footers" so the page URL isn't printed.

## 2. Import the old Access data

Settings (⚙, admin password) → **Import and backup** → choose a file → **Import**.

- **`.accdb` / `.mdb`**: reads table `Receipts` directly through the Access engine that is already on this PC.
- **`.csv`**: a CSV export of table `Receipts` with the same column names. Dates must be `dd/mm/yyyy` or `yyyy-mm-dd`.

The original `ReceiptNo`, `Cancelled`, dates and `CreatedAt` are kept. Receipts whose number already exists are skipped, so importing the same file twice is safe.
Afterwards a summary shows how many were imported, which were skipped and why, and any warnings (for example, a line with no year).
Numbering then continues after the highest imported number. A backup is made automatically before every import.

## 3. Backup

- **Automatic:** one copy per day in `data\backups\auto_YYYY-MM-DD.db` (the last 60 days are kept).
- **Manual:** Settings → Import and backup → **Backup now**. This creates `data\backups\centro_<date>_<time>.db`, which you can **Download** to a USB stick.
- **Export:** Settings → Import and backup → **Excel (.xlsx)** or **CSV**. This exports all receipts, including voided ones.
- **Second copy outside this disk:** Settings → Import and backup → **Second backup**. Enter one or more folders, one per line: another disk (`D:\CentroTower-Backup`), a USB stick, or a OneDrive / Google Drive folder. Ready-made suggestions are shown, and a click adds one.
  Every backup is then copied there too, together with `centro-receipts-latest.xlsx`, which opens in Excel without this program.
  A USB stick that is unplugged is fine: it is retried every 10 minutes and catches up as soon as it is plugged in.
  If no copy has reached any of these folders for 3 days (or none is set), a yellow ⚠ warning appears at the top of every screen. Click it to open the settings.
- **Restore:** close the black window, copy a backup over `data\centro.db` (delete `centro.db-wal` and `centro.db-shm` if present), then start again.
  Never copy `centro.db` itself while the system is running; always use a file from `backups` (or the mirror folder).

Keep at least one copy **outside this computer** (USB stick kept elsewhere, or a cloud folder). A second disk in the same PC protects against a disk failure, not against theft, fire or a virus.

### Forgotten admin password

Double-click `tools\reset-admin-password.bat` **on this computer** and type a new password twice (it is hidden while you type).
It works immediately, with no restart. Receipts are not touched, and the reset is written to the edit history.
It cannot be done from a phone or another computer, because it needs direct access to the data folder.

## 4. Change texts (Kurdish / Arabic)

Settings → **Texts**. Every label, button, message, month name and printed text is listed by key with its Kurdish and Arabic versions.
Edit a text, press **Save**, and the change is immediate. **Default** puts the original text back.
Keep `{placeholders}` such as `{n}` or `{no}`: the program fills them in.
The original texts are in `server\texts.js`.

## Rules worth knowing

- Receipt numbers are given **only when a receipt is saved for the first time**: `n = max(NextNo, highest existing + 1)`, inside a database lock.
  Numbers are never reused. Receipts can't be deleted (only voided). The database itself refuses deletes, renumbering and un-voiding.
- Each used line needs **month + year + amount (> 0)**. The same month can't appear twice on one receipt.
  If the same apartment + month was already paid on another receipt, you are warned (with that receipt number) and must confirm.
- Every create, edit and void is logged with who, when, and old → new value (Settings → Edit history).
- If two people edit the same receipt at once, the second save is refused with a message, so nothing is silently overwritten.
- Reports count only non-voided receipts and group by the month/year the money is **for**.
- "All apartments" = active apartments in Settings → Apartments, plus any apartment that paid in that period.
  Apartments are added automatically from receipts. You can add floor, owner, tenant and phone, and mark an apartment inactive.
- Receipts with a name but **no apartment** count in money totals. They appear as a "no apartment number" row in the month pop-up.

## Files

| Path | What |
|---|---|
| `server.js` | web server and API |
| `server/logic.js` | all rules: validation, numbering, reports |
| `server/db.js` | database tables, protections, the `PaymentLines` view used by every report |
| `server/texts.js` | default Kurdish/Arabic texts |
| `server/importer.js`, `tools/read-accdb.ps1` | Access / CSV import |
| `server/mirror.js` | second backup folder(s) |
| `tools/reset-admin-password.bat` | new admin password if forgotten |
| `public/` | screens and printed receipt (`app.js`, `app.css`) |
| `test/run-tests.js` | automatic tests: `npm test` (uses a temporary database, never yours) |

Options: `node server.js --port=3000 --data=D:\centro-data` (a different port or data folder).
