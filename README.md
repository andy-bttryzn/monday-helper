# monday-helper

![tests](https://github.com/USER/monday-helper/actions/workflows/test.yml/badge.svg)

A minimal, opinionated [monday.com](https://monday.com) CLI + Node library for scripting.

Every command emits JSON to stdout. Errors go to stderr with non-zero exit. Designed to drop into shell pipelines, cron jobs, or any other script that needs monday data without pulling in a full SDK.

## Why this exists

The official monday GraphQL is fine, but writing a fresh fetch + auth dance every script gets old. This wraps:

- Token loading (env or file)
- Common reads (whoami / boards / items / search / linked / updates)
- Common writes (set-column / set-columns / move-item / archive-item / create-item / create-update)
- Raw GraphQL escape hatch (query / mutation from a `.gql` file)
- Optional dedup helper (`checkDuplicateItem`) for callers who want to avoid spawning duplicate items

It's deliberately small. No retries, no rate-limit handling, no schema introspection layer.

## Install

```bash
# Node 18+ required (uses built-in fetch)
npm install
```

## Auth

In priority order:

1. `MONDAY_TOKEN` env var (raw token)
2. `MONDAY_TOKEN_PATH` env var (path to a file containing the token)
3. `~/.config/monday-helper/token.txt`

Get a token from monday → Admin → API.

## CLI

```bash
node index.js whoami
node index.js boards
node index.js board 1234567890
node index.js groups 1234567890
node index.js item 9876543210
node index.js items 1234567890 --group group_id --limit 100 --columns status,date
node index.js search "Acme" --boards 1234567890,2345678901
node index.js linked 9876543210 board_relation_xyz
node index.js updates 9876543210

# Writes
node index.js set-column 9876543210 1234567890 status '{"label":"Done"}'
node index.js set-column 9876543210 1234567890 board_relation_xyz @value.json
echo '{"item_ids":[1,2,3]}' | node index.js set-column 9876543210 1234567890 board_relation_xyz -
node index.js set-columns 9876543210 1234567890 '{"status":{"label":"Done"},"text":"hello"}'
node index.js move-item 9876543210 group_id
node index.js archive-item 9876543210
node index.js create-item 1234567890 "New item name" --group topics --columns '{"status":{"label":"Active"}}'
node index.js create-update 9876543210 "Note text"

# Escape hatches
node index.js query my-query.gql
node index.js mutation my-mutation.gql
```

### Why `@file` and `-` for JSON values

Windows PowerShell, cmd.exe, and bash all have different escape rules for embedded quotes. Passing `'{"label":"Done"}'` works fine on bash, but on PowerShell the inner quotes get eaten and the JSON arrives malformed. `@path/to/file.json` and stdin (`-`) sidestep that entirely.

## Tests

```bash
npm test
# or
node --test tests/
```

22 unit tests on the pure helpers (`levenshtein`, `normalizeName`, `namesMatch`, `resolveValueArg`, exports surface). Zero dependencies; Node 18's built-in `node:test`.

The HTTP-touching commands (`whoami`, `boards`, writes, etc.) aren't unit-tested here; they'd require either real API access or a mock layer. For production deployment, wrap in an integration test that hits a sandbox monday account.

## Library

```js
const { mondayQuery, checkDuplicateItem, namesMatch } = require('monday-helper');

// Raw query
const data = await mondayQuery(`{ me { id name } }`);

// Raw mutation with variables
await mondayQuery(`
  mutation ($id: ID!, $name: String!) {
    update_item(item_id: $id, name: $name) { id }
  }
`, { id: '12345', name: 'Renamed' });

// Dedup before creating a task
const check = await checkDuplicateItem({
  boardId: '1234567890',
  newName: 'Process Q3 returns',
  relationColumnId: 'board_relation_vendor',
  linkedItemId: '9876543210',
  inactiveStatusLabels: ['Done', 'Abandoned'],
});
if (check.duplicate) {
  console.log('Already exists:', check.existing.id);
} else {
  // create_item ...
}
```

`checkDuplicateItem` uses a Levenshtein distance + substring match on item names, scoped to items linked to a specific vendor/parent if you pass `relationColumnId` + `linkedItemId`. Items in `inactiveStatusLabels` (case-insensitive) are skipped.

## What's NOT here

- No retries on rate-limit errors (you'll see the GraphQL error; back off and re-run)
- No schema introspection / column-type validation
- No batching helpers
- No webhook server

## License

MIT. See `LICENSE`.
