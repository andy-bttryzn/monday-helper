#!/usr/bin/env node
// Minimal monday.com CLI + Node library.
// Designed for scripting: every command emits JSON to stdout.
//
// Auth (in priority order):
//   1. MONDAY_TOKEN  env var (raw token, recommended for CI / containers)
//   2. MONDAY_TOKEN_PATH  env var (path to a file containing the raw token)
//   3. ~/.config/monday-helper/token.txt  (default fallback)
//
// Usage:
//   node index.js whoami
//   node index.js boards
//   node index.js board <boardId>
//   node index.js groups <boardId>
//   node index.js item <itemId>
//   node index.js items <boardId> [--group X] [--limit N] [--cursor X] [--columns id,id,...]
//   node index.js search <query> --boards id,id,...
//   node index.js linked <itemId> <columnId>
//   node index.js updates <itemId>
//
//   node index.js set-column <itemId> <boardId> <columnId> <jsonValue|@file|->
//   node index.js set-columns <itemId> <boardId> <jsonObject|@file|->
//   node index.js move-item <itemId> <groupId>
//   node index.js archive-item <itemId>
//   node index.js create-item <boardId> "<name>" [--group X] [--columns json]
//   node index.js create-update <itemId> "<text>"
//
//   node index.js query <gqlFile>      # raw GraphQL query escape hatch
//   node index.js mutation <gqlFile>   # raw GraphQL mutation escape hatch
//
// Exports:
//   mondayQuery(gql, vars)         -> Promise<data>
//   loadToken()                    -> string
//   checkDuplicateItem(...)        -> { duplicate, existing? }  (opt-in name-fuzzy match)
//   namesMatch / normalizeName / levenshtein  utility helpers

const fs = require('fs');
const path = require('path');
const os = require('os');

const ENDPOINT = 'https://api.monday.com/v2';
const API_VERSION = process.env.MONDAY_API_VERSION || '2024-01';

function loadToken() {
  if (process.env.MONDAY_TOKEN) return process.env.MONDAY_TOKEN.trim();
  const explicitPath = process.env.MONDAY_TOKEN_PATH;
  const defaultPath = path.join(os.homedir(), '.config', 'monday-helper', 'token.txt');
  const tokenPath = explicitPath || defaultPath;
  if (!fs.existsSync(tokenPath)) {
    throw new Error(
      `monday token not found. Set MONDAY_TOKEN env, or put the token at ${tokenPath} ` +
      `(or set MONDAY_TOKEN_PATH).`
    );
  }
  return fs.readFileSync(tokenPath, 'utf8').trim();
}

async function mondayQuery(gql, vars) {
  const token = loadToken();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: token,
      'API-Version': API_VERSION,
    },
    body: JSON.stringify({ query: gql, variables: vars || {} }),
  });
  const txt = await res.text();
  let json;
  try { json = JSON.parse(txt); } catch (e) {
    throw new Error('non-JSON response: ' + txt.slice(0, 500));
  }
  if (json.errors && json.errors.length) {
    const err = new Error('monday GraphQL error: ' + JSON.stringify(json.errors));
    err.errors = json.errors;
    throw err;
  }
  return json.data;
}

// ---------- Helpers ----------

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      flags[a.slice(2)] = args[++i];
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function jsonOut(data) {
  console.log(JSON.stringify(data, null, 2));
}

// ---------- Read commands ----------

async function cmdWhoami() {
  const data = await mondayQuery(`{ me { id name email account { id name } } }`);
  jsonOut(data.me);
}

async function cmdBoards() {
  const data = await mondayQuery(`
    query {
      boards(limit: 200, state: active) {
        id name workspace { id name }
      }
    }
  `);
  jsonOut({ count: (data.boards || []).length, boards: data.boards });
}

async function cmdBoard(boardId) {
  if (!boardId) throw new Error('usage: board <boardId>');
  const data = await mondayQuery(`
    query ($id: [ID!]) {
      boards(ids: $id) {
        id name description state
        workspace { id name }
        columns { id title type settings_str }
        groups { id title color }
        items_count
      }
    }
  `, { id: [String(boardId)] });
  jsonOut((data.boards || [])[0] || null);
}

