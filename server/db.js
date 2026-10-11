// Database: SQLite file data/centro.db (Node's built-in node:sqlite, no install needed).
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const DEFAULT_TEXTS = require('./texts');

const ROOT = path.join(__dirname, '..');
// DEMO mode (--demo or CENTRO_DEMO=1): a throw-away database with sample data, wiped at every start.
// Used for showing the system online; it never touches the real data folder.
const DEMO = process.argv.includes('--demo') || process.env.CENTRO_DEMO === '1';
// data folder: --data=<folder> on the command line, or env CENTRO_DATA, else ./data
const dataArg = process.argv.find((a) => a.startsWith('--data='));
const DATA_DIR = DEMO ? path.join(require('os').tmpdir(), 'centro-demo')
  : path.resolve(dataArg ? dataArg.slice(7) : process.env.CENTRO_DATA || path.join(ROOT, 'data'));
if (DEMO) fs.rmSync(DATA_DIR, { recursive: true, force: true });
const DB_FILE = path.join(DATA_DIR, 'centro.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS Receipts (
  ReceiptID    INTEGER PRIMARY KEY AUTOINCREMENT,
  ReceiptNo    TEXT NOT NULL UNIQUE,
  ReceiptDate  TEXT,                                   -- yyyy-mm-dd
  CustomerName TEXT CHECK (length(CustomerName) <= 120),
  CustType     TEXT CHECK (CustType IN ('O','T')),
  ApartmentNo  TEXT CHECK (length(ApartmentNo) <= 20),
  Currency     TEXT NOT NULL DEFAULT 'USD' CHECK (Currency IN ('USD','IQD')),   -- one currency per receipt
  M1 INTEGER CHECK (M1 BETWEEN 1 AND 12), Y1 INTEGER, A1 INTEGER,
  M2 INTEGER CHECK (M2 BETWEEN 1 AND 12), Y2 INTEGER, A2 INTEGER,
  M3 INTEGER CHECK (M3 BETWEEN 1 AND 12), Y3 INTEGER, A3 INTEGER,
  ReceivedBy   TEXT CHECK (length(ReceivedBy) <= 80),
  Notes        TEXT CHECK (length(Notes) <= 255),
  Cancelled    INTEGER NOT NULL DEFAULT 0,
  CreatedAt    TEXT NOT NULL,                          -- yyyy-mm-dd HH:MM:SS (local)
  UpdatedAt    TEXT,
  CreatedBy    TEXT,
  Rev          INTEGER NOT NULL DEFAULT 0              -- +1 on every change (detects two people editing at once)
);
CREATE INDEX IF NOT EXISTS idxReceiptsApt ON Receipts (ApartmentNo);

-- receipts are never deleted, never renumbered, never un-voided
CREATE TRIGGER IF NOT EXISTS trgReceiptsNoDelete BEFORE DELETE ON Receipts
BEGIN SELECT RAISE(ABORT, 'Receipts can never be deleted - void them instead'); END;
CREATE TRIGGER IF NOT EXISTS trgReceiptsNoRenumber BEFORE UPDATE OF ReceiptNo ON Receipts
WHEN NEW.ReceiptNo IS NOT OLD.ReceiptNo
BEGIN SELECT RAISE(ABORT, 'A receipt number can never change'); END;
CREATE TRIGGER IF NOT EXISTS trgReceiptsVoidFinal BEFORE UPDATE ON Receipts
WHEN OLD.Cancelled = 1
BEGIN SELECT RAISE(ABORT, 'A voided receipt can never be changed'); END;

CREATE TABLE IF NOT EXISTS Settings (
  ID INTEGER PRIMARY KEY CHECK (ID = 1),
  Prefix TEXT NOT NULL DEFAULT '01-',
  NextNo INTEGER NOT NULL DEFAULT 1,
  Lang TEXT NOT NULL DEFAULT 'ku',
  AdminHash TEXT, AdminSalt TEXT,
  SetupDone INTEGER NOT NULL DEFAULT 0,
  MirrorDirs TEXT,                 -- JSON list of extra backup folders (other disk / USB / OneDrive)
  MirrorStatus TEXT                -- JSON {folder: {lastOk, error}}
);
INSERT OR IGNORE INTO Settings (ID) VALUES (1);

CREATE TABLE IF NOT EXISTS Apartments (
  ApartmentNo TEXT PRIMARY KEY COLLATE NOCASE,
  Floor TEXT, OwnerName TEXT, TenantName TEXT, Phone TEXT,
  Active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS Users (
  UserID INTEGER PRIMARY KEY AUTOINCREMENT,
  Name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  PinHash TEXT, PinSalt TEXT,
  Active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS Sessions (
  Token TEXT PRIMARY KEY, UserID INTEGER NOT NULL, CreatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS AuditLog (
  ID INTEGER PRIMARY KEY AUTOINCREMENT,
  At TEXT NOT NULL, UserName TEXT,
  ReceiptID INTEGER, ReceiptNo TEXT,
  Action TEXT NOT NULL,            -- create | edit | void | import | settings
  Field TEXT, OldValue TEXT, NewValue TEXT
);
CREATE TRIGGER IF NOT EXISTS trgAuditNoDelete BEFORE DELETE ON AuditLog
BEGIN SELECT RAISE(ABORT, 'The audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trgAuditNoUpdate BEFORE UPDATE ON AuditLog
BEGIN SELECT RAISE(ABORT, 'The audit log is append-only'); END;

CREATE TABLE IF NOT EXISTS Texts (Key TEXT PRIMARY KEY, KU TEXT NOT NULL, AR TEXT NOT NULL);

-- §2.4: one row per payment line of every non-voided receipt that has a month.
-- EVERY report reads from this view, so all reports always agree.
DROP VIEW IF EXISTS PaymentLines;
CREATE VIEW PaymentLines AS
  SELECT ReceiptID, ReceiptNo, ReceiptDate, CustomerName, ApartmentNo, Currency AS C, 1 AS LineNo, M1 AS M, Y1 AS Y, COALESCE(A1, 0) AS A
    FROM Receipts WHERE Cancelled = 0 AND M1 IS NOT NULL
  UNION ALL
  SELECT ReceiptID, ReceiptNo, ReceiptDate, CustomerName, ApartmentNo, Currency, 2, M2, Y2, COALESCE(A2, 0)
    FROM Receipts WHERE Cancelled = 0 AND M2 IS NOT NULL
  UNION ALL
  SELECT ReceiptID, ReceiptNo, ReceiptDate, CustomerName, ApartmentNo, Currency, 3, M3, Y3, COALESCE(A3, 0)
    FROM Receipts WHERE Cancelled = 0 AND M3 IS NOT NULL;
`;
const CURRENCIES = ['USD', 'IQD'];

function open(file = DB_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  // upgrades for databases created by an older version (must run before the view is rebuilt)
  const cols = db.prepare("SELECT name FROM pragma_table_info('Receipts')").all().map((c) => c.name);
  if (cols.length && !cols.includes('Rev')) db.exec('ALTER TABLE Receipts ADD COLUMN Rev INTEGER NOT NULL DEFAULT 0');
  if (cols.length && !cols.includes('Currency')) {
    db.exec("ALTER TABLE Receipts ADD COLUMN Currency TEXT NOT NULL DEFAULT 'USD' CHECK (Currency IN ('USD','IQD'))");
  }
  db.exec(SCHEMA);
  const scols = db.prepare("SELECT name FROM pragma_table_info('Settings')").all().map((c) => c.name);
  for (const c of ['MirrorDirs', 'MirrorStatus']) if (!scols.includes(c)) db.exec(`ALTER TABLE Settings ADD COLUMN ${c} TEXT`);
  // add any default text keys that are missing (keeps user edits)
  const ins = db.prepare('INSERT OR IGNORE INTO Texts (Key, KU, AR) VALUES (?, ?, ?)');
  for (const [k, [ku, ar]] of Object.entries(DEFAULT_TEXTS)) ins.run(k, ku, ar);
  return db;
}

// run fn inside a write transaction (BEGIN IMMEDIATE takes the write lock up front)
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

module.exports = { open, tx, DB_FILE, DATA_DIR, BACKUP_DIR, DEFAULT_TEXTS, CURRENCIES, DEMO };