async function cmdGroups(boardId) {
  if (!boardId) throw new Error('usage: groups <boardId>');
  const data = await mondayQuery(`
    query ($id: [ID!]) {
      boards(ids: $id) { groups { id title color position } }
    }
  `, { id: [String(boardId)] });
  jsonOut((data.boards || [])[0]?.groups || []);
}

async function cmdItem(itemId) {
  if (!itemId) throw new Error('usage: item <itemId>');
  const data = await mondayQuery(`
    query ($id: [ID!]) {
      items(ids: $id) {
        id name state created_at updated_at
        board { id name }
        group { id title }
        column_values {
          id type text value
          ... on BoardRelationValue { linked_item_ids linked_items { id name board { id name } } }
          ... on MirrorValue { display_value }
          ... on StatusValue { label index }
          ... on DropdownValue { values { id label } }
          ... on TagsValue { tags { id name } }
          ... on PeopleValue { persons_and_teams { id kind } }
          ... on DateValue { date time }
          ... on EmailValue { email }
          ... on PhoneValue { phone country_short_name }
          ... on LinkValue { url text }
          ... on TimelineValue { from to }
          ... on NumbersValue { number }
          ... on RatingValue { rating }
          ... on LongTextValue { text }
          ... on FormulaValue { display_value }
        }
      }
    }
  `, { id: [String(itemId)] });
  jsonOut((data.items || [])[0] || null);
}

async function cmdItems(boardId, flagArgs) {
  if (!boardId) throw new Error('usage: items <boardId> [--group X] [--limit N] [--cursor X] [--columns id,id,...]');
  const { flags } = parseFlags(flagArgs);
  const limit = Math.min(parseInt(flags.limit || '50', 10), 500);
  const colSelector = flags.columns
    ? `column_values(ids: ${JSON.stringify(flags.columns.split(','))}) { id type text value }`
    : `column_values { id type text value }`;

  if (flags.cursor) {
    const data = await mondayQuery(`
      query ($cursor: String!, $limit: Int!) {
        next_items_page(cursor: $cursor, limit: $limit) {
          cursor
          items {
            id name state group { id title }
            ${colSelector}
          }
        }
      }
    `, { cursor: flags.cursor, limit });
    jsonOut(data.next_items_page);
    return;
  }

  const data = await mondayQuery(`
    query ($id: [ID!], $limit: Int!) {
      boards(ids: $id) {
        items_page(limit: $limit${flags.group ? `, query_params: { rules: [{ column_id: "group", compare_value: ["${flags.group}"] }] }` : ''}) {
          cursor
          items {
            id name state group { id title }
            ${colSelector}
          }
        }
      }
    }
  `, { id: [String(boardId)], limit });
  jsonOut((data.boards || [])[0]?.items_page || null);
}

async function cmdSearch(query, flagArgs) {
  if (!query) throw new Error('usage: search <query> --boards id,id,...');
  const { flags } = parseFlags(flagArgs);
  if (!flags.boards) {
    throw new Error('search requires --boards id,id,...; no default board list is assumed');
  }
  const targetBoards = flags.boards.split(',').map(s => String(s).trim());
  const out = [];
  for (const bid of targetBoards) {
    try {
      const data = await mondayQuery(`
        query ($bid: [ID!], $val: CompareValue!) {
          boards(ids: $bid) {
            items_page(
              limit: 50,
              query_params: { rules: [{ column_id: "name", compare_value: $val, operator: contains_text }] }
            ) {
              items {
                id name state
                board { id name }
                group { id title }
              }
            }
          }
        }
      `, { bid: [String(bid)], val: [query] });
      const items = data.boards?.[0]?.items_page?.items || [];
      for (const it of items) out.push(it);
    } catch (e) {
      // skip boards that error; other boards still searched
    }
  }
  jsonOut({ query, count: out.length, items: out });
}

async function cmdLinked(itemId, columnId) {
  if (!itemId || !columnId) throw new Error('usage: linked <itemId> <columnId>');
  const data = await mondayQuery(`
    query ($id: [ID!]) {
      items(ids: $id) {
        column_values(ids: ["${columnId}"]) {
          id type text value
          ... on BoardRelationValue {
            linked_item_ids
            linked_items { id name state board { id name } group { id title } }
          }
        }
      }
    }
  `, { id: [String(itemId)] });
  const cv = (data.items || [])[0]?.column_values?.[0] || null;
  jsonOut(cv);
}

async function cmdUpdates(itemId) {
  if (!itemId) throw new Error('usage: updates <itemId>');
  const data = await mondayQuery(`
    query ($id: [ID!]) {
      items(ids: $id) {
        updates(limit: 100) {
          id text_body created_at updated_at
          creator { id name email }
          replies { id text_body created_at creator { id name } }
        }
      }
    }
  `, { id: [String(itemId)] });
  jsonOut((data.items || [])[0]?.updates || []);
}

// ---------- Write commands ----------

// Resolve a valueArg into a parsed JS value.
//   "@<path>"  -> read file and JSON.parse
//   "-"        -> read stdin and JSON.parse
//   "<json>"   -> JSON.parse, fall back to raw string
// File/stdin paths dodge Windows/PowerShell quote-escape hazards on embedded quotes.
function resolveValueArg(valueArg) {
  if (typeof valueArg !== 'string') return valueArg;
  if (valueArg.startsWith('@')) {
    const filePath = valueArg.slice(1);
    if (!fs.existsSync(filePath)) {
      throw new Error(`file not found: ${filePath}`);
    }
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new Error(`invalid JSON in ${filePath}: ${e.message}`);
    }
  }
  if (valueArg === '-') {
    const raw = fs.readFileSync(0, 'utf8').trim();
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new Error(`invalid JSON from stdin: ${e.message}`);
    }
  }
  try { return JSON.parse(valueArg); } catch { return valueArg; }
}

// On column_value error, append a hint listing canonical formats for common
// column types. monday's "invalid value" messages don't say what they want.
function enrichColumnValueError(err, columnId, parsedValue) {
  const msg = err && err.message || '';
  if (!/invalid value|ColumnValueException/i.test(msg)) return err;
  const hints = [];
  hints.push(`column_id="${columnId}", value=${JSON.stringify(parsedValue)}`);
  hints.push('Canonical formats:');
  hints.push('  status:         {"label": "Active"}      (NOT {"index": N}; index silently rejects on some columns)');
  hints.push('  board_relation: {"item_ids": [123, 456]}');
  hints.push('  email:          {"email": "x@y.com", "text": "x@y.com"}');
  hints.push('  phone:          {"phone": "5551234567", "countryShortName": "US"}');
  hints.push('  text/long_text: "plain string" (NOT wrapped in another object)');
  hints.push('  date:           {"date": "2026-05-11", "time": "12:00:00"}');
  hints.push('  numeric:        12.5  (raw number, not {"value": 12.5})');
  hints.push('  dropdown:       {"labels": ["A", "B"]}');
  return new Error(msg + '\n\nHint:\n  ' + hints.join('\n  '));
}

async function cmdSetColumn(itemId, boardId, columnId, valueArg) {
  if (!itemId || !boardId || !columnId || valueArg === undefined) {
    throw new Error(
      'usage: set-column <itemId> <boardId> <columnId> <jsonValue>\n' +
      '       jsonValue may be raw JSON, "@<path>" to read from file, or "-" to read from stdin.\n' +
      '       File/stdin avoid Windows/PowerShell quote-escape hazards.'
    );
  }
  const parsed = resolveValueArg(valueArg);
  const colValues = { [columnId]: parsed };
  try {
    const data = await mondayQuery(`
      mutation ($bid: ID!, $iid: ID!, $vals: JSON!) {
        change_multiple_column_values(board_id: $bid, item_id: $iid, column_values: $vals) {
          id name
        }
      }
    `, { bid: String(boardId), iid: String(itemId), vals: JSON.stringify(colValues) });
    jsonOut(data.change_multiple_column_values);
  } catch (e) {
    throw enrichColumnValueError(e, columnId, parsed);
  }
}

async function cmdSetColumns(itemId, boardId, jsonArg) {
  if (!itemId || !boardId || !jsonArg) {
    throw new Error(
      'usage: set-columns <itemId> <boardId> <jsonObject>\n' +
      '       jsonObject may be raw JSON, "@<path>" to read from file, or "-" to read from stdin.'
    );
  }
  let parsed;
  try { parsed = resolveValueArg(jsonArg); } catch (e) {
    throw new Error('jsonObject not parseable: ' + e.message);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const got = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
    throw new Error(`jsonObject must be an object (got ${got})`);
  }
  try {
    const data = await mondayQuery(`
      mutation ($bid: ID!, $iid: ID!, $vals: JSON!) {
        change_multiple_column_values(board_id: $bid, item_id: $iid, column_values: $vals) {
          id name
        }
      }
    `, { bid: String(boardId), iid: String(itemId), vals: JSON.stringify(parsed) });
    jsonOut(data.change_multiple_column_values);
  } catch (e) {
    const colIds = Object.keys(parsed).join(', ');
    throw enrichColumnValueError(e, colIds, parsed);
  }
}

async function cmdMoveItem(itemId, groupId) {
  if (!itemId || !groupId) throw new Error('usage: move-item <itemId> <groupId>');
  const data = await mondayQuery(`
    mutation ($iid: ID!, $gid: String!) {
      move_item_to_group(item_id: $iid, group_id: $gid) { id name group { id title } }
    }
  `, { iid: String(itemId), gid: groupId });
  jsonOut(data.move_item_to_group);
}

async function cmdArchiveItem(itemId) {
  if (!itemId) throw new Error('usage: archive-item <itemId>');
  const data = await mondayQuery(`
    mutation ($iid: ID!) {
      archive_item(item_id: $iid) { id state }
    }
  `, { iid: String(itemId) });
  jsonOut(data.archive_item);
}

async function cmdCreateItem(boardId, name, flagArgs) {
  if (!boardId || !name) throw new Error('usage: create-item <boardId> "<name>" [--group X] [--columns json]');
  const { flags } = parseFlags(flagArgs);
  const colVals = flags.columns ? flags.columns : '{}';
  try { JSON.parse(colVals); } catch (e) {
    throw new Error('--columns must be a JSON object: ' + e.message);
  }
  const vars = { bid: String(boardId), name, vals: colVals };
  const groupClause = flags.group ? ', group_id: $gid' : '';
  if (flags.group) vars.gid = flags.group;
  const data = await mondayQuery(`
    mutation ($bid: ID!, $name: String!, $vals: JSON!${flags.group ? ', $gid: String!' : ''}) {
      create_item(board_id: $bid, item_name: $name, column_values: $vals${groupClause}) {
        id name group { id title }
      }
    }
  `, vars);
  jsonOut(data.create_item);
}

async function cmdCreateUpdate(itemId, text) {
  if (!itemId || !text) throw new Error('usage: create-update <itemId> "<text>"');
  const data = await mondayQuery(`
    mutation ($iid: ID!, $body: String!) {
      create_update(item_id: $iid, body: $body) { id text_body created_at }
    }
  `, { iid: String(itemId), body: text });
  jsonOut(data.create_update);
}

// ---------- Escape hatches ----------

async function cmdRawQuery(gqlFile) {
  if (!gqlFile) throw new Error('usage: query <gqlFile>');
  const gql = fs.readFileSync(gqlFile, 'utf8');
  const data = await mondayQuery(gql);
  jsonOut(data);
}

async function cmdRawMutation(gqlFile) {
  if (!gqlFile) throw new Error('usage: mutation <gqlFile>');
  const gql = fs.readFileSync(gqlFile, 'utf8');
  const data = await mondayQuery(gql);
  jsonOut(data);
}

// ---------- Opt-in dedup helpers ----------
// Useful for callers who want to avoid creating duplicate items
// (e.g. one task per blocker per vendor). Library-only; no CLI surface.

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m > 300 || n > 300) return 999;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = j;
    for (let i = 1; i <= m; i++) {
      const val = a[i - 1] === b[j - 1] ? dp[i - 1] : 1 + Math.min(dp[i - 1], dp[i], prev);
      dp[i - 1] = prev;
      prev = val;
    }
    dp[m] = prev;
  }
  return dp[m];
}

function normalizeName(n) {
  // Strip a trailing " - suffix" since many shops use that for disambiguation.
  return n.replace(/\s*-\s+.+$/, '').trim().toLowerCase();
}

function namesMatch(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na === nb) return true;
  if (levenshtein(na, nb) <= 3) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  return false;
}

/**
 * Check whether an item with `newName` already exists on `boardId`, optionally
 * scoped to those linked to `linkedItemId` via `relationColumnId`, and
 * optionally excluding items whose status `label` matches one of
 * `inactiveStatusLabels` (e.g. ['Done', 'Abandoned']).
 *
 * Returns { duplicate: false } or { duplicate: true, existing: { id, name } }.
 */
async function checkDuplicateItem({
  boardId, newName,
  relationColumnId = null, linkedItemId = null,
  inactiveStatusLabels = [],
  scanLimit = 200,
}) {
  if (!boardId || !newName) throw new Error('checkDuplicateItem: boardId and newName required');
  const colIds = ['status'];
  if (relationColumnId) colIds.push(relationColumnId);
  const data = await mondayQuery(`
    query {
      boards(ids: ["${boardId}"]) {
        items_page(limit: ${scanLimit}) {
          items {
            id name
            column_values(ids: ${JSON.stringify(colIds)}) {
              id type text value
              ... on StatusValue { label index }
              ... on BoardRelationValue { linked_item_ids }
            }
          }
        }
      }
    }
  `);
  const items = data.boards?.[0]?.items_page?.items || [];
  const inactive = new Set(inactiveStatusLabels.map(s => s.trim().toLowerCase()));
  const linkedIdStr = linkedItemId != null ? String(linkedItemId) : null;
  for (const it of items) {
    const byId = {};
    for (const cv of (it.column_values || [])) byId[cv.id] = cv;
    if (inactive.size) {
      const statusLabel = (byId['status']?.label || '').trim().toLowerCase();
      if (inactive.has(statusLabel)) continue;
    }
    if (relationColumnId && linkedIdStr) {
      const linked = (byId[relationColumnId]?.linked_item_ids || []).map(String);
      if (!linked.includes(linkedIdStr)) continue;
    }
    if (namesMatch(newName, it.name)) {
      return { duplicate: true, existing: { id: it.id, name: it.name } };
    }
  }
  return { duplicate: false };
}

// ---------- Main ----------

async function main() {
  const [, , cmd, ...args] = process.argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.error(
      'Subcommands:\n' +
      '  whoami | boards | board <id> | groups <boardId> | item <id> | items <boardId> [flags] |\n' +
      '  search <query> --boards id,id | linked <itemId> <colId> | updates <itemId> |\n' +
      '  set-column <itemId> <boardId> <colId> <jsonValue> | set-columns <itemId> <boardId> <jsonObject> |\n' +
      '  move-item <itemId> <groupId> | archive-item <itemId> |\n' +
      '  create-item <boardId> "<name>" [--group X] [--columns json] | create-update <itemId> "<text>" |\n' +
      '  query <gqlFile> | mutation <gqlFile>'
    );
    process.exit(1);
  }
  try {
    switch (cmd) {
      case 'whoami':         await cmdWhoami(); break;
      case 'boards':         await cmdBoards(); break;
      case 'board':          await cmdBoard(args[0]); break;
      case 'groups':         await cmdGroups(args[0]); break;
      case 'item':           await cmdItem(args[0]); break;
      case 'items':          await cmdItems(args[0], args.slice(1)); break;
      case 'search':         await cmdSearch(args[0], args.slice(1)); break;
      case 'linked':         await cmdLinked(args[0], args[1]); break;
      case 'updates':        await cmdUpdates(args[0]); break;
      case 'set-column':     await cmdSetColumn(args[0], args[1], args[2], args[3]); break;
      case 'set-columns':    await cmdSetColumns(args[0], args[1], args[2]); break;
      case 'move-item':      await cmdMoveItem(args[0], args[1]); break;
      case 'archive-item':   await cmdArchiveItem(args[0]); break;
      case 'create-item':    await cmdCreateItem(args[0], args[1], args.slice(2)); break;
      case 'create-update':  await cmdCreateUpdate(args[0], args[1]); break;
      case 'query':          await cmdRawQuery(args[0]); break;
      case 'mutation':       await cmdRawMutation(args[0]); break;
      default:
        console.error('Unknown command:', cmd);
        process.exit(1);
    }
  } catch (e) {
    console.error('ERROR:', e.message);
    if (e.errors) console.error(JSON.stringify(e.errors, null, 2));
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  mondayQuery,
  loadToken,
  checkDuplicateItem,
  namesMatch,
  normalizeName,
  levenshtein,
  resolveValueArg,
};
